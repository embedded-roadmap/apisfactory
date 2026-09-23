/**
 * Oturum 17 (W29): onaylı alternatif parça — kural tabanlı aday, öneri ve kanıt, Ar-Ge + üretim onayı (öneren onaylayamaz),
 * iş emrinde alternatif çıkışı (izlenebilir), tedarik görünümünde öneri, geri alma.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, setupWorld, type World } from "./helpers";
import { closePool } from "../src/db/pool";

let w: World;
let A: string;
let bom: string;
let revA: string;
let woId: string;
const items: Record<string, string> = {};
const mapping = { refdes: "Designator", manufacturer: "Manufacturer", mpn: "MPN", qty: "Quantity", description: "Description", dnp: "DNP" };
const stockMapping = { itemCode: "kod", qty: "miktar", lotNo: "lot", locationCode: "konum", rev: "rev" };

async function lotId(lotNo: string): Promise<string> {
  return expectOk(await call(w.app, "warehouse@a.test", A, "GET", `/api/lots/lookup?code=${lotNo}`))[0].id;
}

beforeAll(async () => {
  clearTokens();
  w = await setupWorld();
  A = w.a.companyId;
  const productId = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/products", { code: "AL-1", name: "Alternatif kartı" })).id;
  const csv = ["Designator;Manufacturer;MPN;Quantity;Description;DNP", "U1;AltSemi;MCU-A;1;MCU;", "C1,C2;AltPassive;CAP-A;2;Kondansatör 10uF 0603;"].join("\n");
  const prev = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/imports/bom/preview", { productId, fileName: "a.csv", content: csv, mapping }));
  bom = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/imports/${prev.jobId}/commit`, {})).bomVersionId;
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/boms/${bom}/publish`));
  for (const l of expectOk(await call(w.app, "rd@a.test", A, "GET", `/api/boms/${bom}`)).lines) items[l.mpn] = l.itemId;
  items["CAP-B"] = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/items", { code: "CMP-ALT-CAP-B", name: "Kondansatör 10uF 0603 X7R", kind: "component", manufacturer: "OtherPassive", mpn: "CAP-B" })).id;
  expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/items", { code: "CMP-RES-1", name: "Direnç 10k 0603", kind: "component", manufacturer: "R", mpn: "RES-1" }));
  revA = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/products/${productId}/revisions`, { rev: "A", bomVersionId: bom })).id;
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/revisions/${revA}/transition`, { action: "submit_handover" }));
  for (const [u, area] of [["rd", "rd"], ["production", "production"], ["quality", "quality"]]) {
    expectOk(await call(w.app, `${u}@a.test`, A, "POST", `/api/revisions/${revA}/handover`, { area, decision: "approve" }));
  }
  const stock = "kod,miktar,lot,konum,rev\nCMP-ALTSEMI-MCU-A,10,MCUA-1,STK,\nCMP-ALTPASSIVE-CAP-A,4,CAPA-1,STK,\nCMP-ALT-CAP-B,500,CAPB-1,STK,";
  const sp = expectOk(await call(w.app, "warehouse@a.test", A, "POST", "/api/imports/stock/preview", { fileName: "s.csv", content: stock, mapping: stockMapping }));
  expectOk(await call(w.app, "warehouse@a.test", A, "POST", `/api/imports/${sp.jobId}/commit`, {}));
  woId = expectOk(await call(w.app, "production@a.test", A, "POST", "/api/work-orders", { productRevisionId: revA, qty: "5" })).id;
  expectOk(await call(w.app, "production@a.test", A, "POST", `/api/work-orders/${woId}/release`));
});

afterAll(async () => {
  await w.app.close();
  await w.owner.end();
  await closePool();
});

let altId: string;

describe("Onaylı alternatif parça (W29)", () => {
  it("kural tabanlı aday (yapay zekâ değil) benzer kalemi bulur, ilgisizi bulmaz", async () => {
    const c = expectOk(await call(w.app, "rd@a.test", A, "GET", `/api/items/${items["CAP-A"]}/alternate-candidates`));
    expect(c.method).toContain("yapay zekâ değildir");
    expect(c.candidates.map((x: any) => x.code)).toEqual(["CMP-ALT-CAP-B"]);
    expect(c.candidates[0]).toMatchObject({ freeStock: 500 });
  });

  it("onaysız alternatif iş emrine çıkılamaz; öneri yetkiyle, öneren onaylayamaz, kanıt eksikse teknik not şart", async () => {
    const early = await call(w.app, "warehouse@a.test", A, "POST", `/api/work-orders/${woId}/issue`, { lotId: await lotId("CAPB-1"), qty: "4" });
    expect(early.body.error.code).toBe("wrong_part");
    const tech = await call(w.app, "technician@a.test", A, "POST", "/api/alternates", { itemId: items["CAP-A"], alternateItemId: items["CAP-B"], reason: "Birincil parça stokta yok" });
    expect(tech.status).toBe(403);
    const a = expectOk(await call(w.app, "purchasing@a.test", A, "POST", "/api/alternates", {
      itemId: items["CAP-A"], alternateItemId: items["CAP-B"], reason: "Birincil parçanın temin süresi 16 hafta", origin: "rule_candidate", pinCompatible: true, footprintSame: true,
    }));
    altId = a.id;
    expect(a).toMatchObject({ status: "proposed", missingApprovals: ["rd", "production"] });
    const dup = await call(w.app, "purchasing@a.test", A, "POST", "/api/alternates", { itemId: items["CAP-A"], alternateItemId: items["CAP-B"], reason: "Tekrar öneri denemesi" });
    expect(dup.body.error.code).toBe("alternate_exists");
    const noEvidence = await call(w.app, "rd@a.test", A, "POST", `/api/alternates/${altId}/decision`, { area: "rd", decision: "approve" });
    expect(noEvidence.body.error.code).toBe("evidence_incomplete");
    const wrongArea = await call(w.app, "rd@a.test", A, "POST", `/api/alternates/${altId}/decision`, { area: "production", decision: "approve", note: "x" });
    expect(wrongArea.status).toBe(403);
    expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/alternates/${altId}/decision`, { area: "rd", decision: "approve", note: "X7R dielektrik, gerilim ve tolerans eşdeğer; datasheet karşılaştırıldı" }));
    const tasks = expectOk(await call(w.app, "production@a.test", A, "GET", "/api/tasks/mine"));
    expect(tasks.some((t: any) => t.kind === "alternate_approval" && t.entityId === altId)).toBe(true);
    const done = expectOk(await call(w.app, "production@a.test", A, "POST", `/api/alternates/${altId}/decision`, { area: "production", decision: "approve", note: "Dizgi programı aynı; besleyici değişikliği yok" }));
    expect(done).toMatchObject({ status: "approved", missingApprovals: [] });
    // Öneren kişi kendi önerisine onay veremez
    const own = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/alternates", { itemId: items["MCU-A"], alternateItemId: items["CAP-B"], reason: "Deneme amaçlı öneri", pinCompatible: true, footprintSame: true, electricalEquivalent: true }));
    const self = await call(w.app, "rd@a.test", A, "POST", `/api/alternates/${own.id}/decision`, { area: "rd", decision: "approve" });
    expect(self.body.error.code).toBe("self_approval");
    const rej = await call(w.app, "production@a.test", A, "POST", `/api/alternates/${own.id}/decision`, { area: "production", decision: "reject" });
    expect(rej.status).toBe(409);
    expect(expectOk(await call(w.app, "production@a.test", A, "POST", `/api/alternates/${own.id}/decision`, { area: "production", decision: "reject", note: "MCU yerine pasif olmaz" })).status).toBe("rejected");
  });

  it("RLS: başka şirket alternatifi göremez", async () => {
    const b = await call(w.app, "all@b.test", w.b.companyId, "GET", `/api/alternates/${altId}`);
    expect(b.status).toBe(404);
    expect(expectOk(await call(w.app, "all@b.test", w.b.companyId, "GET", "/api/alternates"))).toHaveLength(0);
  });

  it("onaylı alternatif birincil kalem yerine çıkılır: ihtiyaçtan düşer, izlenebilir, olay kaydı", async () => {
    expectOk(await call(w.app, "warehouse@a.test", A, "POST", `/api/work-orders/${woId}/issue`, { lotId: await lotId("CAPA-1"), qty: "4" }));
    const r = expectOk(await call(w.app, "warehouse@a.test", A, "POST", `/api/work-orders/${woId}/issue`, { lotId: await lotId("CAPB-1"), qty: "6" }));
    const cap = r.materials.find((m: any) => m.itemId === items["CAP-A"]);
    expect(cap).toMatchObject({ issued: "10", issuedAsAlternate: "6", remaining: "0", complete: true });
    const over = await call(w.app, "warehouse@a.test", A, "POST", `/api/work-orders/${woId}/issue`, { lotId: await lotId("CAPB-1"), qty: "1" });
    expect(over.body.error.code).toBe("over_issue");
    const hist = expectOk(await call(w.app, "production@a.test", A, "GET", `/api/history/work_order/${woId}`));
    expect(hist.map((e: any) => e.eventType)).toContain("material.issued.alternate");
    const a = expectOk(await call(w.app, "rd@a.test", A, "GET", `/api/alternates/${altId}`));
    expect(a.usedIssues).toBe(1);
  });

  it("tedarik görünümü birincil stok yetmeyince onaylı alternatifi önerir", async () => {
    const s = expectOk(await call(w.app, "rd@a.test", A, "GET", `/api/boms/${bom}/sourcing?qty=100`));
    const cap = s.lines.find((l: any) => l.itemId === items["CAP-A"]);
    expect(cap.toBuy).toBe(200);
    expect(cap.alternates[0]).toMatchObject({ code: "CMP-ALT-CAP-B", free: 494 });
    expect(cap.suggestion).toContain("CMP-ALT-CAP-B stoktan karşılar");
  });

  it("geri alınan alternatif yeni çıkışta kullanılamaz; geçmiş çıkış kayıtta kalır", async () => {
    const wo2 = expectOk(await call(w.app, "production@a.test", A, "POST", "/api/work-orders", { productRevisionId: revA, qty: "1" })).id;
    expectOk(await call(w.app, "production@a.test", A, "POST", `/api/work-orders/${wo2}/release`));
    const sales = await call(w.app, "sales@a.test", A, "POST", `/api/alternates/${altId}/revoke`, { reason: "Saha arızası" });
    expect(sales.status).toBe(403);
    const r = expectOk(await call(w.app, "quality@a.test", A, "POST", `/api/alternates/${altId}/revoke`, { reason: "Sahada kapasite sapması raporlandı" }));
    expect(r.status).toBe("revoked");
    const blocked = await call(w.app, "warehouse@a.test", A, "POST", `/api/work-orders/${wo2}/issue`, { lotId: await lotId("CAPB-1"), qty: "2" });
    expect(blocked.body.error.code).toBe("wrong_part");
    const again = expectOk(await call(w.app, "rd@a.test", A, "GET", `/api/alternates/${altId}`));
    expect(again.usedIssues).toBe(1);
    // Geri alınan çiftin yeniden önerilmesi mümkün
    const re = expectOk(await call(w.app, "purchasing@a.test", A, "POST", "/api/alternates", { itemId: items["CAP-A"], alternateItemId: items["CAP-B"], reason: "Üretici yeni lotta sapmayı giderdi" }));
    expect(re.status).toBe("proposed");
  });

  it("Oturum 20 devamı (W29): alternatif kaydına kanıt tartışması ve datasheet eki eklenebilir", async () => {
    const url = `/api/threads/item_alternate/${altId}`;
    const label = expectOk(await call(w.app, "rd@a.test", A, "GET", url)).label;
    expect(label).toBe("CMP-ALTPASSIVE-CAP-A → CMP-ALT-CAP-B");
    const pdf = Buffer.from("%PDF-1.4 test").toString("base64");
    const msg = expectOk(await call(w.app, "rd@a.test", A, "POST", `${url}/messages`, { body: "Datasheet ekte", attachments: [{ fileName: "datasheet.pdf", contentType: "application/pdf", contentBase64: pdf }] }));
    expect(msg.attachments).toBe(1);
    const noAccess = await call(w.app, "sales@a.test", A, "GET", url);
    expect(noAccess.status).toBe(403); // satış bom.view sahibi değil
  });
});
