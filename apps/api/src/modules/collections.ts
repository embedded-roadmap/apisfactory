import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/pool";
import { notFound } from "../lib/errors";
import { enqueue, openTask, recordEvent, type Actor } from "../lib/records";
import { parse, tenant } from "../http/context";

/**
 * R21 — Vadesi geçmiş açık bakiye için müşteriye veya muhasebeye tanımlı kuralla hatırlatma (prompt §17).
 *  - Şirket başına tek kural: sıklık limiti, alıcı, şablon, azami hatırlatma sayısı (durdurma koşulu).
 *  - Gönderimden hemen önce güncel açık bakiye yeniden doğrulanır (aynı sorguda, satır kilidiyle);
 *    ödenmiş/iptal/taslak faturaya asla bildirim gitmez (yalnızca status='issued' seçilir).
 *  - Gerçek e-posta gönderimi yok: alıcı "müşteri" ise mevcut outbox test bağlayıcısına yazılır
 *    (mode: 'test', e-posta yoksa açıkça 'emailMissing' işaretlenir — sessizce başarılı gösterilmez);
 *    alıcı "muhasebe" ise iç görev açılır (mevcut po_followup/credit_note görev deseniyle aynı).
 *  - Otomatik tarama outbox işleyicisinde (worker/outbox.ts) her şirket için periyodik çalışır;
 *    ayrıca muhasebe "şimdi çalıştır" ile elle de tetikleyebilir.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;

function renderTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k]! : m));
}

async function loadRule(db: Db, companyId: string) {
  const r = await db.query(
    `select r.id, r.enabled, r.min_overdue_days as "minOverdueDays", r.frequency_days as "frequencyDays", r.recipient, r.template,
            r.max_reminders as "maxReminders", r.updated_at as "updatedAt", u.name as "updatedBy"
       from collection_reminder_rules r left join users u on u.id = r.updated_by where r.company_id = $1`,
    [companyId],
  );
  return (
    r.rows[0] ?? {
      id: null, enabled: false, minOverdueDays: 1, frequencyDays: 7, recipient: "accounting",
      template: "{musteri} - {fatura} numaralı fatura vadesi {gecikme} gündür geçti. Açık bakiye: {tutar} {para_birimi}. Vade tarihi: {vade}.",
      maxReminders: null, updatedAt: null, updatedBy: null,
    }
  );
}

/** Tarama: kuralı sağlayan faturalara hatırlatma gönderir (yollanmadan hemen önce açık bakiyeyi yeniden doğrular). Dönüş: gönderilen sayısı. */
export async function runCollectionReminders(db: Db, actor: Actor) {
  const rule = (await db.query(
    `select min_overdue_days as "minOverdueDays", frequency_days as "frequencyDays", recipient, template, max_reminders as "maxReminders"
       from collection_reminder_rules where company_id = $1 and enabled`,
    [actor.companyId],
  )).rows[0];
  if (!rule) return 0;

  const due = await db.query(
    `select ci.id, ci.code, ci.due_date::text as "dueDate", ci.gross_amount::float8 as gross, ci.currency, ci.reminder_count as "reminderCount",
            c.id as "customerId", c.name as "customerName", c.billing_email as "billingEmail",
            coalesce((select sum(r.amount) from customer_receipts r where r.invoice_id = ci.id), 0)::float8 as received,
            (current_date - ci.due_date)::int as "overdueDays"
       from customer_invoices ci join customers c on c.id = ci.customer_id
      where ci.status = 'issued' and ci.due_date < current_date - make_interval(days => $1)
        and not ci.reminders_paused
        and (ci.last_reminder_at is null or ci.last_reminder_at < now() - make_interval(days => $2))
      order by ci.due_date
      for update of ci skip locked`,
    [rule.minOverdueDays, rule.frequencyDays],
  );

  let sent = 0;
  for (const inv of due.rows) {
    // Gönderimden hemen önce yeniden doğrula: bu satır kilitliyken tahsilat girilmiş olabilir.
    const open = round2(inv.gross - inv.received);
    if (open <= 0.005) continue;

    const msg = renderTemplate(rule.template, {
      musteri: inv.customerName, fatura: inv.code, gecikme: String(inv.overdueDays),
      tutar: open.toFixed(2), para_birimi: inv.currency, vade: inv.dueDate,
    });
    if (rule.recipient === "customer" || rule.recipient === "both") {
      await enqueue(db, actor.companyId, "customer.reminder", {
        invoiceId: inv.id, invoiceCode: inv.code, customerId: inv.customerId, email: inv.billingEmail,
        message: msg, mode: "test", emailMissing: !inv.billingEmail,
      });
    }
    if (rule.recipient === "accounting" || rule.recipient === "both") {
      await openTask(db, actor.companyId, {
        kind: "ar_reminder",
        title: `Vadesi geçti: ${inv.code} (${inv.overdueDays} gün, ${open.toFixed(2)} ${inv.currency}) — ${inv.customerName}`,
        entityType: "customer_invoice", entityId: inv.id, assigneeRole: "accounting",
      });
    }
    const newCount = (inv.reminderCount as number) + 1;
    const pause = rule.maxReminders != null && newCount >= rule.maxReminders;
    await db.query(
      `update customer_invoices set last_reminder_at = now(), reminder_count = $2,
              reminders_paused = $3, reminders_paused_reason = case when $3 then $4 else reminders_paused_reason end
        where id = $1`,
      [inv.id, newCount, pause, `otomatik: azami hatırlatma sayısına ulaşıldı (${newCount})`],
    );
    await recordEvent(db, { ...actor, kind: "automation" }, {
      entityType: "customer_invoice", entityId: inv.id, eventType: "reminder.sent",
      after: { recipient: rule.recipient, overdueDays: inv.overdueDays, open, count: newCount, paused: pause, emailMissing: !inv.billingEmail && rule.recipient !== "accounting" },
    });
    sent++;
  }
  return sent;
}

