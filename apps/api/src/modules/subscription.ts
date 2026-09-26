import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/pool";
import { conflict, notFound } from "../lib/errors";
import { idempotent, recordEvent } from "../lib/records";
import { idempotencyKey, parse, tenant } from "../http/context";

/**
 * W42 — SaaS abonelik ve şirket yaşam döngüsü.
 *
 * Kullanıcı kararı (2026-09-27): şirketler-arası (cross-tenant) yeni bir yetki sınırı AÇILMAZ — bu oturumda
 * platform genelinde tüm şirketleri yöneten bir "platform operatörü" arayüzü inşa edilmedi. Bunun yerine her
 * şirketin kendi "manager"/"accounting" rolü YALNIZCA KENDİ şirketinin abonelik durumunu/paket hakkını görür
 * ve değiştirir (subscription.view / subscription.manage, mevcut RLS sınırının içinde). Paket TANIMLARI
 * (subscription_plans) platform genelinde paylaşılan referans veridir ve şu an yalnızca migration/DB üzerinden
 * yönetilir — dürüstçe: gerçek bir platform-operatörü paket editörü yok, "ilk pilotta manuel ilerlenebilir"
 * ilkesiyle bilinçli olarak ertelendi.
 *
 * Durum motoru: trial → active → delinquent → restricted → cancelled (cancelled kalıcıdır, geri dönüş yok —
 * yeniden başlamak yeni bir şirket kaydı gerektirir, bu dürüstçe böyle bırakıldı). Her geçiş açık bir gerekçe
 * ister ve subscription_events'e (audit) yazılır. Gerçek bir ödeme sağlayıcısı henüz seçilmediğinden (bkz.
 * devam-notu.md dış bağımlılıklar tablosu) durum geçişleri ve ödeme kaydı ayrı, elle tetiklenen işlemlerdir —
 * ödeme kaydetmek durumu OTOMATİK değiştirmez (gerçek bir fatura/borç tutarı karşılaştırması yok; bunu
 * otomatikleştirmek uydurma bir borç kapama mantığı olurdu). Ödeme kaydı, mevcut genel idempotency mekanizması
 * (idempotency-key başlığı + idempotent() — rfq_award/wo_issue ile aynı) ile mükerrer işlenmeye karşı korunur.
 *
 * Kısıtlama etkisi (§ "kısıtların etkisini açık iş kuralına bağla"): durum 'restricted' olduğunda yalnızca YENİ
 * ticari taahhüt oluşturan iki nokta engellenir — yeni satış siparişi taslağı (`POST /api/sales-orders`) ve RFQ
 * ödülü ile yeni satın alma siparişi oluşturma (`POST /api/rfqs/:id/award`). Devam eden üretim, sevkiyat, fatura
 * görüntüleme, mevcut siparişlerin tamamlanması vb. HİÇBİR ŞEKİLDE kesilmez — "ödeme başarısızlığında ... çalışan
 * üretim sürecini kontrolsüz kesme" ilkesine uyar. Bu, bilinçli olarak dar bir kapsam: daha geniş bir kısıtlama
 * matrisi (ör. yeni iş emri açma, yeni fatura kesme) doğal bir uzantı ama bu oturumda kapsam dışı bırakıldı —
 * geliştirilmedi olarak dürüstçe kaydedilir.
 *
 * Kullanım sayaçları (aktif kullanıcı, komponent adedi) her istekte CANLI hesaplanır (memberships/items
 * tablolarından) — ayrı bir sayaç sütunu tutulmaz, bu da sayaç kayması (drift) riskini tamamen ortadan
 * kaldırır. Paket limitinin aşılması yalnızca BİLGİLENDİRİCİDİR (`overLimit`); otomatik kısıtlama tetiklemez —
 * bunu otomatikleştirmek, gerçek bir ödeme/fatura süreci olmadan tek taraflı bir iş kararı almak olurdu.
 */

const STATUSES = ["trial", "active", "delinquent", "restricted", "cancelled"] as const;
type Status = (typeof STATUSES)[number];
const TRANSITIONS: Record<Status, Status[]> = {
  trial: ["active", "cancelled"],
  active: ["delinquent", "cancelled"],
  delinquent: ["active", "restricted", "cancelled"],
  restricted: ["active", "cancelled"],
  cancelled: [],
};

