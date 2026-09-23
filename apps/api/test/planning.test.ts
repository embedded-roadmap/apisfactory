/**
 * Oturum 7 (W26): planlı görevler, kontrol listesi, bağımlılık ve döngü engeli, baz plan ve tarih değişikliği etkisi
 * (müşteri taahhüdü sessiz değişmez), Gantt verisi, tarihsel organizasyon şeması, ekip performansı (dış gecikme hariç).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, setupWorld, type World } from "./helpers";
import { closePool } from "../src/db/pool";

let w: World;
let A: string;
const M = "manager@a.test";
const T = "technician@a.test";
const today = new Date().toISOString().slice(0, 10);
const plus = (n: number) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
let users: Record<string, string> = {};
let depts: Record<string, string> = {};
let orderId: string;

beforeAll(async () => {
  clearTokens();
  w = await setupWorld();
  A = w.a.companyId;
  const org = expectOk(await call(w.app, M, A, "GET", "/api/org"));
  users = Object.fromEntries(org.users.map((u: any) => [u.email, u.id]));
  depts = Object.fromEntries(org.departments.map((d: any) => [d.code, d.id]));
  // Taahhüt tarihi olan satış siparişi (etki hesabı için)
  const productId = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/products", { code: "PL-1", name: "Plan kartı" })).id;
  const rev = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/products/${productId}/revisions`, { rev: "A" })).id;
  const cust = expectOk(await call(w.app, "sales@a.test", A, "POST", "/api/customers", { code: "PL", name: "Plan müşterisi" })).id;
  orderId = expectOk(await call(w.app, "sales@a.test", A, "POST", "/api/sales-orders", { customerId: cust, requestedDate: plus(20), lines: [{ productRevisionId: rev, qty: "1" }] })).id;
  await w.owner.query(`select set_config('app.company_id', $1, false)`, [A]);
  await w.owner.query(`update sales_orders set promised_date = $2 where id = $1`, [orderId, plus(15)]);
});

afterAll(async () => {
  await w.app.close();
  await w.owner.end();
  await closePool();
});

let t1: any;
let t2: any;
let t3: any;

describe("Planlı görevler", () => {
  it("yetkili kişi görev açar; teknisyen açamaz; sorumlu zorunlu", async () => {
    expect((await call(w.app, T, A, "POST", "/api/tasks", { title: "Deneme", assigneeRole: "technician" })).status).toBe(403);
    expect((await call(w.app, M, A, "POST", "/api/tasks", { title: "Sorumsuz görev" })).body.error.code).toBe("bad_request");
    t1 = expectOk(await call(w.app, M, A, "POST", "/api/tasks", {
      title: "Pilot üretim hazırlığı", assigneeUserId: users["technician@a.test"], departmentId: depts.URETIM ?? undefined, priority: "high",
      startDate: plus(1), dueDate: plus(5), checklist: ["Fikstür kontrolü", "Programlama dosyası"], entityType: "sales_order", entityId: orderId,
    }));
    expect(t1).toMatchObject({ status: "open", priority: "high", assigneeName: "A technician" });
    expect(t1.checklist).toHaveLength(2);
    t2 = expectOk(await call(w.app, M, A, "POST", "/api/tasks", { title: "Pilot test raporu", assigneeUserId: users["quality@a.test"], startDate: plus(6), dueDate: plus(8), dependsOn: [{ taskId: t1.id }] }));
    t3 = expectOk(await call(w.app, M, A, "POST", "/api/tasks", { title: "Devir toplantısı", assigneeRole: "rd", startDate: plus(9), dueDate: plus(9), milestone: true, dependsOn: [{ taskId: t2.id }] }));
    expect(t3.milestone).toBe(true);
    const mine = expectOk(await call(w.app, T, A, "GET", "/api/tasks/mine"));
    expect(mine.map((x: any) => x.id)).toContain(t1.id);
    expect(mine.map((x: any) => x.id)).not.toContain(t2.id);
    expect(mine.find((x: any) => x.id === t1.id)).toMatchObject({ checklistTotal: 2, checklistDone: 0 });
  });

  it("döngüsel bağımlılık reddedilir", async () => {
    const cyc = await call(w.app, M, A, "POST", `/api/tasks/${t1.id}/dependencies`, { dependsOn: t3.id });
    expect(cyc.body.error.code).toBe("dependency_cycle");
    expect((await call(w.app, M, A, "POST", `/api/tasks/${t1.id}/dependencies`, { dependsOn: t1.id })).body.error.code).toBe("dependency_cycle");
  });

  it("tarih kaydırma: ardıl çakışması ve müşteri taahhüdü etkisi hesaplanır, taahhüt değişmez", async () => {
    expectOk(await call(w.app, M, A, "POST", "/api/tasks/baseline", { note: "Pilot planı onaylandı" }));
    const noReason = await call(w.app, M, A, "POST", `/api/tasks/${t1.id}/update`, { dueDate: plus(18) });
    expect(noReason.body.error.code).toBe("reason_required");
    expect((await call(w.app, T, A, "POST", `/api/tasks/${t1.id}/update`, { dueDate: plus(18), reason: "x" })).status).toBe(403);
    const r = expectOk(await call(w.app, M, A, "POST", `/api/tasks/${t1.id}/update`, { dueDate: plus(18), reason: "Fikstür tedarikçiden geç geliyor" }));
    expect(r.impact.successors).toEqual([expect.objectContaining({ id: t2.id, requiredStart: plus(19), daysLate: 13 })]);
    expect(r.impact.commitments).toEqual([expect.objectContaining({ code: expect.stringMatching(/^SS-/), promisedDate: plus(15), daysLate: 3 })]);
    const so = (await w.owner.query(`select promised_date::text as p from sales_orders where id = $1`, [orderId])).rows[0];
    expect(so.p).toBe(plus(15)); // taahhüt sessizce değişmedi
    expect(r.baselineDue).toBe(plus(5));
    const g = expectOk(await call(w.app, M, A, "GET", `/api/gantt?from=${today}&to=${plus(30)}`));
    expect(g.tasks.find((x: any) => x.id === t1.id).slipDays).toBe(13);
    expect(g.conflicts).toEqual([expect.objectContaining({ taskId: t2.id, dependsOn: t1.id, daysLate: 13 })]);
    expect(g.dependencies).toHaveLength(2);
  });

  it("kapanış: kontrol listesi ve öncül tamamlanmadan kapanmaz; sorumlu ilerletebilir", async () => {
    expect((await call(w.app, "sales@a.test", A, "POST", `/api/tasks/${t1.id}/status`, { status: "in_progress" })).status).toBe(403);
    expectOk(await call(w.app, T, A, "POST", `/api/tasks/${t1.id}/status`, { status: "in_progress" }));
    expect((await call(w.app, T, A, "POST", `/api/tasks/${t1.id}/status`, { status: "done" })).body.error.code).toBe("checklist_incomplete");
    expect((await call(w.app, T, A, "POST", `/api/tasks/${t1.id}/status`, { status: "blocked" })).body.error.code).toBe("reason_required");
    const b = expectOk(await call(w.app, T, A, "POST", `/api/tasks/${t1.id}/status`, { status: "blocked", blockedCategory: "supplier", reason: "Fikstür tedarikçide" }));
    expect(b.externalDelay).toBe(true);
    expectOk(await call(w.app, T, A, "POST", `/api/tasks/${t1.id}/status`, { status: "in_progress" }));
    for (const i of [0, 1]) expectOk(await call(w.app, T, A, "POST", `/api/tasks/${t1.id}/checklist`, { index: i, done: true }));
    expect((await call(w.app, "quality@a.test", A, "POST", `/api/tasks/${t2.id}/status`, { status: "done" })).body.error.code).toBe("dependency_open");
    // Geç kapanış (bitiş tarihi geçmiş gibi): tedarikçi kaynaklı → kişiye yazılmaz
    await w.owner.query(`update tasks set start_date = $2, due_date = $3 where id = $1`, [t1.id, plus(-5), plus(-1)]);
    const done = expectOk(await call(w.app, T, A, "POST", `/api/tasks/${t1.id}/status`, { status: "done" }));
    expect(done.status).toBe("done");
    expectOk(await call(w.app, "quality@a.test", A, "POST", `/api/tasks/${t2.id}/status`, { status: "done" }));
    // Sistem görevi elle kapatılamaz
    const sys = (await w.owner.query(`insert into tasks (company_id, title, assignee_role, entity_type, entity_id, kind) values ($1, 'Sistem', 'technician', 'x', gen_random_uuid(), 'material_issue') returning id`, [A])).rows[0].id;
    expect((await call(w.app, T, A, "POST", `/api/tasks/${sys}/status`, { status: "done" })).body.error.code).toBe("system_task");
  });

  it("ekip performansı: dış kaynaklı gecikme ayrı; oran iç gecikmeye göre; puan üretilmez", async () => {
    // İç kaynaklı geç kapanan bir görev daha (kalite sorumlusu)
    const t4 = expectOk(await call(w.app, M, A, "POST", "/api/tasks", { title: "Ölçüm raporu", assigneeUserId: users["quality@a.test"], dueDate: plus(2) }));
    await w.owner.query(`update tasks set due_date = $2 where id = $1`, [t4.id, plus(-2)]);
    expectOk(await call(w.app, "quality@a.test", A, "POST", `/api/tasks/${t4.id}/status`, { status: "done" }));
    expect((await call(w.app, T, A, "GET", `/api/reports/team?from=${plus(-7)}&to=${today}`)).status).toBe(403);
    const r = expectOk(await call(w.app, M, A, "GET", `/api/reports/team?from=${plus(-7)}&to=${today}&period=week`));
    const tech = r.rows.find((x: any) => x.userId === users["technician@a.test"]);
    expect(tech).toMatchObject({ tasksClosed: 1, onTime: 0, lateInternal: 0, lateExternal: 1, onTimeRate: null });
    const q = r.rows.find((x: any) => x.userId === users["quality@a.test"]);
    expect(q).toMatchObject({ tasksClosed: 2, onTime: 1, lateInternal: 1, onTimeRate: 0.5 });
    expect(r.notes.join(" ")).toContain("puan");
    expect(Object.keys(tech)).not.toContain("score");
    expect(r.buckets.reduce((a: number, b: any) => a + b.closed, 0)).toBe(3);
  });
});

describe("Organizasyon şeması", () => {
  it("tarihsel üyelik ve geçici görevlendirme; döngü engeli; şema yetki vermez", async () => {
    const parent = expectOk(await call(w.app, M, A, "POST", "/api/departments", { code: "OPS", name: "Operasyon" }));
    const child = expectOk(await call(w.app, M, A, "POST", "/api/departments", { code: "HAT1", name: "Hat 1", parentId: parent.id }));
    expect((await call(w.app, M, A, "POST", `/api/departments/${parent.id}/update`, { parentId: child.id })).body.error.code).toBe("org_cycle");
    expect((await call(w.app, T, A, "POST", "/api/departments", { code: "XX", name: "Deneme" })).status).toBe(403);
    const m1 = expectOk(await call(w.app, M, A, "POST", `/api/departments/${child.id}/members`, { userId: users["technician@a.test"], validFrom: plus(-30) }));
    expectOk(await call(w.app, M, A, "POST", `/api/departments/${parent.id}/members`, { userId: users["production@a.test"], isManager: true, validFrom: plus(-30) }));
    expect((await call(w.app, M, A, "POST", `/api/departments/${child.id}/members`, { userId: users["quality@a.test"], temporary: true })).body.error.code).toBe("valid_to_required");
    expectOk(await call(w.app, M, A, "POST", `/api/departments/${child.id}/members`, { userId: users["quality@a.test"], temporary: true, validFrom: today, validTo: plus(10), note: "Pilot desteği" }));
    expect((await call(w.app, M, A, "POST", `/api/departments/${child.id}/members`, { userId: users["technician@a.test"] })).body.error.code).toBe("duplicate");
    expectOk(await call(w.app, M, A, "POST", `/api/department-members/${m1.id}/end`, { validTo: plus(-1), reason: "Hat 2'ye geçti" }));
    const now = expectOk(await call(w.app, T, A, "GET", "/api/org"));
    const hat = now.departments.find((d: any) => d.code === "HAT1");
    expect(hat.members.map((m: any) => m.name)).toEqual(["A quality"]);
    expect(hat.members[0].temporary).toBe(true);
    const past = expectOk(await call(w.app, T, A, "GET", `/api/org?date=${plus(-10)}`));
    expect(past.departments.find((d: any) => d.code === "HAT1").members.map((m: any) => m.name)).toEqual(["A technician"]);
    expect(now.departments.find((d: any) => d.code === "OPS").members[0]).toMatchObject({ name: "A production", isManager: true });
    // Yönetici olmak veri yetkisi vermez: üretim sorumlusu hâlâ maliyet göremez
    expect((await call(w.app, "production@a.test", A, "GET", "/api/cost-policies")).status).toBe(403);
    expect(now.note).toContain("yetki");
  });
});
