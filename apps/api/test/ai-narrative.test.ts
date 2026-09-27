/**
 * Oturum 41 — dış bağımlılık maddesi 3: yönetici raporu bulgularına AI yorumu (Anthropic Claude).
 * Gerçek API ÇAĞRILMAZ: `aiDeps.create` sahte bir fonksiyonla değiştirilir ve giden istek/gelen yanıt işlenişi sınanır.
 * Gerçek sağlayıcıya karşı doğrulama ANTHROPIC_API_KEY tanımlanınca canlı dev sunucusunda yapılır.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { call, clearTokens, expectOk, setupWorld, type World } from "./helpers";
import { closePool } from "../src/db/pool";
import { aiDeps, DEFAULT_AI_MODEL } from "../src/lib/ai-narrative";

let w: World;
let A: string;
let ids: string[];
const M = "manager@a.test";
const today = new Date().toISOString().slice(0, 10);

function fakeMessage(text: string, extra: Partial<Anthropic.Beta.BetaMessage> = {}): Anthropic.Beta.BetaMessage {
  return { id: "msg_test", type: "message", role: "assistant", model: DEFAULT_AI_MODEL, stop_reason: "end_turn", content: [{ type: "text", text, citations: null }], ...extra } as unknown as Anthropic.Beta.BetaMessage;
}

async function findings() {
  return expectOk(await call(w.app, M, A, "GET", "/api/reports/findings")) as any[];
}

beforeAll(async () => {
  clearTokens();
  w = await setupWorld();
  A = w.a.companyId;
  const g = expectOk(await call(w.app, M, A, "POST", "/api/reports/generate", { periodKind: "weekly", from: today, to: today }));
  ids = g.findings.map((f: any) => f.id);
});

afterEach(() => {
  aiDeps.create = null;
});

afterAll(async () => {
  await w.app.close();
  await w.owner.end();
  await closePool();
});

describe("AI yorum katmanı (madde 3)", () => {
  it("anahtar yoksa dürüstçe 'yapılandırılmadı' döner; hiçbir bulgu değişmez", async () => {
    expect(expectOk(await call(w.app, M, A, "GET", "/api/reports/ai-status"))).toEqual({ available: false, model: DEFAULT_AI_MODEL });
    const r = await call(w.app, M, A, "POST", "/api/reports/findings/narrate", { findingIds: ids.slice(0, 2) });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("ai_not_configured");
    expect((await findings()).every((f) => f.ai_status === "unavailable")).toBe(true);
    const ex = expectOk(await call(w.app, M, A, "GET", `/api/reports/executive?periodKind=weekly&from=${today}&to=${today}`));
    expect(ex).toMatchObject({ aiStatus: "unavailable", aiConfigured: false });
  });

  it("yalnız karar yetkisi olan tetikleyebilir (maliyet doğurur)", async () => {
    expect((await call(w.app, "sales@a.test", A, "POST", "/api/reports/findings/narrate", { findingIds: ids.slice(0, 1) })).status).toBe(403);
  });

  it("istek: model, sunucu tarafı yedek model, JSON şeması ve yalnız kural tabanlı bulgu verisi gider; yorum kaydedilir, sayısal alanlar değişmez", async () => {
    let sent: Anthropic.Beta.MessageCreateParamsNonStreaming | undefined;
    const target = ids.slice(0, 3);
    aiDeps.create = async (params) => {
      sent = params;
      const input = JSON.parse(String(params.messages[0]!.content).replace(/^[^\n]*\n/, "")) as { id: string }[];
      return fakeMessage(JSON.stringify({ narratives: [...input.map((f) => ({ id: f.id, narrative: `Yorum ${f.id.slice(0, 4)} — olası neden varsayımdır.` })), { id: "00000000-0000-0000-0000-000000000000", narrative: "uydurma" }] }), { model: "claude-opus-4-8" });
    };
    const before = (await findings()).filter((f) => target.includes(f.id));
    const r = expectOk(await call(w.app, M, A, "POST", "/api/reports/findings/narrate", { findingIds: target }));
    expect(r.generated.sort()).toEqual([...target].sort());
    expect(r.model).toBe("claude-opus-4-8"); // yanıtı üreten model (yedeğe düşüldüyse o) kaydedilir
    expect(sent).toMatchObject({ model: DEFAULT_AI_MODEL, fallbacks: "default", betas: ["server-side-fallback-2026-07-01"], output_config: { format: { type: "json_schema" } } });
    expect(sent!.system).toMatch(/DOĞRULANMIŞ gibi sunma/);
    const after = (await findings()).filter((f) => target.includes(f.id));
    for (const f of after) {
      const b = before.find((x) => x.id === f.id)!;
      expect(f).toMatchObject({ ai_status: "generated", ai_model: "claude-opus-4-8", cause_type: b.cause_type, finding: b.finding });
      expect(f.evidence).toEqual(b.evidence);
      expect(f.ai_narrative).toMatch(/^Yorum /);
    }
    const hist = expectOk(await call(w.app, M, A, "GET", `/api/history/report_finding/${target[0]}`));
    expect(JSON.stringify(hist)).toContain("ai_narrative.generated");
  });

  it("zaten yorumlanmış bulgu için sağlayıcı hiç çağrılmaz (yorum bir kez üretilir)", async () => {
    let called = false;
    aiDeps.create = async () => { called = true; return fakeMessage("{}"); };
    const r = expectOk(await call(w.app, M, A, "POST", "/api/reports/findings/narrate", { findingIds: ids.slice(0, 1) }));
    expect(called).toBe(false);
    expect(r).toMatchObject({ generated: [], model: null });
  });

  it("ret, kesik ve bozuk yanıt açık hatayla döner; hiçbir şey kaydedilmez", async () => {
    const target = ids.slice(3, 5);
    aiDeps.create = async () => fakeMessage("", { stop_reason: "refusal" } as any);
    expect((await call(w.app, M, A, "POST", "/api/reports/findings/narrate", { findingIds: target })).body.error.code).toBe("ai_refused");
    aiDeps.create = async () => fakeMessage('{"narratives": [', { stop_reason: "max_tokens" } as any);
    expect((await call(w.app, M, A, "POST", "/api/reports/findings/narrate", { findingIds: target })).body.error.code).toBe("ai_truncated");
    aiDeps.create = async () => fakeMessage('{"yanlis": true}');
    expect((await call(w.app, M, A, "POST", "/api/reports/findings/narrate", { findingIds: target })).body.error.code).toBe("ai_bad_output");
    expect((await findings()).filter((f) => target.includes(f.id)).every((f) => f.ai_status === "unavailable")).toBe(true);
  });

  it("şema: model bilgisi olmadan 'generated' işaretlenemez", async () => {
    await w.owner.query("begin");
    try {
      await w.owner.query(`select set_config('app.company_id', $1, true)`, [A]);
      await expect(w.owner.query(`update report_findings set ai_status = 'generated', ai_narrative = 'x' where id = $1`, [ids[5]])).rejects.toThrow(/report_findings_ai_generated_complete/);
    } finally {
      await w.owner.query("rollback");
    }
  });
});
