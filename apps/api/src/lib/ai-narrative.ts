import { z } from "zod";
import { AppError } from "./errors";
import { callStructured } from "./ai-call";

// Ortak yapılandırma ve test enjeksiyonu ai-call.ts'te; mevcut içe aktarmalar için yeniden dışa aktarılır.
export { aiConfig, aiDeps, DEFAULT_AI_MODEL } from "./ai-call";

/**
 * Dış bağımlılık maddesi 3 — yönetici raporu bulgularına AI yorum katmanı (Anthropic Claude).
 * Kural tabanlı hesaplama (lib/report-findings.ts) değişmez; model yalnız serbest metin yorum yazar.
 * Anahtar: ANTHROPIC_API_KEY (platform düzeyi, apps/api/.env veya hosting secret store). Model: AI_MODEL (varsayılan claude-opus-5).
 * Sağlayıcı güvenlik sınıflandırıcısı isteği reddederse `fallbacks: "default"` ile sunucu tarafında önerilen modele yönlendirilir.
 */

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

export async function generateNarratives(findings: NarrativeInput[]): Promise<{ model: string; narratives: Map<string, string> }> {
  const res = await callStructured({
    system: SYSTEM,
    user: `Bulgular (JSON):\n${JSON.stringify(findings, null, 2)}`,
    schema: OUTPUT_SCHEMA as unknown as Record<string, unknown>,
  });
  const text = res.text;
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