export async function collectionsRoutes(app: FastifyInstance) {
  app.get("/api/receivables/reminder-rule", async (req) =>
    tenant(req, "receivable.view", (db, actor) => loadRule(db, actor.companyId)),
  );

  app.post("/api/receivables/reminder-rule", async (req) => {
    const input = parse(
      z.object({
        enabled: z.boolean(),
        minOverdueDays: z.number().int().min(0).max(365),
        frequencyDays: z.number().int().min(1).max(90),
        recipient: z.enum(["customer", "accounting", "both"]),
        template: z.string().min(10).max(2000),
        maxReminders: z.number().int().min(1).max(50).nullable(),
      }),
      req.body,
    );
    return tenant(req, "receivable.manage", async (db, actor) => {
      const before = await loadRule(db, actor.companyId);
      await db.query(
        `insert into collection_reminder_rules (company_id, enabled, min_overdue_days, frequency_days, recipient, template, max_reminders, updated_by, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,now())
         on conflict (company_id) do update set enabled = $2, min_overdue_days = $3, frequency_days = $4, recipient = $5, template = $6, max_reminders = $7, updated_by = $8, updated_at = now()`,
        [actor.companyId, input.enabled, input.minOverdueDays, input.frequencyDays, input.recipient, input.template, input.maxReminders, actor.userId],
      );
      const after = await loadRule(db, actor.companyId);
      await recordEvent(db, actor, { entityType: "company", entityId: actor.companyId, eventType: "collection_rule.updated", before, after });
      return after;
    });
  });

  /** Elle "şimdi çalıştır" — kuralın hâlâ etkin olması gerekir; test/erken doğrulama için kullanışlı. */
  app.post("/api/receivables/reminders/run", async (req) =>
    tenant(req, "receivable.manage", async (db, actor) => ({ sent: await runCollectionReminders(db, actor) })),
  );

  /** Bir faturanın hatırlatmalarını elle duraklat/devam ettir (ör. müşteri itiraz etti — durdurma koşulu). */
  app.post("/api/customer-invoices/:id/reminders/pause", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ paused: z.boolean(), reason: z.string().min(3).max(500) }), req.body);
    return tenant(req, "receivable.manage", async (db, actor) => {
      const inv = (await db.query(`select code, reminders_paused from customer_invoices where id = $1 for update`, [id])).rows[0];
      if (!inv) throw notFound("Müşteri faturası");
      await db.query(`update customer_invoices set reminders_paused = $2, reminders_paused_reason = $3 where id = $1`, [id, input.paused, input.paused ? input.reason : null]);
      await recordEvent(db, actor, {
        entityType: "customer_invoice", entityId: id,
        eventType: input.paused ? "reminder.paused" : "reminder.resumed",
        before: { paused: inv.reminders_paused }, after: { paused: input.paused }, reason: input.reason,
      });
      return { id, paused: input.paused };
    });
  });

  /** Bir müşterinin hatırlatma e-postası (gerçek gönderim yok — outbox test bağlayıcısına gider). */
  app.post("/api/customers/:id/billing-email", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ billingEmail: z.string().email().nullable() }), req.body);
    return tenant(req, "receivable.manage", async (db, actor) => {
      const c = (await db.query(`select name, billing_email from customers where id = $1 for update`, [id])).rows[0];
      if (!c) throw notFound("Müşteri");
      await db.query(`update customers set billing_email = $2 where id = $1`, [id, input.billingEmail]);
      await recordEvent(db, actor, { entityType: "customer", entityId: id, eventType: "billing_email.updated", before: { billingEmail: c.billing_email }, after: { billingEmail: input.billingEmail } });
      return { id, billingEmail: input.billingEmail };
    });
  });
}
