import type { FastifyInstance } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { withTenant, type Db } from "../db/pool";
import { AppError, badRequest, conflict, notFound } from "../lib/errors";
import { recordEvent, type Actor } from "../lib/records";
import { RuleRejection } from "../lib/rejection";
import { normalizeDecimal, parseCsv, sha256 } from "../lib/csv";
import { parse, tenant } from "../http/context";
import { recordDeviceTest, type TestInput } from "./production";

/**
 * W22 — Test istasyonu adaptörü (TEST modu). CSV yükleme (önizle → onayla) ve istasyon API'si
 * aynı sütun eşlemesiyle satırları cihaz serisine bağlar; her satır elle test girişindeki kuralların
 * aynısından geçer (recordDeviceTest). Aynı çalışma kimliği ikinci kez kaydedilmez.
 */

const MappingSchema = z.object({
  serial: z.string().min(1).max(80),
  runId: z.string().max(80).optional(),
  timestamp: z.string().max(80).optional(),
  result: z.string().max(80).optional(),
  firmware: z.string().max(80).optional(),
  decimal: z.enum([".", ","]).default("."),
  serialStrip: z.string().max(20).optional(),
  serialUpper: z.boolean().default(true),
  /** Saat dilimi bilgisi olmayan zamanlar için istasyonun UTC farkı (varsayılan İstanbul). */
  utcOffset: z.string().regex(/^[+-]\d{2}:\d{2}$/).default("+03:00"),
  passValues: z.array(z.string().max(20)).max(10).default(["pass", "ok", "p", "1", "geçti", "gecti"]),
  failValues: z.array(z.string().max(20)).max(10).default(["fail", "nok", "f", "0", "kaldı", "kaldi"]),
  measurements: z
    .array(z.object({ column: z.string().min(1).max(80), name: z.string().min(1).max(60), scale: z.number().positive().default(1) }))
    .max(100)
    .default([]),
});
export type StationMapping = z.infer<typeof MappingSchema>;

type Connector = { id: string; code: string; name: string; equipment_id: string; status: string; mapping: StationMapping };
type RowStatus = "ready" | "duplicate" | "unknown_serial" | "invalid" | "rejected" | "recorded";
type ParsedRow = {
  rowNo: number;
  raw: Record<string, unknown>;
  serial: string | null;
  externalRunId: string | null;
  measuredAt: string | null;
  firmware: string | null;
  measurements: { name: string; value: number }[];
  reported: "pass" | "fail" | null;
  error: string | null;
};
type Outcome = { status: RowStatus; result: "pass" | "fail" | null; code: string | null; message: string | null; deviceId: string | null; testRunId: string | null };

const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

function mappingColumns(m: StationMapping) {
  return [m.serial, m.runId, m.timestamp, m.result, m.firmware, ...m.measurements.map((x) => x.column)].filter((x): x is string => !!x);
}

