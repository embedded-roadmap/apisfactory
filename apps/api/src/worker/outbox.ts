import pg from "pg";
import { config } from "../config";

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
