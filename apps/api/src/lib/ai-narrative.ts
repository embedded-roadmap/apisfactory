import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { AppError } from "./errors";

/**
 * Dış bağımlılık maddesi 3 — yönetici raporu bulgularına AI yorum katmanı (Anthropic Claude).
 * Kural tabanlı hesaplama (lib/report-findings.ts) değişmez; model yalnız serbest metin yorum yazar.
 * Anahtar: ANTHROPIC_API_KEY (platform düzeyi, apps/api/.env veya hosting secret store). Model: AI_MODEL (varsayılan claude-opus-5).
 * Sağlayıcı güvenlik sınıflandırıcısı isteği reddederse `fallbacks: "default"` ile sunucu tarafında önerilen modele yönlendirilir.
 */

export const DEFAULT_AI_MODEL = "claude-opus-5";

export function aiConfig() {
  return { available: Boolean(process.env.ANTHROPIC_API_KEY), model: process.env.AI_MODEL || DEFAULT_AI_MODEL };
}

export type NarrativeInput = {
  id: string;
  area: string;
  periodFrom: string;
  periodTo: string;
  finding: string;
  evidence: unknown;
  causeType: string;
  causeText: string | null;
  actionOptions: unknown;
  uncertainty: string | null;
  successMetric: string;
};

const SYSTEM = `Bir elektronik üretim şirketinin yönetici raporu için yorum yazıyorsun. Sana kural tabanlı hesaplanmış bulgular verilecek.
Her bulgu için 2–4 cümlelik Türkçe bir yorum yaz: yöneticinin neye dikkat etmesi gerektiğini, kanıttaki somut sayılara atıf yaparak açıkla.
Kurallar:
- Yalnız verilen kanıta dayan; sayı, tedarikçi, ürün veya olay uydurma. Kanıt yetersizse bunu açıkça söyle.
- Nedenleri kesin olarak DOĞRULANMIŞ gibi sunma; her neden bir varsayımdır ("olası", "varsayım olarak" gibi ifadeler kullan). Doğrulama insan kararıdır.
- Verilen eylem seçeneklerinin dışında yeni bir karar dayatma; seçenekler arasında neyin önce incelenmesi gerektiğini söyleyebilirsin.
- Her bulgunun "id" alanını aynen geri döndür.`;

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    narratives: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, narrative: { type: "string" } },
        required: ["id", "narrative"],
        additionalProperties: false,
      },
    },
  },
  required: ["narratives"],
  additionalProperties: false,
} as const;

const Output = z.object({ narratives: z.array(z.object({ id: z.string(), narrative: z.string().min(1).max(4000) })) });

type CreateFn = (params: Anthropic.Beta.MessageCreateParamsNonStreaming) => Promise<Anthropic.Beta.BetaMessage>;

/** Testlerde gerçek API çağrılmasın diye değiştirilebilir. */
export const aiDeps: { create: CreateFn | null } = { create: null };

function defaultCreate(): CreateFn {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return (params) => client.beta.messages.create(params);
}

/** Bulgular için yorum üretir; id → yorum eşlemesi ve yanıtı gerçekte üreten model döner. */
export async function generateNarratives(findings: NarrativeInput[]): Promise<{ model: string; narratives: Map<string, string> }> {
  const cfg = aiConfig();
  if (!cfg.available && !aiDeps.create) throw new AppError(503, "ai_not_configured", "AI sağlayıcısı yapılandırılmadı (ANTHROPIC_API_KEY tanımlı değil)");
  const create = aiDeps.create ?? defaultCreate();

  let res: Anthropic.Beta.BetaMessage;
  try {
    res = await create({
      model: cfg.model,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      output_config: { format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
      messages: [{ role: "user", content: `Bulgular (JSON):\n${JSON.stringify(findings, null, 2)}` }],
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new AppError(503, "ai_auth_failed", "AI sağlayıcısı anahtarı reddetti (ANTHROPIC_API_KEY geçersiz)");
    if (e instanceof Anthropic.PermissionDeniedError) throw new AppError(503, "ai_permission_denied", "AI sağlayıcısı hesabı bu isteğe izin vermiyor (bakiye/izin kontrol edilmeli)");
    if (e instanceof Anthropic.RateLimitError) throw new AppError(429, "ai_rate_limited", "AI sağlayıcısı istek sınırına ulaşıldı; biraz sonra tekrar deneyin");
    if (e instanceof Anthropic.APIConnectionError) throw new AppError(502, "ai_unreachable", "AI sağlayıcısına ulaşılamadı");
    if (e instanceof Anthropic.APIError) throw new AppError(502, "ai_error", `AI sağlayıcısı hatası (${e.status ?? "?"})`);
    throw e;
  }

  if (res.stop_reason === "refusal") throw new AppError(502, "ai_refused", "AI sağlayıcısı bu isteği yanıtlamayı reddetti");
  if (res.stop_reason === "max_tokens") throw new AppError(502, "ai_truncated", "AI yanıtı yarıda kesildi");
  const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  let parsed: z.infer<typeof Output>;
  try {
    parsed = Output.parse(JSON.parse(text));
  } catch {
    throw new AppError(502, "ai_bad_output", "AI yanıtı beklenen biçimde değil");
  }
  const wanted = new Set(findings.map((f) => f.id));
  const narratives = new Map(parsed.narratives.filter((n) => wanted.has(n.id)).map((n) => [n.id, n.narrative.trim()]));
  return { model: res.model, narratives };
}
