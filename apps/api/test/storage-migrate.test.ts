/**
 * Yerel diskten S3 uyumlu depolamaya taşıma (scripts/migrate-storage.mjs) ve satır bazlı okuma (storageFor):
 * kuru çalışma değiştirmez; --apply taşır ve doğrular; özet uyuşmazlığı ve eksik dosya taşınmaz; taşınan ek API'den okunur.
 */
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, login, setupWorld, type World } from "./helpers";
import { closePool } from "../src/db/pool";
import { resetObjectStorageForTests } from "../src/lib/storage";
import { runMigrateStorage } from "../scripts/migrate-storage.mjs";

let w: World;
let A: string;
let localDir: string;
let server: Server;
let endpoint: string;
const objects = new Map<string, Buffer>();
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const ids: Record<string, string> = {};

beforeAll(async () => {
  clearTokens();
  w = await setupWorld();
  A = w.a.companyId;
  localDir = await mkdtemp(path.join(tmpdir(), "apisf-migrate-"));
  resetObjectStorageForTests(localDir);
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const key = decodeURIComponent(new URL(req.url!, "http://x").pathname);
      if (req.method === "PUT") { objects.set(key, Buffer.concat(chunks)); res.writeHead(200, { etag: '"x"' }).end(); }
      else if (req.method === "GET" && objects.has(key)) res.writeHead(200).end(objects.get(key));
      else res.writeHead(404, { "content-type": "application/xml" }).end("<Error><Code>NoSuchKey</Code></Error>");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // Ürün + konuşma + nesne depolamalı üç ek (biri sağlam, biri özeti bozuk, biri dosyası eksik).
  const productId = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/products", { code: "ST-1", name: "Depolama ürünü" })).id;
  await w.owner.query("select set_config('app.company_id', $1, false)", [A]);
  const author = (await w.owner.query(`select id from users where email = 'rd@a.test'`)).rows[0].id;
  const thread = (await w.owner.query(`insert into threads (company_id, entity_type, entity_id) values ($1, 'product', $2) returning id`, [A, productId])).rows[0].id;
  const msg = (await w.owner.query(`insert into messages (company_id, thread_id, author_id, body) values ($1, $2, $3, 'ekli mesaj') returning id`, [A, thread, author])).rows[0].id;
  for (const [name, content, recordedSha, writeLocal] of [
    ["good", Buffer.from("sağlam video baytları"), null, true],
    ["bad", Buffer.from("değiştirilmiş içerik"), "0".repeat(64), true],
    ["gone", Buffer.from("kayıp"), null, false],
  ] as [string, Buffer, string | null, boolean][]) {
    const key = `${A}/video-attachments/${name}.mp4`;
    if (writeLocal) {
      await mkdir(path.dirname(path.join(localDir, key)), { recursive: true });
      await writeFile(path.join(localDir, key), content);
    }
    ids[name] = (await w.owner.query(
      `insert into message_attachments (company_id, message_id, file_name, content_type, size_bytes, sha256, object_key, storage_backend, duration_seconds, uploaded_by)
       values ($1, $2, $3, 'video/mp4', $4, $5, $6, 'local', 1, $7) returning id`,
      [A, msg, `${name}.mp4`, content.length, recordedSha ?? sha(content), key, author],
    )).rows[0].id;
  }
});

afterAll(async () => {
  for (const k of ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]) delete process.env[k];
  await new Promise((r) => server.close(r));
  await w.app.close();
  await w.owner.end();
  await closePool();
});

const s3 = () => ({ endpoint, region: "tr-1", bucket: "kova", accessKeyId: "a", secretAccessKey: "s", forcePathStyle: true });
const backendOf = async (id: string) => (await w.owner.query(`select storage_backend from message_attachments where id = $1`, [id])).rows[0].storage_backend;

