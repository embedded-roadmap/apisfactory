import pg from "pg";
import { config } from "../config";
import type { Db } from "../db/pool";
import { runEscalations } from "../lib/workflow";
import { runPoFollowups } from "../modules/procurement";
import { runCollectionReminders } from "../modules/collections";
import { runSupplyRiskScan } from "../modules/supply-risk";
import { pushMeeting, runCalendarPull } from "../modules/calendar";

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
      if (job.topic === "calendar.push") {
        // Gerçek dış çağrı (takvim sağlayıcısı): bağlantı yoksa atlanır; hata olursa aşağıdaki geri çekilmeyle yeniden denenir.
        const res = await pushMeeting(job.company_id, job.payload.meetingId);
        console.log(`[calendar] ${job.payload.meetingId}: ${res.status}${res.reason ? ` (${res.reason})` : ""}`);
      } else {
        console.log(`[outbox:test] ${job.topic}`, job.payload);
      }
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
      const f = await runPoFollowups(c as unknown as Db, { companyId: co.id, userId: null, kind: "automation" });
      const rmd = await runCollectionReminders(c as unknown as Db, { companyId: co.id, userId: null, kind: "automation" });
      const risk = await runSupplyRiskScan(c as unknown as Db, { companyId: co.id, userId: null, kind: "automation" });
      if (f) console.log(`[purchasing] ${co.id}: ${f} tedarikçi takibi`);
      if (rmd) console.log(`[receivables] ${co.id}: ${rmd} tahsilat hatırlatması`);
      if (risk.detected || risk.resolved) console.log(`[supply-risk] ${co.id}: ${risk.detected} yeni, ${risk.resolved} çözüldü, ${risk.escalated} yükseltildi`);
      await c.query("commit");
      if (n) console.log(`[workflow] ${co.id}: ${n} görev yükseltildi`);
    } catch (e) {
      await c.query("rollback");
      console.error("[workflow] yükseltme hatası", (e as Error).message);
    }
    // Takvim → uygulama artımlı senkronu (dış çağrılar şirket işleminin dışında, kendi işlemleriyle).
    await c.query("begin");
    try {
      await c.query(`select set_config('app.company_id', $1, true)`, [co.id]);
      const cal = await runCalendarPull(c as unknown as Db, co.id);
      await c.query("commit");
      if (cal) console.log(`[calendar] ${co.id}: ${cal} toplantı takvimden güncellendi`);
    } catch (e) {
      await c.query("rollback");
      console.error("[calendar] senkron hatası", (e as Error).message);
    }
  }
}
setInterval(() => escalate(client).catch((e) => console.error(e)), 60_000);
