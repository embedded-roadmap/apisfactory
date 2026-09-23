import pg from "pg";
import { config } from "../config";
import type { Db } from "../db/pool";
import { runEscalations } from "../lib/workflow";

/**
 * Çıkış kutusu işleyicisi (test bağlayıcısı). Bu fazda dış sisteme hiçbir şey gönderilmez;
 * olaylar "işlendi" olarak işaretlenir ve konsola yazılır. Gerçek bağlayıcılar W17/W36'da eklenir.
 * Hata olursa deneme sayısı artar; sonucu belirsiz dış işlem "unknown" durumuna alınır (prompt §7).
 */
async function tick(client: pg.Client) {
  await client.query("begin");
  const r = await client.query(
    `select id, company_id, topic, payload, attempts from outbox
      where status = 'pending' and available_at <= now() order by id limit 20 for update skip locked`,
  );
  for (const job of r.rows) {
    try {
      console.log(`[outbox:test] ${job.topic}`, job.payload);
      await client.query(`update outbox set status = 'done', attempts = attempts + 1 where id = $1`, [job.id]);
    } catch (e) {
      await client.query(
        `update outbox set attempts = attempts + 1, last_error = $2,
                status = case when attempts + 1 >= 5 then 'failed' else 'pending' end,
                available_at = now() + make_interval(secs => power(2, attempts + 1)::int)
          where id = $1`,
        [job.id, (e as Error).message],
      );
    }
  }
  await client.query("commit");
}

// İşleyici, RLS'i aşmak için şema sahibi rolüyle çalışır (tüm şirketlerin kuyruğunu işler).
const client = new pg.Client({ connectionString: config.migrationDatabaseUrl });
await client.connect();
console.log("outbox işleyici başladı (test modu)");
setInterval(() => tick(client).catch((e) => console.error(e)), 2000);

/** Zaman aşımı taraması: her şirket için kendi bağlamında (RLS) süresi geçen onay görevlerini yükseltir. */
async function escalate(c: pg.Client) {
  const companies = await c.query(`select id from companies`);
  for (const co of companies.rows) {
    await c.query("begin");
    try {
      await c.query(`select set_config('app.company_id', $1, true)`, [co.id]);
      const n = await runEscalations(c as unknown as Db, { companyId: co.id, userId: null, kind: "automation" });
      await c.query("commit");
      if (n) console.log(`[workflow] ${co.id}: ${n} görev yükseltildi`);
    } catch (e) {
      await c.query("rollback");
      console.error("[workflow] yükseltme hatası", (e as Error).message);
    }
  }
}
setInterval(() => escalate(client).catch((e) => console.error(e)), 60_000);
