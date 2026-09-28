import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { config } from "../config";
import { withTenant, withUser, type Db } from "../db/pool";
import { AppError, conflict, notFound } from "../lib/errors";
import { recordEvent, type Actor } from "../lib/records";
import { cancelSubscription, getSubscription, initializeCheckout, iyzicoConfig, IyzicoError, retrieveCheckout, type ProviderSubscription } from "../lib/iyzico";
import { parse, tenant } from "../http/context";
import { transitionSubscription } from "./subscription";

/**
 * Dış bağımlılık maddesi 6 — abonelik ücreti tahsilatı (iyzico Abonelik). Kullanıcı kararları: aylık + yıllık USD/EUR,
 * ödeme alınamazsa / deneme biterse otomatik 'gecikmiş' + 14 gün ek süre → 'kısıtlı', resmi faturayı muhasebe elle keser.
 *
 *  - Ödeme: şirket yöneticisi paketi ve dönemi seçer, iyzico ödeme formu (kart bilgisi iyzico'da girilir) açılır;
 *    iyzico geri çağrısı aboneliği şirkete bağlar ve durumu 'aktif' yapar.
 *  - Mutabakat: iyzico bildirimi (webhook) içeriğine GÜVENİLMEZ — yalnız tetikleyicidir; gerçek durum her seferinde
 *    iyzico API'sinden (abonelik detayı + siparişler) okunur. Ayrıca işçi günlük mutabakat yapar.
 *  - Tahsilatlar sipariş referansıyla tekil kaydedilir (aynı tahsilat iki kez işlenmez); başarılı olanlar "faturası
 *    kesilecek" listesine düşer, muhasebe fatura numarasıyla işaretler.
 * Kısıtlama etkisi değişmedi: 'kısıtlı' yalnız yeni satış siparişi ve RFQ ödülünü engeller; üretim/sevkiyat sürer.
 */

const SYSTEM_USER = "00000000-0000-0000-0000-000000000000";
const graceDays = () => Number(process.env.SUBSCRIPTION_GRACE_DAYS || 14);
const publicApiBase = () => process.env.PUBLIC_API_BASE || process.env.OAUTH_REDIRECT_BASE || `http://localhost:${config.port}`;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (days: number, from = new Date()) => isoDay(new Date(from.getTime() + days * 864e5));
const automation = (companyId: string): Actor => ({ companyId, userId: null, kind: "automation" });

function mapIyzico(e: unknown): never {
  if (e instanceof IyzicoError) throw new AppError(e.status === 503 ? 503 : 502, e.status === 503 ? "billing_not_configured" : "billing_provider_error", e.message);
  throw e;
}

export async function cancelProviderSubscription(ref: string) {
  await cancelSubscription(ref).catch(mapIyzico);
}

/**
 * Sağlayıcı durumunu şirkete uygular (tahsilat kayıtları + durum). Idempotent: aynı sipariş tekrar işlenmez,
 * durum yalnız gerçekten değişiyorsa geçer.
 */
async function applyProviderState(db: Db, companyId: string, sub: ProviderSubscription) {
  const actor = automation(companyId);
  let recorded = 0;
  for (const o of sub.orders ?? []) {
    if (o.orderStatus !== "SUCCESS" && o.orderStatus !== "FAILED") continue;
    const ok = o.orderStatus === "SUCCESS";
    const r = await db.query(
      `insert into subscription_payments (company_id, provider_order_ref, status, amount, currency, period_start, period_end, invoice_status)
       values (app_company_id(), $1, $2, $3, $4, to_timestamp($5 / 1000.0)::date, to_timestamp($6 / 1000.0)::date, $7)
       on conflict (provider_order_ref) do nothing returning id`,
      [o.referenceCode, ok ? "success" : "failed", o.price ?? null, o.currencyCode ?? null, o.startPeriod ?? null, o.endPeriod ?? null, ok ? "to_invoice" : "not_applicable"],
    );
    if (!r.rowCount) continue;
    recorded++;
    await db.query(
      `insert into subscription_events (company_id, event_type, amount, currency, reference, note) values ($1, $2, $3, $4, $5, $6)`,
      [companyId, ok ? "payment_recorded" : "payment_failed", o.price ?? null, o.currencyCode ?? null, o.referenceCode, ok ? "iyzico tahsilatı" : "iyzico tahsilatı başarısız"],
    );
    await recordEvent(db, actor, { entityType: "company", entityId: companyId, eventType: ok ? "subscription.payment_succeeded" : "subscription.payment_failed", after: { order: o.referenceCode, amount: o.price, currency: o.currencyCode } });
  }

  const cur = (await db.query(`select subscription_status from companies where id = $1 for update`, [companyId])).rows[0]?.subscription_status as string | undefined;
  const settled = (sub.orders ?? []).filter((o) => o.orderStatus === "SUCCESS" || o.orderStatus === "FAILED");
  const last = settled.sort((a, b) => (a.startPeriod ?? 0) - (b.startPeriod ?? 0)).at(-1);
  const providerDown = ["UNPAID", "CANCELED", "EXPIRED"].includes(sub.subscriptionStatus ?? "");
  let transition: string | null = null;
  if (cur && cur !== "cancelled") {
    if (!providerDown && last?.orderStatus === "SUCCESS" && cur !== "active") {
      await transitionSubscription(db, actor, "active", "iyzico tahsilatı başarılı");
      transition = "active";
    } else if ((providerDown || last?.orderStatus === "FAILED") && (cur === "active" || cur === "trial")) {
      const why = providerDown ? `iyzico aboneliği ${sub.subscriptionStatus}` : "iyzico tahsilatı başarısız";
      await transitionSubscription(db, actor, "delinquent", `${why}; ${graceDays()} gün ek süre`, { graceUntil: addDays(graceDays()) });
      transition = "delinquent";
    }
  }
  await db.query(`update companies set provider_synced_at = now() where id = $1`, [companyId]);
  return { recorded, transition };
}

