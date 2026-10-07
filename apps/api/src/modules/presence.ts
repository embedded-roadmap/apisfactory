import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Permission } from "@apisfactory/shared";
import { can, parse, tenant } from "../http/context";

/** Son sinyalden bu kadar süre geçince kişi çevrimdışı sayılır (istemci dakikada bir sinyal gönderir). */
const ONLINE_WINDOW_SEC = 120;
const STATUS = ["available", "busy", "away", "invisible"] as const;

/**
 * Kişiler paneli ve genel arama (Oturum 41 devamı). Durum: kişinin seçtiği durum + son sinyal zamanı; "çevrimdışı görün"
 * seçen ya da 2 dakikadır sinyal göndermeyen başkalarına "offline" görünür. Kendi durumunu herkes kendisi yazar (074 RLS).
 */
export async function presenceRoutes(app: FastifyInstance) {
  app.post("/api/presence/heartbeat", async (req) =>
    tenant(req, null, async (db, actor) => {
      await db.query(
        `insert into user_presence (company_id, user_id, last_seen_at) values (app_company_id(), $1, now())
         on conflict (company_id, user_id) do update set last_seen_at = now()`,
        [actor.userId],
      );
      return { ok: true };
    }),
  );

  app.put("/api/presence/status", async (req) => {
    const input = parse(z.object({ status: z.enum(STATUS) }), req.body);
    return tenant(req, null, async (db, actor) => {
      await db.query(
        `insert into user_presence (company_id, user_id, status, last_seen_at) values (app_company_id(), $1, $2, now())
         on conflict (company_id, user_id) do update set status = excluded.status, last_seen_at = now(), updated_at = now()`,
        [actor.userId, input.status],
      );
      return { status: input.status };
    });
  });

  /** Şirketin aktif iç üyeleri ve etkin durumları; kendi seçtiğim durum ayrıca döner. Dış kullanıcılar (fason) listelenmez. */
  app.get("/api/presence", async (req) =>
    tenant(req, "task.view", async (db, actor) => {
      const r = await db.query(
        `select u.id, u.name,
                case when p.last_seen_at is null or p.last_seen_at < now() - make_interval(secs => $2) or p.status = 'invisible'
                     then 'offline' else p.status end as status,
                p.last_seen_at as "lastSeenAt"
           from memberships m join users u on u.id = m.user_id
           left join user_presence p on p.user_id = u.id and p.company_id = app_company_id()
          where m.status = 'active' and not m.is_external and u.id <> $1
          order by (case when p.last_seen_at >= now() - make_interval(secs => $2) and p.status <> 'invisible' then 0 else 1 end), u.name`,
        [actor.userId, ONLINE_WINDOW_SEC],
      );
      const mine = await db.query(`select status from user_presence where user_id = $1`, [actor.userId]);
      return { me: { status: (mine.rows[0]?.status as string | undefined) ?? "available" }, people: r.rows };
    }),
  );

  /**
   * Genel arama: kişiler ve kayıtlar (yetkiye göre). Sayfa/menü araması istemcide yapılır. Her türden en fazla 5 sonuç.
   * RLS zaten şirket dışını gizler; burada ek olarak kullanıcının görme izni olmayan kayıt türü hiç sorgulanmaz.
   */
  app.get("/api/search", async (req) => {
    const { q } = parse(z.object({ q: z.string().trim().min(2).max(80) }), req.query);
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    return tenant(req, "task.view", async (db, actor) => {
      const results: { type: string; id: string; title: string; subtitle?: string; to?: string }[] = [];
      const add = async (perm: Permission | null, type: string, sql: string, to: (r: any) => string | undefined) => {
        if (perm && !can(req, perm)) return;
        for (const r of (await db.query(sql, sql.includes("$2") ? [like, actor.userId] : [like])).rows) results.push({ type, id: r.id, title: r.title, subtitle: r.subtitle ?? undefined, to: to(r) });
      };
      await add(null, "person",
        `select u.id, u.name as title, u.email as subtitle from memberships m join users u on u.id = m.user_id
          where m.status = 'active' and not m.is_external and u.id <> $2 and (u.name ilike $1 or u.email ilike $1) order by u.name limit 5`,
        () => undefined);
      await add("product.view", "product",
        `select id, code as title, name as subtitle from products where code ilike $1 or name ilike $1 order by code limit 5`,
        (r) => `/products/${r.id}`);
      await add("sales.view", "sales_order",
        `select so.id, so.code as title, c.name as subtitle from sales_orders so join customers c on c.id = so.customer_id
          where so.code ilike $1 or c.name ilike $1 order by so.created_at desc limit 5`,
        (r) => `/sales/${r.id}`);
      await add("purchase.view", "purchase_order",
        `select po.id, po.code as title, s.name as subtitle from purchase_orders po join suppliers s on s.id = po.supplier_id
          where po.code ilike $1 or s.name ilike $1 order by po.created_at desc limit 5`,
        (r) => `/purchasing/orders/${r.id}`);
      await add("production.view", "work_order",
        `select id, code as title, status as subtitle from work_orders where code ilike $1 order by created_at desc limit 5`,
        (r) => `/production/${r.id}`);
      await add("purchase.view", "supplier",
        `select id, code as title, name as subtitle from suppliers where code ilike $1 or name ilike $1 order by code limit 5`,
        () => "/purchasing/suppliers");
      await add("sales.view", "customer",
        `select id, code as title, name as subtitle from customers where code ilike $1 or name ilike $1 order by code limit 5`,
        () => "/sales");
      await add("product.view", "item",
        `select i.id, i.code as title, coalesce(i.mpn, i.name) as subtitle from items i
          where i.kind <> 'product' and (i.code ilike $1 or i.mpn ilike $1 or i.name ilike $1) order by i.code limit 5`,
        () => "/inventory");
      return { q, results };
    });
  });
}
