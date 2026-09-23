/**
 * Oturum 8 (W10): onay politikası (kendi talebini onaylama, rol limiti, limit üstü yükseltme), vekâlet (süreli, kapsamlı,
 * vekâleten yapılan işlemin kaydı), zaman aşımı ve üst sorumluya yükseltme, elle aktarma, çıkış kutusu uzlaştırma.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, setupWorld, type World } from "./helpers";
import { closePool } from "../src/db/pool";

let w: World;
let A: string;
let costedItem: string;
let uncostedItem: string;
let users: Record<string, string> = {};
const M = "manager@a.test";
const P = "purchasing@a.test";
const R = "rd@a.test";
const Q = "quality@a.test";
const inDays = (n: number) => new Date(Date.now() + n * 864e5).toISOString();

async function pr(as: string, itemId: string, qty: string) {
  return expectOk(await call(w.app, as, A, "POST", "/api/purchase-requests", { itemId, qty, note: "Pilot üretim için" }));
}
const decide = (as: string, id: string, decision = "approve", note?: string) => call(w.app, as, A, "POST", `/api/purchase-requests/${id}/decision`, { decision, note });
async function ownerQuery(sql: string, params: unknown[] = []) {
  await w.owner.query(`select set_config('app.company_id', $1, false)`, [A]);
  return w.owner.query(sql, params);
}

beforeAll(async () => {
  clearTokens();
  w = await setupWorld();
  A = w.a.companyId;
  users = Object.fromEntries(expectOk(await call(w.app, M, A, "GET", "/api/org")).users.map((u: any) => [u.email, u.id]));
  const productId = expectOk(await call(w.app, R, A, "POST", "/api/products", { code: "WF-1", name: "Akış kartı" })).id;
  const prev = expectOk(await call(w.app, R, A, "POST", "/api/imports/bom/preview", { productId, fileName: "wf.csv", content: "Designator;Manufacturer;MPN;Quantity;Description;DNP\nU1;TestSemi;MCU-W;1;MCU;\nU2;TestSemi;LDO-W;1;LDO;", mapping: { refdes: "Designator", manufacturer: "Manufacturer", mpn: "MPN", qty: "Quantity", description: "Description", dnp: "DNP" } }));
  expectOk(await call(w.app, R, A, "POST", `/api/imports/${prev.jobId}/commit`, {}));
  const sp = expectOk(await call(w.app, "warehouse@a.test", A, "POST", "/api/imports/stock/preview", { fileName: "w.csv", content: "kod,miktar,lot,konum\nCMP-TESTSEMI-MCU-W,5,MW-1,STK", mapping: { itemCode: "kod", qty: "miktar", lotNo: "lot", locationCode: "konum" } }));
  expectOk(await call(w.app, "warehouse@a.test", A, "POST", `/api/imports/${sp.jobId}/commit`, {}));
  const lot = expectOk(await call(w.app, "warehouse@a.test", A, "GET", "/api/lots/lookup?code=MW-1"))[0];
  costedItem = lot.itemId;
  expectOk(await call(w.app, P, A, "POST", `/api/lots/${lot.id}/cost`, { unitCost: "10", currency: "TRY", source: "invoice", reference: "FTR-W1" }));
  uncostedItem = (await ownerQuery(`select id from items where code = 'CMP-TESTSEMI-LDO-W'`)).rows[0].id; // stoğu ve maliyeti yok
});

afterAll(async () => {
  await w.app.close();
  await w.owner.end();
  await closePool();
});

describe("Onay politikası", () => {
  it("politika sürümlü; teknik yönetici politika yazamaz ve onaycı olamaz", async () => {
    expect((await call(w.app, "admin@a.test", A, "POST", "/api/workflow/policies", { kind: "purchase_request", note: "x".repeat(5) })).status).toBe(403);
    const adminLimit = await call(w.app, M, A, "POST", "/api/workflow/policies", { kind: "purchase_request", note: "Deneme", limits: [{ roleCode: "admin", maxAmount: null, currency: "TRY" }] });
    expect(adminLimit.body.error.code).toBe("admin_not_allowed");
    expect((await call(w.app, M, A, "POST", "/api/workflow/policies", { kind: "purchase_request", note: "Süre var rol yok", timeoutHours: 24 })).body.error.code).toBe("escalation_role_required");
    const p = expectOk(await call(w.app, M, A, "POST", "/api/workflow/policies", {
      kind: "purchase_request", note: "2026 satın alma onay kuralı", timeoutHours: 24, escalateToRole: "manager",
      limits: [{ roleCode: "purchasing", maxAmount: "1000", currency: "TRY" }, { roleCode: "manager", maxAmount: null, currency: "TRY" }],
    }));
    expect(p).toMatchObject({ versionNo: 1, timeoutHours: 24, allowSelfApproval: false });
    expect(p.limits).toHaveLength(2);
  });

  it("kendi talebini onaylama engeli; limit içinde onay", async () => {
    const own = await pr(P, costedItem, "50");
    expect(own).toMatchObject({ estimatedAmount: "500.00", currency: "TRY" });
    expect((await decide(P, own.id)).body.error.code).toBe("self_approval");
    const r = await pr(R, costedItem, "50");
    const ok = expectOk(await decide(P, r.id));
    expect(ok.status).toBe("approved");
    // Ret her zaman gerekçeyle mümkündür
    expectOk(await decide(M, own.id, "reject", "Mükerrer talep"));
  });

  it("limit üstü onay reddedilir, üst yetkili role görev açılır; yönetici onaylayınca görev kapanır", async () => {
    const big = await pr(R, costedItem, "200");
    const blocked = await decide(P, big.id);
    expect(blocked.body.error).toMatchObject({ code: "over_limit", details: { escalateToRoles: ["manager"], approverLimit: "1000.00" } });
    const esc = await ownerQuery(`select status, assignee_role from tasks where kind = 'approval_escalation' and entity_id = $1`, [big.id]);
    expect(esc.rows).toEqual([{ status: "open", assignee_role: "manager" }]);
    const ev = await ownerQuery(`select event_type from events where entity_id = $1 and event_type like 'approval.blocked%'`, [big.id]);
    expect(ev.rowCount).toBe(1);
    expectOk(await decide(M, big.id));
    expect((await ownerQuery(`select status from tasks where kind = 'approval_escalation' and entity_id = $1`, [big.id])).rows[0].status).toBe("done");
  });

  it("tutarı bilinmeyen talebi limitli onaycı onaylayamaz; kuru çalıştırma hiçbir şey yazmaz", async () => {
    const unk = await pr(R, uncostedItem, "10");
    expect(unk.estimatedAmount).toBeNull();
    expect((await decide(P, unk.id)).body.error.code).toBe("amount_unknown");
    expectOk(await decide(M, unk.id));
    const dry = expectOk(await call(w.app, M, A, "POST", "/api/workflow/policies/dry-run", { kind: "purchase_request", approverUserId: users[P], amount: "1500", currency: "TRY" }));
    expect(dry).toMatchObject({ allowed: false, code: "over_limit", written: false, escalateToRoles: ["manager"] });
    const dry2 = expectOk(await call(w.app, M, A, "POST", "/api/workflow/policies/dry-run", { kind: "purchase_request", approverUserId: users[P], requesterUserId: users[P], amount: "10", currency: "TRY" }));
    expect(dry2.code).toBe("self_approval");
  });
});

describe("Vekâlet", () => {
  let del: string;
  it("yalnızca sahip olunan onay izinleri, süreli ve kapsamlı devredilir", async () => {
    expect((await call(w.app, Q, A, "POST", "/api/delegations", { delegateUserId: users[R], permissions: ["purchase.request.approve"], validTo: inDays(5), reason: "İzin" })).body.error.code).toBe("permission_not_held");
    expect((await call(w.app, "admin@a.test", A, "POST", "/api/delegations", { delegateUserId: users[Q], permissions: ["admin.users"], validTo: inDays(5), reason: "İzin" })).body.error.code).toBe("not_delegable");
    expect((await call(w.app, P, A, "POST", "/api/delegations", { delegateUserId: users[Q], permissions: ["purchase.request.approve"], validTo: inDays(120), reason: "Uzun izin" })).body.error.code).toBe("too_long");
    expect((await call(w.app, M, A, "POST", "/api/delegations", { delegatorUserId: users[P], delegateUserId: users[M], permissions: ["purchase.request.approve"], validTo: inDays(5), reason: "x".repeat(4) })).body.error.code).toBe("self_grant");
    expect((await call(w.app, R, A, "POST", "/api/delegations", { delegatorUserId: users[P], delegateUserId: users[Q], permissions: ["purchase.request.approve"], validTo: inDays(5), reason: "Yetkisiz" })).status).toBe(403);
    del = expectOk(await call(w.app, P, A, "POST", "/api/delegations", { delegateUserId: users[Q], permissions: ["purchase.request.approve"], validTo: inDays(7), reason: "Yıllık izin" })).id;
  });

  it("vekil vekâlet verenin limitiyle onaylar; kayıt kimin adına yapıldığını taşır", async () => {
    const r1 = await pr(R, costedItem, "30");
    const ok = expectOk(await decide(Q, r1.id));
    expect(ok.onBehalfOf).toBe(users[P]);
    const ev = await ownerQuery(`select actor_user_id, on_behalf_of from events where entity_id = $1 and event_type = 'status.approved'`, [r1.id]);
    expect(ev.rows[0]).toEqual({ actor_user_id: users[Q], on_behalf_of: users[P] });
    const big = await pr(R, costedItem, "150");
    expect((await decide(Q, big.id)).body.error.code).toBe("over_limit");
    // Vekâlet verenin kendi talebi de "kendi talebi" sayılır
    const pOwn = await pr(P, costedItem, "5");
    expect((await decide(Q, pOwn.id)).body.error.code).toBe("self_approval");
    const delegated = expectOk(await call(w.app, Q, A, "GET", "/api/tasks/delegated"));
    expect(delegated.some((t: any) => t.entityId === pOwn.id && t.onBehalfOfName === "A purchasing")).toBe(true);
  });

  it("iptal edilen vekâlet yetkiyi hemen kaldırır", async () => {
    expectOk(await call(w.app, P, A, "POST", `/api/delegations/${del}/revoke`, { reason: "İzinden erken döndü" }));
    const r2 = await pr(R, costedItem, "10");
    expect((await decide(Q, r2.id)).status).toBe(403);
    const list = expectOk(await call(w.app, Q, A, "GET", "/api/delegations"));
    expect(list.rows.find((d: any) => d.id === del)).toMatchObject({ active: false });
  });
});

describe("Zaman aşımı, yükseltme ve elle müdahale", () => {
  it("süresi geçen onay görevi bir kez yükseltilir; iş kapanınca yükseltme de kapanır", async () => {
    const r = await pr(R, costedItem, "20");
    const t = (await ownerQuery(`select id, due_at from tasks where kind = 'purchase_request_review' and entity_id = $1`, [r.id])).rows[0];
    expect(t.due_at).not.toBeNull(); // politika: 24 saat
    await ownerQuery(`update tasks set due_at = now() - interval '1 hour' where id = $1`, [t.id]);
    expect((await call(w.app, P, A, "POST", "/api/workflow/escalations/run")).status).toBe(403);
    expect(expectOk(await call(w.app, M, A, "POST", "/api/workflow/escalations/run")).escalated).toBeGreaterThanOrEqual(1);
    expect(expectOk(await call(w.app, M, A, "POST", "/api/workflow/escalations/run")).escalated).toBe(0);
    const esc = await ownerQuery(`select status, assignee_role from tasks where kind = 'escalation' and entity_id = $1`, [t.id]);
    expect(esc.rows).toEqual([{ status: "open", assignee_role: "manager" }]);
    const ov = expectOk(await call(w.app, M, A, "GET", "/api/workflow/overview"));
    expect(ov.overdue.map((x: any) => x.id)).toContain(t.id);
    const outbox = await ownerQuery(`select 1 from outbox where topic = 'notification.escalation' and payload->>'taskId' = $1`, [t.id]);
    expect(outbox.rowCount).toBe(1);
    expectOk(await decide(P, r.id));
    expect((await ownerQuery(`select status from tasks where kind = 'escalation' and entity_id = $1`, [t.id])).rows[0].status).toBe("done");
  });

  it("elle aktarma: izni olmayan role aktarılmaz; gerekçeli ve kayıtlı", async () => {
    const r = await pr(R, costedItem, "15");
    const t = (await ownerQuery(`select id from tasks where kind = 'purchase_request_review' and entity_id = $1`, [r.id])).rows[0].id;
    expect((await call(w.app, M, A, "POST", `/api/tasks/${t}/reassign`, { assigneeRole: "technician", reason: "Deneme" })).body.error.code).toBe("role_lacks_permission");
    expectOk(await call(w.app, M, A, "POST", `/api/tasks/${t}/reassign`, { assigneeRole: "manager", reason: "Satın alma ekibi izinde" }));
    const mine = expectOk(await call(w.app, M, A, "GET", "/api/tasks/mine"));
    expect(mine.map((x: any) => x.id)).toContain(t);
  });

  it("değişiklik talebinde kendi kararı politikayla açılabilir (varsayılan kapalı)", async () => {
    const productId = (await ownerQuery(`select id from products where code = 'WF-1'`)).rows[0].id;
    const rev = expectOk(await call(w.app, R, A, "POST", `/api/products/${productId}/revisions`, { rev: "A" })).id;
    const cr = expectOk(await call(w.app, R, A, "POST", "/api/change-requests", { productRevisionId: rev, title: "Kendi talebim", description: "Ar-Ge kendi talebine karar denemesi." }));
    expect((await call(w.app, R, A, "POST", `/api/change-requests/${cr.id}/decide`, { decision: "reject", note: "Gerek yok" })).body.error.code).toBe("self_approval");
    expectOk(await call(w.app, M, A, "POST", "/api/workflow/policies", { kind: "change_request", allowSelfApproval: true, note: "Küçük ekip: Ar-Ge kendi talebine karar verebilir" }));
    expectOk(await call(w.app, R, A, "POST", `/api/change-requests/${cr.id}/decide`, { decision: "reject", note: "Gerek yok" }));
  });

  it("çıkış kutusu: sonucu bilinmeyen iş körlemesine tekrar denenmez; önce uzlaştırılır", async () => {
    const f = (await ownerQuery(`insert into outbox (company_id, topic, payload, status, attempts, last_error) values ($1, 'test.failed', '{}', 'failed', 5, 'zaman aşımı') returning id`, [A])).rows[0].id;
    const u = (await ownerQuery(`insert into outbox (company_id, topic, payload, status, attempts) values ($1, 'test.unknown', '{}', 'unknown', 1) returning id`, [A])).rows[0].id;
    expect((await call(w.app, M, A, "POST", `/api/workflow/outbox/${u}/retry`, { reason: "tekrar" })).body.error.code).toBe("reconcile_first");
    expectOk(await call(w.app, M, A, "POST", `/api/workflow/outbox/${u}/resolve`, { outcome: "done", note: "Karşı sistemde kayıt görüldü" }));
    expect(expectOk(await call(w.app, M, A, "POST", `/api/workflow/outbox/${f}/retry`, { reason: "Bağlantı düzeldi" })).status).toBe("pending");
    const list = expectOk(await call(w.app, M, A, "GET", "/api/workflow/outbox"));
    expect(list.find((x: any) => x.id === String(u))).toMatchObject({ status: "done", resolutionNote: "Karşı sistemde kayıt görüldü" });
  });
});