/** Yeni ticari taahhüt oluşturan uç noktalardan çağrılır (bkz. yukarıdaki dosya açıklaması). */
export async function assertNotRestricted(db: Db, companyId: string, action: string) {
  const r = await db.query(`select subscription_status from companies where id = $1`, [companyId]);
  if (r.rows[0]?.subscription_status === "restricted") {
    throw conflict("subscription_restricted", `Şirketin aboneliği kısıtlı durumda; ${action} yapılamaz. Abonelik durumunu düzeltmek için yöneticinize başvurun.`);
  }
}

export async function subscriptionRoutes(app: FastifyInstance) {
  app.get("/api/subscription", async (req) =>
    tenant(req, "subscription.view", async (db, actor) => {
      const c = await db.query(
        `select s.subscription_status as status, s.subscription_status_reason as "statusReason",
                s.subscription_status_changed_at as "statusChangedAt", s.trial_ends_at as "trialEndsAt",
                p.id as "planId", p.code as "planCode", p.name as "planName",
                p.max_active_users as "maxActiveUsers", p.max_components as "maxComponents",
                p.includes_ai as "includesAi", p.includes_video as "includesVideo"
           from companies s left join subscription_plans p on p.id = s.subscription_plan_id
          where s.id = $1`,
        [actor.companyId],
      );
      if (!c.rows[0]) throw notFound("Şirket");
      const row = c.rows[0];
      const users = await db.query(`select count(*)::int as n from memberships where company_id = $1 and status = 'active'`, [actor.companyId]);
      const components = await db.query(`select count(*)::int as n from items where company_id = $1 and kind = 'component'`, [actor.companyId]);
      return {
        status: row.status,
        statusReason: row.statusReason,
        statusChangedAt: row.statusChangedAt,
        trialEndsAt: row.trialEndsAt,
        plan: row.planId ? { id: row.planId, code: row.planCode, name: row.planName, maxActiveUsers: row.maxActiveUsers, maxComponents: row.maxComponents, includesAi: row.includesAi, includesVideo: row.includesVideo } : null,
        usage: {
          activeUsers: users.rows[0].n,
          activeUsersOverLimit: row.maxActiveUsers != null && users.rows[0].n > row.maxActiveUsers,
          components: components.rows[0].n,
          componentsOverLimit: row.maxComponents != null && components.rows[0].n > row.maxComponents,
        },
      };
    }),
  );

  app.get("/api/subscription/plans", async (req) =>
    tenant(req, "subscription.view", async (db) => {
      const r = await db.query(
        `select id, code, name, max_active_users as "maxActiveUsers", max_components as "maxComponents", includes_ai as "includesAi", includes_video as "includesVideo"
           from subscription_plans order by max_active_users nulls last, code`,
      );
      return r.rows;
    }),
  );

  /** Paket değişikliği: şirketin kendi yönetim/muhasebe yetkisiyle, yalnızca kendi şirketi için. */
  app.post("/api/subscription/plan", async (req) => {
    const input = parse(z.object({ planCode: z.string().min(1), reason: z.string().max(1000).optional() }), req.body);
    return tenant(req, "subscription.manage", async (db, actor) => {
      const plan = await db.query(`select id, code from subscription_plans where code = $1`, [input.planCode]);
      if (!plan.rows[0]) throw notFound("Paket");
      const cur = await db.query(`select subscription_plan_id from companies where id = $1 for update`, [actor.companyId]);
      if (!cur.rows[0]) throw notFound("Şirket");
      if (cur.rows[0].subscription_plan_id === plan.rows[0].id) return { unchanged: true, planCode: plan.rows[0].code };
      await db.query(`update companies set subscription_plan_id = $2 where id = $1`, [actor.companyId, plan.rows[0].id]);
      await db.query(
        `insert into subscription_events (company_id, event_type, from_plan_id, to_plan_id, note, recorded_by) values ($1, 'plan_changed', $2, $3, $4, $5)`,
        [actor.companyId, cur.rows[0].subscription_plan_id, plan.rows[0].id, input.reason ?? null, actor.userId],
      );
      await recordEvent(db, actor, {
        entityType: "company",
        entityId: actor.companyId,
        eventType: "subscription.plan_changed",
        before: { planId: cur.rows[0].subscription_plan_id },
        after: { planId: plan.rows[0].id, planCode: plan.rows[0].code },
        reason: input.reason,
      });
      return { unchanged: false, planCode: plan.rows[0].code };
    });
  });

  /** Durum geçişi: açık gerekçe zorunlu, yalnızca tanımlı geçiş grafiğindeki adımlara izin verilir. */
  app.post("/api/subscription/transition", async (req) => {
    const input = parse(z.object({ to: z.enum(STATUSES), reason: z.string().min(3).max(1000) }), req.body);
    return tenant(req, "subscription.manage", async (db, actor) => {
      const cur = await db.query(`select subscription_status from companies where id = $1 for update`, [actor.companyId]);
      if (!cur.rows[0]) throw notFound("Şirket");
      const from = cur.rows[0].subscription_status as Status;
      if (from === input.to) throw conflict("invalid_transition", `Zaten "${from}" durumunda`);
      if (!TRANSITIONS[from].includes(input.to)) throw conflict("invalid_transition", `"${from}" durumundan "${input.to}" durumuna geçilemez`, { from, allowed: TRANSITIONS[from] });
      await db.query(
        `update companies set subscription_status = $2, subscription_status_reason = $3, subscription_status_changed_at = now() where id = $1`,
        [actor.companyId, input.to, input.reason],
      );
      await db.query(
        `insert into subscription_events (company_id, event_type, from_status, to_status, note, recorded_by) values ($1, 'status_changed', $2, $3, $4, $5)`,
        [actor.companyId, from, input.to, input.reason, actor.userId],
      );
      await recordEvent(db, actor, { entityType: "company", entityId: actor.companyId, eventType: "subscription.status_changed", before: { status: from }, after: { status: input.to }, reason: input.reason });
      return { from, to: input.to };
    });
  });

  /**
   * Manuel ödeme teyidi (pilot aşaması — gerçek ödeme sağlayıcısı yok, bkz. dosya açıklaması). Yalnızca
   * kaydeder; durumu OTOMATİK değiştirmez (bkz. dosya açıklaması). Aynı idempotency-key ile tekrar çağrı
   * mükerrer kayıt oluşturmaz.
   */
  app.post("/api/subscription/payments", async (req) => {
    const input = parse(
      z.object({ amount: z.string().regex(/^\d+(\.\d{1,6})?$/), currency: z.string().regex(/^[A-Z]{3}$/).default("TRY"), reference: z.string().max(120).optional(), note: z.string().max(1000).optional() }),
      req.body,
    );
    return tenant(req, "subscription.manage", (db, actor) =>
      idempotent(db, actor.companyId, "subscription_payment", idempotencyKey(req), async () => {
        const r = await db.query(
          `insert into subscription_events (company_id, event_type, amount, currency, reference, note, recorded_by) values ($1, 'payment_recorded', $2, $3, $4, $5, $6) returning id`,
          [actor.companyId, input.amount, input.currency, input.reference ?? null, input.note ?? null, actor.userId],
        );
        await recordEvent(db, actor, { entityType: "company", entityId: actor.companyId, eventType: "subscription.payment_recorded", after: { amount: input.amount, currency: input.currency, reference: input.reference } });
        return { id: String(r.rows[0].id) };
      }),
    );
  });

  app.get("/api/subscription/events", async (req) =>
    tenant(req, "subscription.view", async (db, actor) => {
      const r = await db.query(
        `select se.id, se.event_type as "eventType", se.from_status as "fromStatus", se.to_status as "toStatus",
                fp.code as "fromPlanCode", tp.code as "toPlanCode", se.amount, se.currency, se.reference, se.note,
                u.name as "recordedBy", se.created_at as "createdAt"
           from subscription_events se
           left join subscription_plans fp on fp.id = se.from_plan_id
           left join subscription_plans tp on tp.id = se.to_plan_id
           left join users u on u.id = se.recorded_by
          where se.company_id = $1 order by se.created_at desc limit 200`,
        [actor.companyId],
      );
      return r.rows.map((x) => ({ ...x, id: String(x.id) }));
    }),
  );
}