describe("Depolama taşıma betiği", () => {
  it("kuru çalışma yalnız raporlar; hiçbir şey değişmez", async () => {
    const r = await runMigrateStorage({ databaseUrl: process.env.MIGRATION_DATABASE_URL!, localDir, s3: s3(), apply: false, log: () => {} });
    expect(r).toMatchObject({ found: 3, moved: 0, missing: 1, mismatch: 1 });
    expect(objects.size).toBe(0);
    expect(await backendOf(ids.good!)).toBe("local");
  });

  it("--apply: sağlam nesne taşınır ve doğrulanır; bozuk ve eksik olan taşınmaz; tekrar çalıştırma no-op", async () => {
    const r = await runMigrateStorage({ databaseUrl: process.env.MIGRATION_DATABASE_URL!, localDir, s3: s3(), apply: true, log: () => {} });
    expect(r).toMatchObject({ found: 3, moved: 1, missing: 1, mismatch: 1 });
    expect(objects.get(`/kova/${A}/video-attachments/good.mp4`)?.toString()).toBe("sağlam video baytları");
    expect([await backendOf(ids.good!), await backendOf(ids.bad!), await backendOf(ids.gone!)]).toEqual(["s3", "local", "local"]);
    const again = await runMigrateStorage({ databaseUrl: process.env.MIGRATION_DATABASE_URL!, localDir, s3: s3(), apply: true, log: () => {} });
    expect(again.found).toBe(2); // yalnız hâlâ yerel olanlar
  });

  it("uygulama okumayı satırın depolamasına göre yapar: taşınan ek S3'ten, taşınmayan yerelden gelir", async () => {
    Object.assign(process.env, { S3_ENDPOINT: endpoint, S3_BUCKET: "kova", S3_ACCESS_KEY_ID: "a", S3_SECRET_ACCESS_KEY: "s" });
    objects.set(`/kova/${A}/video-attachments/good.mp4`, Buffer.from("S3'teki sürüm")); // okumanın gerçekten S3'ten geldiğini kanıtlar
    const token = await login(w.app, "rd@a.test");
    const get = (id: string) => w.app.inject({ method: "GET", url: `/api/attachments/${id}`, headers: { authorization: `Bearer ${token}`, "x-company-id": A } });
    expect((await get(ids.good!)).body).toBe("S3'teki sürüm");
    expect((await get(ids.bad!)).body).toBe("değiştirilmiş içerik"); // hâlâ yerel diskten
  });
});

describe("Yedek, S3'teki nesneleri de içerir", () => {
  it("S3'e taşınmış nesne arşive indirilir; S3 erişimi yoksa eksik yedek yerine hata", async () => {
    const pg = (await import("pg")).default;
    // @ts-expect-error - .mjs betiğinin tip tanımı yok
    const { downloadS3Objects } = (await import("../scripts/backup.mjs")) as unknown as {
      downloadS3Objects: (c: unknown, companies: { id: string }[], dir: string, env?: Record<string, string>) => Promise<number>;
    };
    const client = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
    await client.connect();
    try {
      const out = await mkdtemp(path.join(tmpdir(), "apisf-bk-"));
      const env = { S3_ENDPOINT: endpoint, S3_BUCKET: "kova", S3_ACCESS_KEY_ID: "a", S3_SECRET_ACCESS_KEY: "s" };
      objects.set(`/kova/${A}/video-attachments/good.mp4`, Buffer.from("sağlam video baytları")); // kayıtlı özetle uyumlu içerik
      expect(await downloadS3Objects(client, [{ id: A }], out, env)).toBe(1);
      const { readFile } = await import("node:fs/promises");
      expect((await readFile(path.join(out, A, "video-attachments", "good.mp4"))).toString()).toBe("sağlam video baytları");
      await expect(downloadS3Objects(client, [{ id: A }], out, {})).rejects.toThrow(/eksik yedek üretilmedi/);
      objects.set(`/kova/${A}/video-attachments/good.mp4`, Buffer.from("bozulmuş"));
      await expect(downloadS3Objects(client, [{ id: A }], out, env)).rejects.toThrow(/özet uyuşmuyor/);
    } finally {
      await client.end();
    }
  });
});
