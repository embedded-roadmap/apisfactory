import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { can, ctxOf, tenant } from "../http/context";

/** Satın alma talepleri, günlük işler ve olay geçmişi. */
export async function workRoutes(app: FastifyInstance) {
  app.get("/api/purchase-requests", async (req) =>
    tenant(req, "purchase.view", async (db) => {
      const r = await db.query(
        `select pr.id, pr.code, pr.status, pr.qty, pr.need_date as "needDate", pr.source_type as "sourceType", pr.source_id as "sourceId",
                i.id as "itemId", i.code as "itemCode", i.name as "itemName", i.manufacturer, i.mpn, pr.created_at as "createdAt",
                pr.note, ru.name as "requestedBy", pr.requested_by as "requestedById", pr.estimated_amount as "estimatedAmount", pr.currency, pr.amount_source as "amountSource",
                du.name as "decidedBy", pr.decided_at as "decidedAt"
           from purchase_requests pr join items i on i.id = pr.item_id left join users ru on ru.id = pr.requested_by left join users du on du.id = pr.decided_by
          order by pr.created_at desc limit 300`,
      );
      // Tahmini tutar maliyet bilgisidir: alan izni olmayana gönderilmez.
      const showCost = can(req, "field.cost.view");
      return r.rows.map((x) => (showCost ? x : { ...x, estimatedAmount: undefined, currency: undefined, amountSource: undefined }));
    }),
  );

  app.get("/api/purchase-order-lines", async (req) =>
    tenant(req, "purchase.view", async (db) => {
      const r = await db.query(
        `select po.id, po.po_code as "poCode", po.supplier_name as "supplierName", po.qty_ordered as "qtyOrdered", po.qty_received as "qtyReceived",
                po.confirmed_date as "confirmedDate", po.status, i.code as "itemCode", i.id as "itemId"
           from purchase_order_lines po join items i on i.id = po.item_id order by po.created_at desc limit 300`,
      );
      return r.rows;
    }),
  );

  /** Günlük iş listesi: kullanıcının tüm rollerinden gelen açık görevler (prompt §20). */
  app.get("/api/tasks/mine", async (req) => {
    const c = ctxOf(req);
    return tenant(req, "task.view", async (db) => {
      const r = await db.query(
        `select id, title, status, kind, assignee_role as "assigneeRole", entity_type as "entityType", entity_id as "entityId", created_at as "createdAt",
                priority, start_date::text as "startDate", due_date::text as "dueDate", milestone,
                (due_date is not null and due_date < current_date) as overdue,
                jsonb_array_length(checklist) as "checklistTotal",
                (select count(*) from jsonb_array_elements(checklist) e where (e->>'done')::boolean)::int as "checklistDone"
           from tasks where status in ('open', 'in_progress', 'blocked') and (assignee_user_id = $1 or (assignee_user_id is null and assignee_role = any($2)))
          order by (due_date is not null and due_date < current_date) desc,
                   array_position(array['critical', 'high', 'normal', 'low'], priority), due_date nulls last, created_at limit 200`,
        [c.userId, c.roles],
      );
      return r.rows;
    });
  });

  app.get("/api/history/:entityType/:entityId", async (req) => {
    const { entityType, entityId } = req.params as { entityType: string; entityId: string };
    return tenant(req, "task.view", async (db) => {
      const r = await db.query(
        `select e.id, e.entity_type as "entityType", e.entity_id as "entityId", e.event_type as "eventType", u.name as "actorName",
                e.actor_kind as "actorKind", e.reason, e.before_state as before, e.after_state as after, e.correlation_id as "correlationId", e.created_at as "createdAt"
           from events e left join users u on u.id = e.actor_user_id
          where e.entity_type = $1 and e.entity_id = $2 order by e.id`,
        [entityType, entityId],
      );
      return r.rows;
    });
  });

  app.get("/api/events", async (req) => {
    const q = z
      .object({ entityType: z.string().optional(), eventType: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) })
      .parse(req.query);
    return tenant(req, "audit.view", async (db) => {
      const r = await db.query(
        `select e.id, e.entity_type as "entityType", e.entity_id as "entityId", e.event_type as "eventType", u.name as "actorName",
                e.actor_kind as "actorKind", e.reason, e.before_state as before, e.after_state as after, e.created_at as "createdAt"
           from events e left join users u on u.id = e.actor_user_id
          where ($1::text is null or e.entity_type = $1) and ($2::text is null or e.event_type like $2 || '%')
          order by e.id desc limit $3`,
        [q.entityType ?? null, q.eventType ?? null, q.limit],
      );
      return r.rows;
    });
  });

  /** Entegrasyon durumu: bu fazda hiçbir dış sağlayıcı bağlı değil; ekran bunu açıkça gösterir (prompt §2.9). */
  app.get("/api/integrations", async (req) =>
    tenant(req, null, async (db) => [
      ...(await db.query(`select key, name, mode from distributor_connectors order by key`)).rows.map((c) => ({
        key: c.key, name: c.name, mode: c.mode === "not_connected" ? "not_connected" : "test",
        note: c.mode === "test" ? "Sentetik TEST kataloğu — gerçek fiyat/stok değildir" : c.mode === "price_file" ? "Yüklenen fiyat listesi (dosya tarihli)" : "W17 — lisans/erişim doğrulaması bekliyor",
      })),
      { key: "supplier_orders", name: "Tedarikçi sipariş gönderimi", mode: "test", note: "Sipariş, hatırlatma ve iptal yalnızca çıkış kutusuna yazılır; tedarikçiye gerçek gönderim yok" },
      { key: "einvoice", name: "e-Fatura / e-İrsaliye", mode: "not_connected", note: "W36 — sağlayıcı kararı açık" },
      await (async () => {
        const n = (await db.query(`select count(*)::int as n from test_station_connectors where status = 'active'`)).rows[0].n as number;
        return n
          ? { key: "test_station", name: "Test istasyonu", mode: "test", note: `${n} bağlayıcı (CSV + istasyon API'si); adaptör gerçek istasyonla doğrulanmadı` }
          : { key: "test_station", name: "Test istasyonu", mode: "not_connected", note: "Kalite > Test istasyonu ekranından bağlayıcı tanımlanır" };
      })(),
      { key: "notifications", name: "Bildirim (outbox test bağlayıcısı)", mode: "test", note: "Olaylar yalnızca yerel kayda yazılır" },
    ]),
  );
}
