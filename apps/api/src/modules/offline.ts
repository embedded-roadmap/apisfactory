import type { FastifyInstance } from "fastify";
import { IMPORT_EXPORT_NOTES, ROLE_GUIDES, SUPPORT_POLICY, type OfflineSnapshot } from "@apisfactory/shared";
import { ctxOf, tenant } from "../http/context";

/**
 * R46 — Yedek, geri yükleme ve kesintide talimat erişimi (W37 §28: "Kesintide yayımlanmış talimat ve
 * atanmış iş listesinin kontrollü çevrimdışı kopyası kullanılabilsin"). Bu uç, kullanıcının o anki
 * gerçek durumunun (atanmış açık işler) ve şirketten bağımsız, sabit yayımlanmış talimatların
 * (rol rehberi, destek politikası — `@apisfactory/shared`'daki TEK kaynaktan, `/help` sayfasıyla aynı)
 * anlık bir görünümünü döner. Web tarafı bunu indirip `localStorage`'a yazar; sunucu tarafında hiçbir
 * "çevrimdışı" durum saklanmaz — bu yalnızca istemcinin kendi kopyasıdır.
 */
export async function offlineRoutes(app: FastifyInstance) {
  app.get("/api/offline/snapshot", async (req): Promise<OfflineSnapshot> => {
    const roles = ctxOf(req).roles;
    return tenant(req, "task.view", async (db, actor) => {
      const co = await db.query(`select id, name, code from companies where id = app_company_id()`);
      const u = await db.query(`select id, name from users where id = $1`, [actor.userId]);
      const tasks = await db.query(
        `select t.id, t.title, t.status, t.kind, t.due_date::text as "dueDate", t.entity_type as "entityType", t.entity_id as "entityId",
                (t.due_date is not null and t.due_date < current_date and t.status in ('open', 'in_progress', 'blocked')) as overdue
           from tasks t
          where t.status in ('open', 'in_progress', 'blocked')
            and (t.assignee_user_id = $1 or (t.assignee_user_id is null and t.assignee_role = any($2)))
          order by t.due_date nulls last, t.created_at desc
          limit 200`,
        [actor.userId, roles],
      );
      return {
        generatedAt: new Date().toISOString(),
        company: co.rows[0],
        user: { id: u.rows[0].id, name: u.rows[0].name, roles },
        roleGuides: ROLE_GUIDES,
        importExportNotes: IMPORT_EXPORT_NOTES,
        supportPolicy: SUPPORT_POLICY,
        myTasks: tasks.rows,
      };
    });
  });
}
