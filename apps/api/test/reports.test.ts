/**
 * Oturum 38 (W30/W31, kullanıcının 2026-09-26 devam talimatı §6/§7): yönetici raporları ve
 * öneri → görev → ölçüm → kapatma yaşam döngüsü.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, setupWorld, type World } from "./helpers";
import { createUser } from "../src/db/seed";
import { closePool } from "../src/db/pool";

let w: World;
let A: string;
let rev: string;
const M = "manager@a.test";
const M2 = "manager2@a.test";
const T = "technician@a.test";
const today = new Date().toISOString().slice(0, 10);
const lotId = async (lotNo: string) => expectOk(await call(w.app, "warehouse@a.test", A, "GET", `/api/lots/lookup?code=${lotNo}`))[0].id as string;
const mapping = { refdes: "Designator", manufacturer: "Manufacturer", mpn: "MPN", qty: "Quantity", description: "Description", dnp: "DNP" };

beforeAll(async () => {
  clearTokens();
  w = await setupWorld();
  A = w.a.companyId;
  await createUser(w.owner, { email: M2, name: "A manager2", password: "test-password-1", companyId: A, roles: ["manager"], roleIds: w.a.roleIds });

  const productId = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/products", { code: "RP-1", name: "Rapor kartı" })).id;
  const prev = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/imports/bom/preview", { productId, fileName: "rp.csv", content: "Designator;Manufacturer;MPN;Quantity;Description;DNP\nU1;TestSemi;MCU-C;1;MCU;\nC1,C2;TestPassive;CAP-C;2;Kondansatör;", mapping }));
  const bom = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/imports/${prev.jobId}/commit`, {})).bomVersionId;
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/boms/${bom}/publish`));
  rev = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/products/${productId}/revisions`, { rev: "A", bomVersionId: bom })).id;
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/revisions/${rev}/transition`, { action: "submit_handover" }));
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/revisions/${rev}/handover`, { area: "rd", decision: "approve" }));
  expectOk(await call(w.app, "production@a.test", A, "POST", `/api/revisions/${rev}/handover`, { area: "production", decision: "approve" }));
  expectOk(await call(w.app, "quality@a.test", A, "POST", `/api/revisions/${rev}/handover`, { area: "quality", decision: "approve" }));

  const csv = "kod,miktar,lot,konum,rev\nCMP-TESTSEMI-MCU-C,20,MCU-C1,STK,\nCMP-TESTPASSIVE-CAP-C,200,CAP-C1,STK,";
  const stockMapping = { itemCode: "kod", qty: "miktar", lotNo: "lot", locationCode: "konum", rev: "rev" };
  const p = expectOk(await call(w.app, "warehouse@a.test", A, "POST", "/api/imports/stock/preview", { fileName: "c.csv", content: csv, mapping: stockMapping }));
  expectOk(await call(w.app, "warehouse@a.test", A, "POST", `/api/imports/${p.jobId}/commit`, {}));

  // 5 cihaz: 4 sağlam, 1 hurda — fire_rework alanı için asgari örneklem (5).
  const wo = expectOk(await call(w.app, "production@a.test", A, "POST", "/api/work-orders", { productRevisionId: rev, qty: "5" }));
  const rel = expectOk(await call(w.app, "production@a.test", A, "POST", `/api/work-orders/${wo.id}/release`));
  expectOk(await call(w.app, "warehouse@a.test", A, "POST", `/api/work-orders/${wo.id}/issue`, { lotId: await lotId("MCU-C1"), qty: "5" }));
  expectOk(await call(w.app, "warehouse@a.test", A, "POST", `/api/work-orders/${wo.id}/issue`, { lotId: await lotId("CAP-C1"), qty: "10" }));
  for (const op of rel.operations) {
    expectOk(await call(w.app, T, A, "POST", `/api/work-orders/${wo.id}/operations/${op.id}/start`));
    if (op.isQualityGate) {
      for (const [i, d] of rel.devices.entries()) {
        expectOk(await call(w.app, T, A, "POST", `/api/devices/${d.serial}/test`, { result: i < 4 ? "pass" : "fail" }));
        if (i >= 4) expectOk(await call(w.app, "quality@a.test", A, "POST", `/api/devices/${d.serial}/disposition`, { decision: "scrap", note: "Test hatası" }));
      }
      expectOk(await call(w.app, T, A, "POST", `/api/work-orders/${wo.id}/operations/${op.id}/complete`));
      expectOk(await call(w.app, "quality@a.test", A, "POST", `/api/work-orders/${wo.id}/release-to-stock`));
    } else expectOk(await call(w.app, T, A, "POST", `/api/work-orders/${wo.id}/operations/${op.id}/complete`));
  }
  expectOk(await call(w.app, "production@a.test", A, "POST", `/api/work-orders/${wo.id}/complete`));
});

afterAll(async () => {
  await w.app.close();
  await w.owner.end();
  await closePool();
});

describe("W30: canlı yönetici raporu", () => {
  it("report.view izni gerekir; izinsiz kullanıcı 403 alır", async () => {
    expect((await call(w.app, T, A, "GET", `/api/reports/executive?periodKind=weekly&from=${today}&to=${today}`)).status).toBe(403);
  });

  it("8 alanı da döner; AI servisi yapılandırılmadığı açıkça belirtilir", async () => {
    const r = expectOk(await call(w.app, M, A, "GET", `/api/reports/executive?periodKind=weekly&from=${today}&to=${today}`));
    expect(r.aiStatus).toBe("unavailable");
    expect(Object.keys(r.areas).sort()).toEqual(
      ["capacity_leadtime", "collections", "cost_margin", "fire_rework", "project_budget", "revision_impact", "stock_shortage", "supplier_performance"].sort(),
    );
    // Fire/yeniden işleme: yeterli örneklem (5 cihaz) var — bir hipotez üretilir, "confirmed" asla değil.
    expect(r.areas.fire_rework.causeType).toBe("hypothesis");
    expect(r.areas.fire_rework.finding).toContain("hurda oranı");
    // Proje bütçesi: hiçbir bütçe modülü yok — her zaman dürüstçe "yeterli veri yok".
    expect(r.areas.project_budget.causeType).toBe("insufficient_data");
    expect(r.areas.project_budget.finding).toBe("Öneri üretmek için yeterli veri yok.");
  });
});

describe("W31: öneri → görev → ölçüm → kapatma yaşam döngüsü", () => {
  let fireReworkFindingId: string;
  let projectBudgetFindingId: string;
  let suggestionId: string;

  it("generate: bulgular kalıcı kaydedilir; onay gerekenler için inceleme görevi açılır", async () => {
    const g = expectOk(await call(w.app, M, A, "POST", "/api/reports/generate", { periodKind: "weekly", from: today, to: today }));
    expect(g.findings).toHaveLength(8);
    const fr = g.findings.find((f: any) => f.area === "fire_rework");
    expect(fr.causeType).toBe("hypothesis");
    expect(fr.requiresApproval).toBe(true);
    fireReworkFindingId = fr.id;
    const pb = g.findings.find((f: any) => f.area === "project_budget");
    expect(pb.requiresApproval).toBe(false);
    projectBudgetFindingId = pb.id;

    const tasks = expectOk(await call(w.app, M, A, "GET", "/api/tasks"));
    const reviewTask = tasks.find((t: any) => t.entityId === fireReworkFindingId && t.kind === "report_finding_review");
    expect(reviewTask).toBeTruthy();
    expect(reviewTask.assigneeRole).toBe("quality");
  });

  it("veri yetersiz bulgu (project_budget) karar gerektirmez", async () => {
    const r = await call(w.app, M, A, "POST", `/api/reports/findings/${projectBudgetFindingId}/decision`, { decision: "approve", reason: "test gerekçe" });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("no_decision_needed");
  });

  it("karar için report.suggestion.decide izni gerekir", async () => {
    const r = await call(w.app, "quality@a.test", A, "POST", `/api/reports/findings/${fireReworkFindingId}/decision`, { decision: "approve", reason: "test gerekçe" });
    expect(r.status).toBe(403);
  });

  it("onay: baseline/target/interval zorunlu; eksikse 400", async () => {
    const r = await call(w.app, M, A, "POST", `/api/reports/findings/${fireReworkFindingId}/decision`, { decision: "approve", reason: "Süreç incelemesi başlatılıyor" });
    expect(r.status).toBe(400);
  });

  it("onay: ai_suggestions kaydı ve uygulama görevi açılır; inceleme görevi kapanır", async () => {
    const d = expectOk(await call(w.app, M, A, "POST", `/api/reports/findings/${fireReworkFindingId}/decision`, {
      decision: "approve", reason: "Süreç incelemesi başlatılıyor", baselineMetric: "scrap_rate", baselineValue: 0.2, targetValue: 0.1, measurementIntervalDays: 30,
    }));
    expect(d.decision).toBe("approve");
    suggestionId = d.suggestionId;
    const s = expectOk(await call(w.app, M, A, "GET", `/api/reports/suggestions/${suggestionId}`));
    expect(s.status).toBe("approved");
    expect(s.task_id).toBeTruthy();

    const tasks = expectOk(await call(w.app, M, A, "GET", "/api/tasks"));
    expect(tasks.find((t: any) => t.entityId === fireReworkFindingId && t.kind === "report_finding_review" && t.status === "open")).toBeFalsy();
    expect(tasks.find((t: any) => t.entityId === suggestionId && t.kind === "ai_suggestion_implementation")).toBeTruthy();
  });

  it("aynı bulgudan ikinci kez öneri/görev açılmaz", async () => {
    const r = await call(w.app, M, A, "POST", `/api/reports/findings/${fireReworkFindingId}/decision`, {
      decision: "approve", reason: "tekrar", baselineMetric: "scrap_rate", baselineValue: 0.2, targetValue: 0.1, measurementIntervalDays: 30,
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("already_decided");
  });

  it("ölçüm kaydedilmeden doğrulanamaz", async () => {
    const r = await call(w.app, M, A, "POST", `/api/reports/suggestions/${suggestionId}/verify`, {});
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("not_measured");
  });

  it("gözlenen değeri ölçen kişi kendi ölçümünü doğrulayamaz (bağımsız doğrulama)", async () => {
    expectOk(await call(w.app, M, A, "POST", `/api/reports/suggestions/${suggestionId}/measure`, { measuredValue: 0.12 }));
    const r = await call(w.app, M, A, "POST", `/api/reports/suggestions/${suggestionId}/verify`, {});
    expect(r.status).toBe(403);
  });

  it("farklı kişi doğrular; beklenen fark ile gözlenen fark ayrı raporlanır", async () => {
    const v = expectOk(await call(w.app, M2, A, "POST", `/api/reports/suggestions/${suggestionId}/verify`, { note: "gözden geçirildi" }));
    expect(v.expectedDiff).toBeCloseTo(-0.1, 6); // target(0.1) - baseline(0.2)
    expect(v.observedDiff).toBeCloseTo(-0.08, 6); // measured(0.12) - baseline(0.2)
    const s = expectOk(await call(w.app, M, A, "GET", `/api/reports/suggestions/${suggestionId}`));
    expect(s.status).toBe("closed");
    expect(s.verified_by).toBeTruthy();
  });

  it("kapatılmış öneri yeniden ölçülemez; yeniden açma sonrası mümkün olur", async () => {
    expect((await call(w.app, M, A, "POST", `/api/reports/suggestions/${suggestionId}/measure`, { measuredValue: 0.11 })).status).toBe(409);
    const reopened = expectOk(await call(w.app, M, A, "POST", `/api/reports/suggestions/${suggestionId}/reopen`, { reason: "ek dönem verisi geldi" }));
    expect(reopened.reopenedCount).toBe(1);
    const s = expectOk(await call(w.app, M, A, "GET", `/api/reports/suggestions/${suggestionId}`));
    expect(s.status).toBe("approved");
    expect(s.closed_at).toBeNull();
  });

  it("red: gerekçe kaydedilir, öneri açılmaz", async () => {
    const g = expectOk(await call(w.app, M, A, "POST", "/api/reports/generate", { periodKind: "weekly", from: today, to: today }));
    const fr2 = g.findings.find((f: any) => f.area === "fire_rework");
    const r = expectOk(await call(w.app, M, A, "POST", `/api/reports/findings/${fr2.id}/decision`, { decision: "reject", reason: "Tek seferlik anomali, süreç değişikliği gerekmiyor" }));
    expect(r.decision).toBe("reject");
    const s = expectOk(await call(w.app, M, A, "GET", `/api/reports/suggestions/${r.suggestionId}`));
    expect(s.status).toBe("rejected");
    expect(s.task_id).toBeNull();
  });
});
