/**
 * R21: vadesi geçmiş açık bakiye için müşteriye veya muhasebeye tanımlı kuralla hatırlatma (prompt §17).
 * Sıklık limiti, alıcı, şablon, azami hatırlatma (durdurma koşulu) ve "ödenmiş faturaya gitmez" kuralları.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, setupWorld, type World } from "./helpers";
import { closePool } from "../src/db/pool";

let w: World;
let A: string;
let revA: string;
let customerId: string;
const mapping = { refdes: "Designator", manufacturer: "Manufacturer", mpn: "MPN", qty: "Quantity", description: "Description", dnp: "DNP" };
const addDays = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

beforeAll(async () => {
  clearTokens();
  w = await setupWorld();
  A = w.a.companyId;
  const productId = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/products", { code: "CR-1", name: "Hatırlatma kartı" })).id;
  const csv = ["Designator;Manufacturer;MPN;Quantity;Description;DNP", "U1;CrSemi;MCU-CR;1;MCU;"].join("\n");
  const prev = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/imports/bom/preview", { productId, fileName: "cr.csv", content: csv, mapping }));
  const bom = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/imports/${prev.jobId}/commit`, {})).bomVersionId;
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/boms/${bom}/publish`));
  revA = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/products/${productId}/revisions`, { rev: "A", bomVersionId: bom })).id;
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/revisions/${revA}/transition`, { action: "submit_handover" }));
  for (const [u, area] of [["rd", "rd"], ["production", "production"], ["quality", "quality"]]) {
    expectOk(await call(w.app, `${u}@a.test`, A, "POST", `/api/revisions/${revA}/handover`, { area, decision: "approve" }));
  }
  customerId = expectOk(await call(w.app, "sales@a.test", A, "POST", "/api/customers", { code: "C-CR", name: "Hatırlatma Müşterisi" })).id;
});

afterAll(async () => {
  await w.app.close();
  await w.owner.end();
  await closePool();
});

async function firmOrder(qty: string, price: string) {
  const o = expectOk(await call(w.app, "sales@a.test", A, "POST", "/api/sales-orders", { customerId, requestedDate: addDays(30), lines: [{ productRevisionId: revA, qty, unitPrice: price }] }));
  return o.id as string;
}
async function shipped(orderId: string, qty: string) {
  await w.owner.query(`select set_config('app.company_id', $1, false)`, [A]);
  const l = (await w.owner.query(`select id from sales_order_lines where order_id = $1`, [orderId])).rows[0];
  const code = `SV-CR${Math.floor(Math.random() * 1e6)}`;
  const sh = await w.owner.query(`insert into shipments (company_id, code, sales_order_id, status, shipped_at) values ($1, $2, $3, 'shipped', now()) returning id`, [A, code, orderId]);
  await w.owner.query(`insert into shipment_lines (company_id, shipment_id, sales_order_line_id, qty) values ($1, $2, $3, $4)`, [A, sh.rows[0].id, l.id, qty]);
  return sh.rows[0].id as string;
}
/** Kesilmiş, vadesi geçmiş fatura oluşturur (invoiceDate geçmişte; vade 30 gün, dolayısıyla ~10 gün gecikmiş). */
async function overdueInvoice(price: string) {
  const o = await firmOrder("1", price);
  expectOk(await call(w.app, "sales@a.test", A, "POST", `/api/sales-orders/${o}/confirm`));
  const sh = await shipped(o, "1");
  const d = expectOk(await call(w.app, "accounting@a.test", A, "POST", "/api/customer-invoices/from-shipment", { shipmentId: sh, taxRate: 0 }, { "idempotency-key": `ci-${sh}` }));
  const i = expectOk(await call(w.app, "accounting@a.test", A, "POST", `/api/customer-invoices/${d.id}/issue`, { invoiceDate: addDays(-40) }));
  expect(i.overdue).toBe(true);
  return d.id as string;
}
async function backdateLastReminder(invoiceId: string, days: number) {
  await w.owner.query(`select set_config('app.company_id', $1, false)`, [A]);
  await w.owner.query(`update customer_invoices set last_reminder_at = now() - make_interval(days => $2) where id = $1`, [invoiceId, days]);
}

