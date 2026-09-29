import Anthropic from "@anthropic-ai/sdk";
import { AppError } from "./errors";

/**
 * Ortak yapılandırılmış (JSON şemalı) Claude çağrısı: yapılandırma, sağlayıcı hata eşlemesi, ret/kesilme denetimi.
 * AI yorum katmanı (ai-narrative) ve alternatif parça araştırması (alternate-research) kullanır.
 * Anahtar: ANTHROPIC_API_KEY (platform düzeyi). Model: AI_MODEL (varsayılan claude-opus-5).
 */

export const DEFAULT_AI_MODEL = "claude-opus-5";

export function aiConfig() {
  return { available: Boolean(process.env.ANTHROPIC_API_KEY), model: process.env.AI_MODEL || DEFAULT_AI_MODEL };
}

export type CreateFn = (params: Anthropic.Beta.MessageCreateParamsNonStreaming) => Promise<Anthropic.Beta.BetaMessage>;

/** Testlerde gerçek API çağrılmasın diye değiştirilebilir. */
export const aiDeps: { create: CreateFn | null } = { create: null };

function defaultCreate(): CreateFn {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return (params) => client.beta.messages.create(params);
}

/** Şemaya uygun JSON metni ve yanıtı gerçekte üreten model döner (sunucu tarafı yedek modele düşmüş olabilir). */
export async function callStructured(opts: { system: string; user: string; schema: Record<string, unknown>; maxTokens?: number }): Promise<{ model: string; text: string }> {
  const cfg = aiConfig();
  if (!cfg.available && !aiDeps.create) throw new AppError(503, "ai_not_configured", "AI sağlayıcısı yapılandırılmadı (ANTHROPIC_API_KEY tanımlı değil)");
  const create = aiDeps.create ?? defaultCreate();
  let res: Anthropic.Beta.BetaMessage;
  try {
    res = await create({
      model: cfg.model,
      max_tokens: opts.maxTokens ?? 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: opts.system,
      output_config: { format: { type: "json_schema", schema: opts.schema } },
      messages: [{ role: "user", content: opts.user }],
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
  return { model: res.model, text: res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("") };
}