/** Şirketin iyzico aboneliğini sağlayıcıdan okuyup uygular. Dış çağrı veri tabanı işleminin dışında. */
export async function reconcileBilling(companyId: string) {
  const ref = await withTenant({ companyId, userId: SYSTEM_USER }, async (db) => (await db.query(`select provider_subscription_ref from companies where id = $1`, [companyId])).rows[0]?.provider_subscription_ref as string | null);
  if (!ref) return { recorded: 0, transition: null, skipped: "no_provider_subscription" as const };
  const sub = await getSubscription(ref);
  return withTenant({ companyId, userId: SYSTEM_USER }, (db) => applyProviderState(db, companyId, sub));
}

/**
 * İşçi (dakikalık, şirket bağlamında): deneme bitişi ve ek süre bitişi geçişleri (yalnız DB). Günlük mutabakat
 * gerekiyorsa true döner (çağıran, işlemi kapattıktan sonra reconcileBilling çağırır).
 */
export async function runSubscriptionLifecycle(db: Db, companyId: string): Promise<{ transitions: string[]; needsSync: boolean }> {
  const c = (await db.query(`select subscription_status as s, trial_ends_at::text as t, grace_until::text as g, provider_subscription_ref as ref, provider_synced_at as synced from companies where id = $1`, [companyId])).rows[0];
  if (!c) return { transitions: [], needsSync: false };
  const today = isoDay(new Date());
  const actor = automation(companyId);
  const transitions: string[] = [];
  if (c.s === "trial" && c.t && c.t < today && !c.ref) {
    const g = addDays(graceDays(), new Date(`${c.t}T00:00:00Z`));
    await transitionSubscription(db, actor, "delinquent", `Deneme süresi ${c.t} tarihinde bitti, ödeme yöntemi eklenmedi; ek süre ${g} tarihine kadar`, { graceUntil: g });
    transitions.push("delinquent");
    c.s = "delinquent";
    c.g = g;
  }
  if (c.s === "delinquent" && c.g && c.g < today) {
    await transitionSubscription(db, actor, "restricted", `${graceDays()} günlük ek süre ${c.g} tarihinde doldu; yeni sipariş ve satın alma ödülü kısıtlandı`);
    transitions.push("restricted");
  }
  const stale = c.ref && (!c.synced || new Date(c.synced).getTime() < Date.now() - 864e5);
  return { transitions, needsSync: Boolean(stale) };
}

const Customer = z.object({
  name: z.string().trim().min(1).max(100),
  surname: z.string().trim().min(1).max(100),
  email: z.string().email(),
  gsmNumber: z.string().trim().regex(/^\+?[0-9 ]{10,20}$/, "Telefon uluslararası biçimde olmalı (ör. +905551112233)"),
  identityNumber: z.string().trim().regex(/^[0-9]{10,11}$/, "Kimlik/vergi numarası 10–11 hane olmalı"),
  address: z.string().trim().min(3).max(300),
  city: z.string().trim().min(1).max(100),
  country: z.string().trim().min(2).max(100),
  zipCode: z.string().trim().max(20).optional(),
});