/** Satır ayrıştırma: eşleme dışı sütunlar yok sayılır, değer uydurulmaz; hatalı satır "geçersiz" olarak kalır. */
export function parseStationRow(c: Connector, raw: Record<string, unknown>, rowNo: number): ParsedRow {
  const m = c.mapping;
  const str = (col?: string) => (col && raw[col] != null ? String(raw[col]).trim() : "");
  const out: ParsedRow = { rowNo, raw, serial: null, externalRunId: null, measuredAt: null, firmware: null, measurements: [], reported: null, error: null };
  let serial = str(m.serial);
  if (m.serialStrip && serial.startsWith(m.serialStrip)) serial = serial.slice(m.serialStrip.length);
  if (m.serialUpper) serial = serial.toUpperCase();
  if (!serial) return { ...out, error: "Seri numarası boş" };
  out.serial = serial;
  const ts = str(m.timestamp);
  if (ts) {
    const iso = ts.replace(" ", "T");
    const d = new Date(/(Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}${m.utcOffset}`);
    if (Number.isNaN(d.getTime())) return { ...out, error: `Zaman okunamadı: "${ts}"` };
    out.measuredAt = d.toISOString();
  }
  const r = str(m.result).toLowerCase();
  if (r) {
    if (m.passValues.map((x) => x.toLowerCase()).includes(r)) out.reported = "pass";
    else if (m.failValues.map((x) => x.toLowerCase()).includes(r)) out.reported = "fail";
    else return { ...out, error: `Sonuç değeri tanınmadı: "${r}"` };
  }
  out.firmware = str(m.firmware) || null;
  for (const x of m.measurements) {
    const v = str(x.column);
    if (!v) continue; // eksik zorunlu ölçümü plan kuralı yakalar
    const n = normalizeDecimal(v, m.decimal);
    if (n === null) return { ...out, error: `${x.column}: sayı değil ("${v}")` };
    out.measurements.push({ name: x.name, value: Number((Number(n) * x.scale).toPrecision(12)) });
  }
  const run = str(m.runId);
  // Çalışma kimliği yoksa satır içeriğinden türetilir: aynı satır tekrar yüklenirse tekrar kaydedilmez.
  out.externalRunId = `${c.code}:${run || createHash("sha256").update(JSON.stringify(raw)).digest("hex").slice(0, 24)}`;
  return out;
}

/**
 * Satırları sırayla işler; her satır kendi savepoint'inde. Önizlemede (commit=false) sonunda her şey geri alınır —
 * önizleme sonucu gerçek kaydın birebir aynı kurallarıyla hesaplanır (aynı dosyada aynı cihazın ikinci satırı dahil).
 */
async function processRows(db: Db, actor: Actor, c: Connector, rows: ParsedRow[], opts: { commit: boolean; batchId: string; source: "station_csv" | "station_api" }) {
  const outcomes: Outcome[] = [];
  if (!opts.commit) await db.query("savepoint sim");
  for (const r of rows) {
    const base = { deviceId: null, testRunId: null, result: null } as const;
    if (r.error || !r.serial) {
      outcomes.push({ ...base, status: "invalid", code: "invalid", message: r.error ?? "Satır okunamadı" });
      continue;
    }
    const input: TestInput = {
      result: r.reported === "fail" ? "fail" : r.reported ?? undefined,
      measurements: r.measurements,
      station: c.code,
      equipmentId: c.equipment_id,
      firmwareVersion: r.firmware ?? undefined,
      externalRunId: r.externalRunId ?? undefined,
    };
    await db.query("savepoint row");
    try {
      const res = await recordDeviceTest(db, actor, r.serial, input, { kind: opts.source, measuredAt: r.measuredAt, batchId: opts.batchId });
      await db.query("release savepoint row");
      if (res.duplicate) outcomes.push({ ...base, status: "duplicate", result: res.result, code: "duplicate", message: `Bu çalışma zaten kayıtlı (test #${res.runNo})` });
      else outcomes.push({ status: opts.commit ? "recorded" : "ready", result: res.result as "pass" | "fail", code: null, message: res.outOfLimit?.length ? `Limit dışı: ${res.outOfLimit.join(", ")}` : null, deviceId: res.deviceId ?? null, testRunId: opts.commit ? res.testRunId ?? null : null });
    } catch (e) {
      await db.query("rollback to savepoint row");
      if (e instanceof RuleRejection) {
        if (opts.commit) await recordEvent(db, actor, { ...e.event, source: `test_station:${c.code}` });
        outcomes.push({ ...base, status: "rejected", code: e.error.code, message: e.error.message, deviceId: e.event.entityId });
      } else if (e instanceof AppError) {
        if (e.code === "not_found" && e.message.startsWith("Cihaz")) outcomes.push({ ...base, status: "unknown_serial", code: "unknown_serial", message: `Seri bulunamadı: ${r.serial}` });
        else outcomes.push({ ...base, status: "rejected", code: e.code, message: e.message });
      } else throw e;
    }
  }
  if (!opts.commit) await db.query("rollback to savepoint sim");
  return outcomes;
}

async function loadConnector(db: Db, id: string): Promise<Connector> {
  const r = await db.query(`select id, code, name, equipment_id, status, mapping from test_station_connectors where id = $1`, [id]);
  if (!r.rows[0]) throw notFound("İstasyon bağlayıcısı");
  return { ...r.rows[0], mapping: MappingSchema.parse(r.rows[0].mapping) };
}

async function storeRows(db: Db, batchId: string, rows: ParsedRow[], outcomes: Outcome[]) {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!, o = outcomes[i]!;
    await db.query(
      `insert into test_station_rows (company_id, batch_id, row_no, raw, serial, external_run_id, measured_at, firmware_version, measurements, status, result, code, message, device_id, test_run_id)
       values (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [batchId, r.rowNo, JSON.stringify(r.raw), r.serial, r.externalRunId, r.measuredAt, r.firmware, JSON.stringify(r.measurements), o.status, o.result, o.code, o.message, o.deviceId, o.testRunId],
    );
  }
}

async function loadBatch(db: Db, id: string) {
  const b = await db.query(
    `select b.id, b.connector_id as "connectorId", c.code as "connectorCode", c.name as "connectorName", b.source, b.file_name as "fileName", b.status, b.total,
            b.created_at as "createdAt", u.name as "createdBy", b.committed_at as "committedAt", cu.name as "committedBy"
       from test_station_batches b join test_station_connectors c on c.id = b.connector_id
       left join users u on u.id = b.created_by left join users cu on cu.id = b.committed_by
      where b.id = $1`,
    [id],
  );
  if (!b.rows[0]) throw notFound("Test yükleme kaydı");
  const rows = (await db.query(
    `select row_no as "rowNo", serial, external_run_id as "externalRunId", measured_at as "measuredAt", firmware_version as "firmwareVersion",
            measurements, status, result, code, message, test_run_id as "testRunId"
       from test_station_rows where batch_id = $1 order by row_no`,
    [id],
  )).rows;
  const summary: Record<string, number> = {};
  for (const r of rows) summary[r.status] = (summary[r.status] ?? 0) + 1;
  return { ...b.rows[0], summary, rows };
}

export async function stationRoutes(app: FastifyInstance) {
  // ---- Bağlayıcılar ---------------------------------------------------------------------
  app.get("/api/test-station/connectors", async (req) =>
    tenant(req, "production.view", async (db) => {
      const r = await db.query(
        `select c.id, c.code, c.name, c.mode, c.status, c.mapping, c.token_hint as "tokenHint", c.updated_at as "updatedAt",
                e.id as "equipmentId", e.code as "equipmentCode", e.status as "equipmentStatus",
                (e.calibration_due is not null and e.calibration_due < current_date) as "calibrationExpired",
                (select max(b.created_at) from test_station_batches b where b.connector_id = c.id) as "lastBatchAt"
           from test_station_connectors c join equipment e on e.id = c.equipment_id order by c.code`,
      );
      return r.rows;
    }),
  );

  app.post("/api/test-station/connectors", async (req) => {
    const input = parse(z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{2,30}$/), name: z.string().min(2).max(120), equipmentId: z.string().uuid(), mapping: MappingSchema }), req.body);
    return tenant(req, "equipment.manage", async (db, actor) => {
      const e = await db.query(`select kind from equipment where id = $1`, [input.equipmentId]);
      if (!e.rows[0]) throw notFound("Ekipman");
      if (e.rows[0].kind !== "test_station") throw conflict("equipment_kind", "Bağlayıcı yalnızca test istasyonu türündeki ekipmana bağlanır");
      const r = await db.query(
        `insert into test_station_connectors (company_id, code, name, equipment_id, mapping, created_by) values (app_company_id(), $1, $2, $3, $4, $5) returning id`,
        [input.code.toUpperCase(), input.name, input.equipmentId, JSON.stringify(input.mapping), actor.userId],
      );
      await recordEvent(db, actor, { entityType: "test_station_connector", entityId: r.rows[0].id, eventType: "created", after: input });
      return { id: r.rows[0].id as string };
    });
  });

  app.post("/api/test-station/connectors/:id", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ name: z.string().min(2).max(120).optional(), status: z.enum(["active", "disabled"]).optional(), mapping: MappingSchema.optional(), reason: z.string().min(3).max(500) }), req.body);
    return tenant(req, "equipment.manage", async (db, actor) => {
      const before = (await db.query(`select name, status, mapping from test_station_connectors where id = $1 for update`, [id])).rows[0];
      if (!before) throw notFound("İstasyon bağlayıcısı");
      await db.query(
        `update test_station_connectors set name = coalesce($2, name), status = coalesce($3, status), mapping = coalesce($4, mapping), updated_at = now() where id = $1`,
        [id, input.name ?? null, input.status ?? null, input.mapping ? JSON.stringify(input.mapping) : null],
      );
      await recordEvent(db, actor, { entityType: "test_station_connector", entityId: id, eventType: "updated", before, after: input, reason: input.reason });
      return { id };
    });
  });

  /** İstasyon belirteci: yalnızca bir kez gösterilir, özeti saklanır; yenisi eskisini geçersiz kılar. */
  app.post("/api/test-station/connectors/:id/token", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, "equipment.manage", async (db, actor) => {
      const c = await loadConnector(db, id);
      const token = `ast_${randomBytes(24).toString("base64url")}`;
      await db.query(`select station_token_set($1, $2)`, [id, hashToken(token)]);
      await db.query(`update test_station_connectors set token_hint = $2, updated_at = now() where id = $1`, [id, `…${token.slice(-4)}`]);
      await recordEvent(db, actor, { entityType: "test_station_connector", entityId: id, eventType: "token.rotated", after: { code: c.code, hint: `…${token.slice(-4)}` } });
      return { token, hint: `…${token.slice(-4)}` };
    });
  });

  // ---- CSV: önizle → onayla ---------------------------------------------------------------
  app.post("/api/test-station/connectors/:id/preview", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ fileName: z.string().max(200).optional(), content: z.string().min(1).max(5_000_000) }), req.body);
    return tenant(req, "production.test.record", async (db, actor) => {
      const c = await loadConnector(db, id);
      if (c.status !== "active") throw conflict("connector_disabled", "Bağlayıcı devre dışı");
      const hash = sha256(input.content);
      const existing = await db.query(`select id from test_station_batches where connector_id = $1 and content_sha256 = $2`, [id, hash]);
      if (existing.rows[0]) return { ...(await loadBatch(db, existing.rows[0].id)), duplicateFile: true };
      const { headers, rows } = parseCsv(input.content);
      const missing = mappingColumns(c.mapping).filter((h) => !headers.includes(h));
      if (missing.length) throw badRequest(`Dosyada eşlemedeki sütunlar yok: ${missing.join(", ")}`, { missing, headers });
      if (!rows.length) throw badRequest("Dosyada satır yok");
      if (rows.length > 5000) throw badRequest("Bir dosyada en çok 5000 satır");
      const b = await db.query(
        `insert into test_station_batches (company_id, connector_id, source, file_name, content_sha256, total, created_by) values (app_company_id(), $1, 'csv', $2, $3, $4, $5) returning id`,
        [id, input.fileName ?? null, hash, rows.length, actor.userId],
      );
      const batchId = b.rows[0].id as string;
      const parsed = rows.map((r, i) => parseStationRow(c, r, i + 2)); // 1. satır başlık
      const outcomes = await processRows(db, actor, c, parsed, { commit: false, batchId, source: "station_csv" });
      await storeRows(db, batchId, parsed, outcomes);
      return { ...(await loadBatch(db, batchId)), duplicateFile: false };
    });
  });

  /** Onay: satırlar güncel durumla yeniden değerlendirilir (önizlemeden sonra değişen cihaz durumu dikkate alınır). */
  app.post("/api/test-station/batches/:id/commit", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, "production.test.record", async (db, actor) => {
      const b = (await db.query(`select * from test_station_batches where id = $1 for update`, [id])).rows[0];
      if (!b) throw notFound("Test yükleme kaydı");
      if (b.status === "committed") return loadBatch(db, id);
      if (b.status !== "preview") throw conflict("invalid_transition", "İptal edilmiş yükleme onaylanamaz");
      const c = await loadConnector(db, b.connector_id);
      if (c.status !== "active") throw conflict("connector_disabled", "Bağlayıcı devre dışı");
      const stored = (await db.query(`select row_no, raw from test_station_rows where batch_id = $1 order by row_no`, [id])).rows;
      const parsed = stored.map((r) => parseStationRow(c, r.raw, r.row_no));
      const outcomes = await processRows(db, { ...actor, kind: "import" }, c, parsed, { commit: true, batchId: id, source: "station_csv" });
      for (let i = 0; i < parsed.length; i++) {
        const o = outcomes[i]!;
        await db.query(
          `update test_station_rows set status = $3, result = $4, code = $5, message = $6, device_id = $7, test_run_id = $8 where batch_id = $1 and row_no = $2`,
          [id, parsed[i]!.rowNo, o.status, o.result, o.code, o.message, o.deviceId, o.testRunId],
        );
      }
      await db.query(`update test_station_batches set status = 'committed', committed_by = $2, committed_at = now() where id = $1`, [id, actor.userId]);
      const recorded = outcomes.filter((o) => o.status === "recorded").length;
      await recordEvent(db, actor, { entityType: "test_station_batch", entityId: id, eventType: "committed", after: { connector: c.code, fileName: b.file_name, total: parsed.length, recorded } });
      return loadBatch(db, id);
    });
  });

  app.post("/api/test-station/batches/:id/cancel", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, "production.test.record", async (db, actor) => {
      const r = await db.query(`update test_station_batches set status = 'cancelled' where id = $1 and status = 'preview' returning id`, [id]);
      if (!r.rowCount) throw conflict("invalid_transition", "Yalnızca önizlemedeki yükleme iptal edilir");
      await recordEvent(db, actor, { entityType: "test_station_batch", entityId: id, eventType: "cancelled" });
      return { id, status: "cancelled" };
    });
  });

  app.get("/api/test-station/batches", async (req) =>
    tenant(req, "production.view", async (db) => {
      const r = await db.query(
        `select b.id, c.code as "connectorCode", b.source, b.file_name as "fileName", b.status, b.total, b.created_at as "createdAt", u.name as "createdBy",
                count(*) filter (where r.status = 'recorded')::int as recorded, count(*) filter (where r.status in ('rejected', 'unknown_serial', 'invalid'))::int as problems,
                count(*) filter (where r.status = 'duplicate')::int as duplicates
           from test_station_batches b join test_station_connectors c on c.id = b.connector_id left join users u on u.id = b.created_by
           left join test_station_rows r on r.batch_id = b.id
          group by b.id, c.code, u.name order by b.created_at desc limit 100`,
      );
      return r.rows;
    }),
  );

  app.get("/api/test-station/batches/:id", async (req) =>
    tenant(req, "production.view", (db) => loadBatch(db, (req.params as { id: string }).id)),
  );

  // ---- İstasyon API'si (kullanıcı oturumu yok; istasyon belirteci) -----------------------------
  app.post("/api/station/runs", { config: { public: true } }, async (req) => {
    const token = req.headers["x-station-token"];
    if (typeof token !== "string" || !token.startsWith("ast_") || token.length > 100) throw new AppError(401, "unauthenticated", "İstasyon belirteci gerekli");
    const input = parse(z.object({ runs: z.array(z.record(z.union([z.string(), z.number(), z.null()]))).min(1).max(500) }), req.body);
    const found = await withTenant({ companyId: "00000000-0000-0000-0000-000000000000", userId: "" }, async (db) =>
      (await db.query(`select connector_id, company_id from station_token_lookup($1)`, [hashToken(token)])).rows[0] as { connector_id: string; company_id: string } | undefined,
    );
    if (!found) throw new AppError(401, "unauthenticated", "İstasyon belirteci geçersiz");
    const actor: Actor = { companyId: found.company_id, userId: null, kind: "api" };
    return withTenant({ companyId: found.company_id, userId: "" }, async (db) => {
      const c = await loadConnector(db, found.connector_id);
      if (c.status !== "active") throw conflict("connector_disabled", "Bağlayıcı devre dışı");
      const eq = (await db.query(`select status from equipment where id = $1`, [c.equipment_id])).rows[0];
      if (eq?.status !== "active") throw conflict("equipment_out_of_service", "İstasyon ekipmanı hizmet dışı");
      const hash = createHash("sha256").update(JSON.stringify(input.runs)).digest("hex");
      const existing = await db.query(`select id from test_station_batches where connector_id = $1 and content_sha256 = $2`, [c.id, hash]);
      let batchId: string;
      if (existing.rows[0]) batchId = existing.rows[0].id;
      else {
        const b = await db.query(
          `insert into test_station_batches (company_id, connector_id, source, content_sha256, total, status, committed_at) values (app_company_id(), $1, 'api', $2, $3, 'committed', now()) returning id`,
          [c.id, hash, input.runs.length],
        );
        batchId = b.rows[0].id;
        const parsed = input.runs.map((r, i) => parseStationRow(c, r, i + 1));
        const outcomes = await processRows(db, actor, c, parsed, { commit: true, batchId, source: "station_api" });
        await storeRows(db, batchId, parsed, outcomes);
      }
      const b = await loadBatch(db, batchId);
      return {
        mode: "test",
        batchId,
        replay: !!existing.rows[0],
        summary: b.summary,
        runs: b.rows.map((r: { rowNo: number; serial: string; status: string; result: string | null; code: string | null; message: string | null }) => ({ index: r.rowNo - 1, serial: r.serial, status: r.status, result: r.result, code: r.code, message: r.message })),
      };
    });
  });
}
