import type { FastifyInstance } from "fastify";
import { PurchaseRequestDecisionInput } from "@apisfactory/shared";
import { z } from "zod";
import { conflict, notFound } from "../lib/errors";
import { closeTasks, recordEvent } from "../lib/records";
import { ctxOf, parse, tenant } from "../http/context";

/** Satın alma talepleri, günlük işler ve olay geçmişi. */
export async function workRoutes(app: FastifyInstance) {
  app.get("/api/purchase-requests", async (req) =>
    tenant(req, "purchase.view", async (db) => {
      const r = await db.query(
        `select pr.id, pr.code, pr.status, pr.qty, pr.need_date as "needDate", pr.source_type as "sourceType", pr.source_id as "sourceId",
                i.id as "itemId", i.code as "itemCode", i.name as "itemName", i.manufacturer, i.mpn, pr.created_at as "createdAt"
           from purchase_requests pr join items i on i.id = pr.item_id order by pr.created_at desc limit 300`,
      );
      return r.rows;
    }),
  );

  /**
   * Talep onayı. Onay, tedarikçiye sipariş GÖNDERMEZ; dış gönderim bağlayıcısı ve bütçe/yetki kuralları sonraki fazdadır
   * (prompt §13). Kendi oluşturduğu talebi onaylama kontrolü talep otomasyonla açıldığı için burada geçerli değil.
   */
  app.post("/api/purchase-requests/:id/decision", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(PurchaseRequestDecisionInput, req.body);
    return tenant(req, "purchase.request.approve", async (db, actor) => {
      const r = await db.query(`select id, status, code from purchase_requests where id = $1 for update`, [id]);
      if (!r.rows[0]) throw notFound("Satın alma talebi");
      if (r.rows[0].status !== "open") throw conflict("invalid_transition", `Talep "${r.rows[0].status}" durumunda`);
      if (input.decision === "reject" && !input.note) throw conflict("reason_required", "Ret gerekçesi zorunlu");
      const to = input.decision === "approve" ? "approved" : "rejected";
      await db.query(`update purchase_requests set status = $2, decided_by = $3, decided_at = now() where id = $1`, [id, to, actor.userId]);
      await closeTasks(db, actor.companyId, "purchase_request_review", id);
      await recordEvent(db, actor, { entityType: "purchase_request", entityId: id, eventType: `status.${to}`, before: { status: "open" }, after: { status: to }, reason: input.note });
      return { id, status: to };
    });
  });

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
        `select id, title, status, kind, assignee_role as "assigneeRole", entity_type as "entityType", entity_id as "entityId", created_at as "createdAt"
           from tasks where status = 'open' and (assignee_user_id = $1 or assignee_role = any($2)) order by created_at limit 200`,
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
    tenant(req, null, async () => [
      { key: "digikey", name: "DigiKey", mode: "not_connected", note: "W17 — lisans/erişim doğrulaması bekliyor" },
      { key: "mouser", name: "Mouser", mode: "not_connected", note: "W17" },
      { key: "farnell", name: "Farnell", mode: "not_connected", note: "W17" },
      { key: "nexar", name: "Nexar / Octopart", mode: "not_connected", note: "W17" },
      { key: "einvoice", name: "e-Fatura / e-İrsaliye", mode: "not_connected", note: "W36 — sağlayıcı kararı açık" },
      { key: "test_station", name: "Test istasyonu", mode: "not_connected", note: "W22" },
      { key: "notifications", name: "Bildirim (outbox test bağlayıcısı)", mode: "test", note: "Olaylar yalnızca yerel kayda yazılır" },
    ]),
  );
}
