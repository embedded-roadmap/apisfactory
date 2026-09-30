/**
 * S3 uyumlu nesne depolama (oturum 41 — "veri yurt içinde kalmalı": MinIO veya yurt içi S3 uyumlu servis).
 * Varsayılan: test içinde çalışan küçük bir sahte S3 sunucusu — SDK'nın gerçek HTTP isteklerini (path-style yol, SigV4
 * yetki başlığı, Content-MD5 bütünlük kontrolü) doğrular. S3_TEST_ENDPOINT (+ S3_TEST_ACCESS_KEY_ID/SECRET, S3_TEST_BUCKET)
 * verilirse aynı testler gerçek bir S3/MinIO sunucusuna karşı da koşar.
 */
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { S3Storage, s3ConfigFromEnv, storageFromEnv, type S3Config } from "../src/lib/storage";

const objects = new Map<string, Buffer>();
const seen: { method: string; url: string; auth: string | undefined; md5: string | undefined }[] = [];
let server: Server;

/** Sahte S3: path-style /bucket/key; PUT'ta Content-MD5 doğrulanır (uyuşmazsa 400 BadDigest, gerçek S3 gibi). */
function fakeS3() {
  return createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, md5: req.headers["content-md5"] as string | undefined });
      const key = decodeURIComponent(new URL(req.url!, "http://x").pathname);
      if (req.method === "PUT") {
        const md5 = req.headers["content-md5"];
        if (md5 && createHash("md5").update(body).digest("base64") !== md5) {
          res.writeHead(400, { "content-type": "application/xml" }).end("<Error><Code>BadDigest</Code></Error>");
          return;
        }
        objects.set(key, body);
        res.writeHead(200, { etag: '"x"' }).end();
      } else if (req.method === "GET") {
        const o = objects.get(key);
        if (!o) res.writeHead(404, { "content-type": "application/xml" }).end("<Error><Code>NoSuchKey</Code><Message>yok</Message></Error>");
        else res.writeHead(200, { "content-length": String(o.length) }).end(o);
      } else if (req.method === "DELETE") {
        objects.delete(key);
        res.writeHead(204).end();
      } else res.writeHead(405).end();
    });
  });
}

let cfg: S3Config;
const real = !!process.env.S3_TEST_ENDPOINT;

beforeAll(async () => {
  if (real) {
    cfg = {
      endpoint: process.env.S3_TEST_ENDPOINT!, region: process.env.S3_TEST_REGION || "tr-1", bucket: process.env.S3_TEST_BUCKET || "apisfactory-test",
      accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY!, forcePathStyle: true,
    };
    const c = new S3Client({ endpoint: cfg.endpoint, region: cfg.region, forcePathStyle: true, credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey } });
    await c.send(new CreateBucketCommand({ Bucket: cfg.bucket })).catch(() => {});
  } else {
    server = fakeS3();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cfg = { endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, region: "tr-1", bucket: "kova", accessKeyId: "test-anahtar", secretAccessKey: "test-sir", forcePathStyle: true };
  }
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
});

describe(`S3 uyumlu depolama (${real ? "gerçek sunucu" : "sahte sunucu"})`, () => {
  it("yazar, okur, siler; ikili içerik bozulmaz", async () => {
    const s = new S3Storage(cfg);
    const data = Buffer.from([0, 1, 2, 250, 255, ...Buffer.from("merhaba dünya")]);
    await s.put("sirket-1/video/a b.mp4", data);
    expect((await s.get("sirket-1/video/a b.mp4")).equals(data)).toBe(true);
    await s.delete("sirket-1/video/a b.mp4");
    await expect(s.get("sirket-1/video/a b.mp4")).rejects.toThrow();
    expect(s.backend).toBe("s3");
  });

  it.skipIf(real)("path-style yol, SigV4 imzası ve Content-MD5 bütünlük başlığı gönderilir", async () => {
    seen.length = 0;
    await new S3Storage(cfg).put("k/1.bin", Buffer.from("abc"));
    const put = seen.find((x) => x.method === "PUT")!;
    expect(put.url.startsWith("/kova/k/1.bin")).toBe(true);
    expect(put.auth).toMatch(/^AWS4-HMAC-SHA256 Credential=test-anahtar\/\d{8}\/tr-1\/s3\/aws4_request/);
    expect(put.md5).toBe(createHash("md5").update("abc").digest("base64"));
  });

  it("güvensiz anahtar reddedilir", async () => {
    await expect(new S3Storage(cfg).put("../kacis", Buffer.from("x"))).rejects.toThrow(/Güvensiz/);
  });
});

describe("Depolama seçimi (ortam değişkenleri)", () => {
  it("varsayılan yerel disk; s3 seçilince eksik değişken açık hata verir (sessizce yerele düşmez)", () => {
    expect(storageFromEnv({ STORAGE_LOCAL_DIR: "x" } as NodeJS.ProcessEnv).backend).toBe("local");
    expect(() => storageFromEnv({ STORAGE_BACKEND: "s3", S3_ENDPOINT: "https://s3.ornek.com.tr" } as NodeJS.ProcessEnv)).toThrow(/S3_BUCKET/);
    expect(() => storageFromEnv({ STORAGE_BACKEND: "gcs" } as NodeJS.ProcessEnv)).toThrow(/Bilinmeyen/);
    expect(() => s3ConfigFromEnv({ S3_ENDPOINT: "s3.ornek.com.tr", S3_BUCKET: "b", S3_ACCESS_KEY_ID: "a", S3_SECRET_ACCESS_KEY: "s" } as NodeJS.ProcessEnv)).toThrow(/http/);
    const s = storageFromEnv({ STORAGE_BACKEND: "s3", S3_ENDPOINT: "https://s3.ornek.com.tr", S3_BUCKET: "b", S3_ACCESS_KEY_ID: "a", S3_SECRET_ACCESS_KEY: "s" } as NodeJS.ProcessEnv);
    expect(s.backend).toBe("s3");
  });
});