export async function billingRoutes(app: FastifyInstance) {
  // iyzico geri çağrısı form gövdesiyle gelir (yalnız bu eklenti kapsamında).
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))));

  app.get("/api/subscription/billing", async (req) =>
    tenant(req, "subscription.view", async (db, actor) => {
      const c = (
        await db.query(
          `select c.grace_until::text as "graceUntil", c.provider_subscription_ref is not null as "providerLinked", c.provider_synced_at as "providerSyncedAt",
                  sp.billing_interval as interval, sp.currency, sp.amount, p.name as "planName"
             from companies c left join subscription_prices sp on sp.id = c.subscription_price_id left join subscription_plans p on p.id = sp.plan_id
            where c.id = $1`,
          [actor.companyId],
        )
      ).rows[0];
      const prices = (
        await db.query(
          `select sp.id, p.code as "planCode", p.name as "planName", sp.billing_interval as interval, sp.currency, sp.amount, sp.provider_plan_ref is not null as "payable"
             from subscription_prices sp join subscription_plans p on p.id = sp.plan_id where sp.active order by p.max_active_users nulls last, sp.billing_interval, sp.currency`,
        )
      ).rows;
      return { configured: iyzicoConfig().configured, graceDays: graceDays(), current: c, prices };
    }),
  );

  /** iyzico ödeme formunu başlatır. Kart bilgisi bu sunucuya hiç gelmez (iyzico'nun formunda girilir). */
  app.post("/api/subscription/checkout", async (req) => {
    const input = parse(z.object({ priceId: z.string().uuid(), customer: Customer }), req.body);
    const price = await tenant(req, "subscription.manage", async (db, actor) => {
      const st = (await db.query(`select subscription_status from companies where id = $1`, [actor.companyId])).rows[0]?.subscription_status;
      if (st === "cancelled") throw conflict("subscription_cancelled", "İptal edilmiş abonelik yeniden başlatılamaz");
      const p = (await db.query(`select id, provider_plan_ref from subscription_prices where id = $1 and active`, [input.priceId])).rows[0];
      if (!p) throw notFound("Fiyat");
      if (!p.provider_plan_ref) throw conflict("price_not_payable", "Bu fiyat için iyzico ödeme planı tanımlanmadı (platform işletmecisi)");
      return p as { id: string; provider_plan_ref: string };
    });
    const k = input.customer;
    const init = await initializeCheckout({
      conversationId: randomUUID(),
      callbackUrl: `${publicApiBase()}/api/subscription/iyzico/callback`,
      pricingPlanReferenceCode: price.provider_plan_ref,
      customer: {
        name: k.name, surname: k.surname, email: k.email, gsmNumber: k.gsmNumber.replace(/\s/g, ""), identityNumber: k.identityNumber,
        billingAddress: { contactName: `${k.name} ${k.surname}`, city: k.city, country: k.country, address: k.address, zipCode: k.zipCode },
      },
    }).catch(mapIyzico);
    return tenant(req, "subscription.manage", async (db, actor) => {
      await db.query(
        `insert into subscription_checkouts (company_id, price_id, provider_token, form_content, created_by) values (app_company_id(), $1, $2, $3, $4)`,
        [price.id, init.token, init.formContent, actor.userId],
      );
      await recordEvent(db, actor, { entityType: "company", entityId: actor.companyId, eventType: "subscription.checkout_started", after: { priceId: price.id } });
      return { pageUrl: `/api/subscription/checkout-page/${encodeURIComponent(init.token)}` };
    });
  });

  /** iyzico ödeme formunu barındıran sayfa (tarayıcı gezinmesi). Token tahmin edilemez; yalnız 30 dk geçerli bekleyen form. */
  app.get("/api/subscription/checkout-page/:token", { config: { public: true } }, async (req, reply) => {
    const { token } = req.params as { token: string };
    const content = await withUser(null, async (db) => (await db.query(`select subscription_checkout_form($1) as c`, [token])).rows[0]?.c as string | null);
    reply.header("content-type", "text/html; charset=utf-8").header("cache-control", "no-store");
    if (!content) return reply.code(404).send(`<!doctype html><meta charset="utf-8"><p>Ödeme formunun süresi doldu veya bulunamadı. Abonelik sayfasından yeniden başlatın.</p>`);
    return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Abonelik ödemesi</title></head>
<body><div id="iyzipay-checkout-form" class="responsive"></div>${content}</body></html>`;
  });

  /** iyzico ödeme formu dönüşü (form gövdesinde token). Sonuç iyzico API'sinden okunur; tarayıcı web uygulamasına döner. */
  app.post("/api/subscription/iyzico/callback", { config: { public: true } }, async (req, reply) => {
    const token = String((req.body as Record<string, unknown> | null)?.token ?? "");
    const back = (r: string) => reply.redirect(`${config.corsOrigin}/subscription?payment=${r}`, 303);
    if (!token) return back("failed");
    const companyId = await withUser(null, async (db) => (await db.query(`select subscription_company_by_checkout($1) as id`, [token])).rows[0]?.id as string | null);
    if (!companyId) return back("failed");
    let result;
    try {
      result = await retrieveCheckout(token);
    } catch {
      return back("failed");
    }
    const ok = Boolean(result.referenceCode) && result.subscriptionStatus !== "PENDING";
    await withTenant({ companyId, userId: SYSTEM_USER }, async (db) => {
      const co = (await db.query(`select id, price_id, status from subscription_checkouts where provider_token = $1 for update`, [token])).rows[0];
      if (!co || co.status !== "pending") return;
      await db.query(`update subscription_checkouts set status = $2, completed_at = now(), form_content = '' where id = $1`, [co.id, ok ? "completed" : "failed"]);
      if (!ok) return;
      await db.query(
        `update companies set provider_subscription_ref = $2, provider_customer_ref = $3, subscription_price_id = $4,
                subscription_plan_id = (select plan_id from subscription_prices where id = $4) where id = $1`,
        [companyId, result.referenceCode, result.customerReferenceCode ?? null, co.price_id],
      );
      const st = (await db.query(`select subscription_status from companies where id = $1`, [companyId])).rows[0].subscription_status;
      if (st !== "active" && st !== "cancelled") await transitionSubscription(db, automation(companyId), "active", "iyzico aboneliği başlatıldı");
      await recordEvent(db, automation(companyId), { entityType: "company", entityId: companyId, eventType: "subscription.provider_linked", after: { provider: "iyzico" } });
    });
    if (ok) await reconcileBilling(companyId).catch(() => undefined); // ilk tahsilatı kaydet (bildirim/günlük mutabakat da yakalar)
    return back(ok ? "success" : "failed");
  });

  /**
   * iyzico bildirimi. İçeriğe güvenilmez: yalnız abonelik referansı alınır, gerçek durum iyzico API'sinden okunur.
   * Tanınmayan referans 200 ile yok sayılır; mutabakat hatası 503 döner (iyzico yeniden dener).
   */
  app.post("/api/subscription/iyzico/webhook", { config: { public: true } }, async (req, reply) => {
    const ref = String((req.body as Record<string, unknown> | null)?.subscriptionReferenceCode ?? "");
    if (!ref) return { received: true, ignored: true };
    const companyId = await withUser(null, async (db) => (await db.query(`select subscription_company_by_ref($1) as id`, [ref])).rows[0]?.id as string | null);
    if (!companyId) return { received: true, ignored: true };
    try {
      await reconcileBilling(companyId);
    } catch {
      return reply.code(503).send({ received: false });
    }
    return { received: true };
  });

  app.post("/api/subscription/sync", async (req) => {
    const companyId = await tenant(req, "subscription.manage", async (_db, actor) => actor.companyId);
    return reconcileBilling(companyId).catch(mapIyzico);
  });

  app.get("/api/subscription/provider-payments", async (req) =>
    tenant(req, "subscription.view", async (db) =>
      (
        await db.query(
          `select id, provider, provider_order_ref as "orderRef", status, amount, currency, period_start::text as "periodStart", period_end::text as "periodEnd",
                  occurred_at as "occurredAt", invoice_status as "invoiceStatus", invoice_no as "invoiceNo", invoice_note as "invoiceNote", invoiced_at as "invoicedAt"
             from subscription_payments order by occurred_at desc limit 200`,
        )
      ).rows,
    ),
  );

  /** Muhasebe resmi faturayı kestikten sonra tahsilatı fatura numarasıyla işaretler (bir kez). */
  app.post("/api/subscription/provider-payments/:id/invoice", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ invoiceNo: z.string().trim().min(1).max(60), note: z.string().max(500).optional() }), req.body);
    return tenant(req, "subscription.manage", async (db, actor) => {
      const p = (await db.query(`select status, invoice_status, amount, currency, provider_order_ref from subscription_payments where id = $1 for update`, [id])).rows[0];
      if (!p) throw notFound("Tahsilat");
      if (p.invoice_status !== "to_invoice") throw conflict("not_invoiceable", p.invoice_status === "invoiced" ? "Bu tahsilatın faturası zaten işaretlendi" : "Başarısız tahsilat faturalanmaz");
      await db.query(`update subscription_payments set invoice_status = 'invoiced', invoice_no = $2, invoice_note = $3, invoiced_by = $4, invoiced_at = now() where id = $1`, [id, input.invoiceNo, input.note ?? null, actor.userId]);
      await db.query(
        `insert into subscription_events (company_id, event_type, amount, currency, reference, note, recorded_by) values ($1, 'invoice_recorded', $2, $3, $4, $5, $6)`,
        [actor.companyId, p.amount, p.currency, input.invoiceNo, `Tahsilat ${p.provider_order_ref}`, actor.userId],
      );
      await recordEvent(db, actor, { entityType: "company", entityId: actor.companyId, eventType: "subscription.invoice_recorded", after: { paymentId: id, invoiceNo: input.invoiceNo } });
      return { id, invoiceStatus: "invoiced", invoiceNo: input.invoiceNo };
    });
  });
}