describe("Tahsilat hatırlatma kuralı (R21)", () => {
  it("kural tanımlanmadan tarama hiçbir şey göndermez; varsayılan görünüm 'etkin değil'", async () => {
    const r = expectOk(await call(w.app, "sales@a.test", A, "GET", "/api/receivables/reminder-rule"));
    expect(r).toMatchObject({ enabled: false, recipient: "accounting" });
    const run = await call(w.app, "sales@a.test", A, "POST", "/api/receivables/reminders/run", {});
    expect(run.status).toBe(403); // sales'de receivable.manage yok
    const run2 = expectOk(await call(w.app, "accounting@a.test", A, "POST", "/api/receivables/reminders/run", {}));
    expect(run2.sent).toBe(0);
  });

  it("kuralı muhasebe kaydeder; satış görebilir ama değiştiremez", async () => {
    const denied = await call(w.app, "sales@a.test", A, "POST", "/api/receivables/reminder-rule", {
      enabled: true, minOverdueDays: 1, frequencyDays: 7, recipient: "accounting", template: "{musteri} - {fatura} {gecikme} gün gecikti, {tutar} {para_birimi}, vade {vade}.", maxReminders: 2,
    });
    expect(denied.status).toBe(403);
    const r = expectOk(await call(w.app, "accounting@a.test", A, "POST", "/api/receivables/reminder-rule", {
      enabled: true, minOverdueDays: 1, frequencyDays: 7, recipient: "accounting", template: "{musteri} - {fatura} {gecikme} gün gecikti, {tutar} {para_birimi}, vade {vade}.", maxReminders: 2,
    }));
    expect(r).toMatchObject({ enabled: true, minOverdueDays: 1, frequencyDays: 7, recipient: "accounting", maxReminders: 2 });
  });

  it("vadesi geçmiş faturaya hatırlatma gönderir (muhasebeye iç görev), sıklık limitini uygular, azami sayıda durdurur", async () => {
    const invId = await overdueInvoice("500.00");
    const r1 = expectOk(await call(w.app, "accounting@a.test", A, "POST", "/api/receivables/reminders/run", {}));
    expect(r1.sent).toBe(1);
    const inv1 = expectOk(await call(w.app, "accounting@a.test", A, "GET", `/api/customer-invoices/${invId}`));
    expect(inv1.reminderCount).toBe(1);
    expect(inv1.lastReminderAt).toBeTruthy();
    expect(inv1.remindersPaused).toBe(false);
    await w.owner.query(`select set_config('app.company_id', $1, false)`, [A]);
    const task = await w.owner.query(`select title, assignee_role from tasks where kind = 'ar_reminder' and entity_id = $1`, [invId]);
    expect(task.rows).toHaveLength(1);
    expect(task.rows[0].assignee_role).toBe("accounting");
    const hist = expectOk(await call(w.app, "accounting@a.test", A, "GET", `/api/history/customer_invoice/${invId}`));
    expect(hist.some((e: any) => e.eventType === "reminder.sent")).toBe(true);

    // Sıklık limiti: hemen tekrar taramada aynı fatura tekrar seçilmez.
    const r2 = expectOk(await call(w.app, "accounting@a.test", A, "POST", "/api/receivables/reminders/run", {}));
    expect(r2.sent).toBe(0);

    // Sıklık süresi geçmiş gibi simüle et (gerçek zaman beklemeden) → ikinci hatırlatma, azami sayıya (2) ulaşır ve otomatik durur.
    await backdateLastReminder(invId, 10);
    const r3 = expectOk(await call(w.app, "accounting@a.test", A, "POST", "/api/receivables/reminders/run", {}));
    expect(r3.sent).toBe(1);
    const inv2 = expectOk(await call(w.app, "accounting@a.test", A, "GET", `/api/customer-invoices/${invId}`));
    expect(inv2.reminderCount).toBe(2);
    expect(inv2.remindersPaused).toBe(true);
    expect(inv2.remindersPausedReason).toMatch(/azami/);

    // Durdurulduktan sonra bir daha ki taramada (sıklık süresi geçmiş olsa bile) gönderilmez.
    await backdateLastReminder(invId, 10);
    const r4 = expectOk(await call(w.app, "accounting@a.test", A, "POST", "/api/receivables/reminders/run", {}));
    expect(r4.sent).toBe(0);
  });

  it("ödenmiş faturaya hatırlatma gitmez", async () => {
    const invId = await overdueInvoice("300.00");
    expectOk(await call(w.app, "accounting@a.test", A, "POST", `/api/customer-invoices/${invId}/receipts`, { amount: "300.00", receivedOn: addDays(0), reference: "HAV-CR1" }));
    const inv = expectOk(await call(w.app, "accounting@a.test", A, "GET", `/api/customer-invoices/${invId}`));
    expect(inv.status).toBe("paid");
    const r = expectOk(await call(w.app, "accounting@a.test", A, "POST", "/api/receivables/reminders/run", {}));
    expect(r.sent).toBe(0);
    const inv2 = expectOk(await call(w.app, "accounting@a.test", A, "GET", `/api/customer-invoices/${invId}`));
    expect(inv2.reminderCount).toBe(0);
  });

  it("elle duraklat/devam ettir (ör. uyuşmazlık) hatırlatmayı engeller ve kaldırır", async () => {
    const invId = await overdueInvoice("400.00");
    const pauseDenied = await call(w.app, "sales@a.test", A, "POST", `/api/customer-invoices/${invId}/reminders/pause`, { paused: true, reason: "test" });
    expect(pauseDenied.status).toBe(403);
    expectOk(await call(w.app, "accounting@a.test", A, "POST", `/api/customer-invoices/${invId}/reminders/pause`, { paused: true, reason: "Müşteri tutarı itiraz etti" }));
    const r1 = expectOk(await call(w.app, "accounting@a.test", A, "POST", "/api/receivables/reminders/run", {}));
    expect(r1.sent).toBe(0);
    const inv = expectOk(await call(w.app, "accounting@a.test", A, "GET", `/api/customer-invoices/${invId}`));
    expect(inv.remindersPaused).toBe(true);
    expect(inv.remindersPausedReason).toBe("Müşteri tutarı itiraz etti");

    expectOk(await call(w.app, "accounting@a.test", A, "POST", `/api/customer-invoices/${invId}/reminders/pause`, { paused: false, reason: "İtiraz çözüldü" }));
    const r2 = expectOk(await call(w.app, "accounting@a.test", A, "POST", "/api/receivables/reminders/run", {}));
    expect(r2.sent).toBe(1);
  });

  it("alıcı 'müşteri' ise çıkış kutusuna yazılır; e-posta yoksa açıkça işaretlenir", async () => {
    expectOk(await call(w.app, "accounting@a.test", A, "POST", "/api/receivables/reminder-rule", {
      enabled: true, minOverdueDays: 1, frequencyDays: 7, recipient: "customer", template: "{musteri} - {fatura} {gecikme} gün gecikti.", maxReminders: null,
    }));
    const invNoEmail = await overdueInvoice("120.00");
    expectOk(await call(w.app, "accounting@a.test", A, "POST", "/api/receivables/reminders/run", {}));
    await w.owner.query(`select set_config('app.company_id', $1, false)`, [A]);
    const ob1 = await w.owner.query(`select payload from outbox where topic = 'customer.reminder' and payload->>'invoiceId' = $1`, [invNoEmail]);
    expect(ob1.rows).toHaveLength(1);
    expect(ob1.rows[0].payload.emailMissing).toBe(true);
    expect(ob1.rows[0].payload.mode).toBe("test");

    expectOk(await call(w.app, "accounting@a.test", A, "POST", `/api/customers/${customerId}/billing-email`, { billingEmail: "tahsilat@musteri.test" }));
    const invWithEmail = await overdueInvoice("130.00");
    expectOk(await call(w.app, "accounting@a.test", A, "POST", "/api/receivables/reminders/run", {}));
    const ob2 = await w.owner.query(`select payload from outbox where topic = 'customer.reminder' and payload->>'invoiceId' = $1`, [invWithEmail]);
    expect(ob2.rows[0].payload.email).toBe("tahsilat@musteri.test");
    expect(ob2.rows[0].payload.emailMissing).toBe(false);
    expect(ob2.rows[0].payload.message).toContain("Hatırlatma Müşterisi");
  });
});
