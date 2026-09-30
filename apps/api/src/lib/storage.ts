import { createHash, randomUUID } from "node:crypto";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";

/**
 * Nesne depolama soyutlaması (W27, kullanıcının 2026-09-26 devam talimatı §2: "base64 saklama
 * yaklaşımını bırak... geliştirmede yerel depolama veya yerel S3 uyumlu test servisi
 * kullanılabilsin. Üretim depolama hizmeti seçimi daha sonra yapılandırılabilsin").
 *
 * Uygulamalar: LocalDiskStorage (varsayılan, geliştirme) ve S3Storage (oturum 41 — kullanıcı kararı "veri yurt içinde
 * kalmalı"): S3 uyumlu herhangi bir servis — kendi sunucunuzdaki MinIO veya Türkiye'de barındırılan S3 uyumlu bulut.
 * Seçim platform düzeyindedir (STORAGE_BACKEND=s3 + S3_ENDPOINT/S3_BUCKET/S3_REGION/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY,
 * S3_FORCE_PATH_STYLE=true MinIO için). Verinin nerede durduğu uç noktanın barındırıldığı yere bağlıdır; yurt içi uç
 * nokta seçmek işletmecinin kararıdır. Her kayıt hangi depolamada durduğunu storage_backend sütununda tutar; geçiş için
 * scripts/migrate-storage.mjs.
 */
export interface ObjectStorage {
  readonly backend: string;
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

export class LocalDiskStorage implements ObjectStorage {
  readonly backend = "local";
  constructor(private root: string) {}

  private resolve(key: string): string {
    if (key.includes("..") || path.isAbsolute(key)) throw new Error(`Güvensiz nesne anahtarı: ${key}`);
    return path.join(this.root, key);
  }

  async put(key: string, data: Buffer): Promise<void> {
    const p = this.resolve(key);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, data);
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.resolve(key));
  }

  async delete(key: string): Promise<void> {
    await unlink(this.resolve(key)).catch(() => {});
  }

  /** Yalnızca yerel disk uygulamasına özgü: ffprobe gibi dosya yolu isteyen araçlar için gerçek yol. */
  localPath(key: string): string {
    return this.resolve(key);
  }
}

export type S3Config = { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string; forcePathStyle: boolean };

export class S3Storage implements ObjectStorage {
  readonly backend = "s3";
  private client: S3Client;
  constructor(private cfg: S3Config) {
    this.client = new S3Client({
      endpoint: cfg.endpoint, region: cfg.region, forcePathStyle: cfg.forcePathStyle,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
  }

  private check(key: string) {
    if (key.includes("..") || key.startsWith("/")) throw new Error(`Güvensiz nesne anahtarı: ${key}`);
    return key;
  }

  async put(key: string, data: Buffer): Promise<void> {
    // Bütünlük: sunucu içeriği Content-MD5 ile doğrular (aktarımda bozulma yakalanır).
    await this.client.send(new PutObjectCommand({
      Bucket: this.cfg.bucket, Key: this.check(key), Body: data, ContentLength: data.length,
      ContentMD5: createHash("md5").update(data).digest("base64"),
    }));
  }

  async get(key: string): Promise<Buffer> {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: this.check(key) }));
    if (!r.Body) throw new Error(`Nesne boş: ${key}`);
    return Buffer.from(await r.Body.transformToByteArray());
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: this.check(key) })).catch(() => {});
  }
}

/** Ortam değişkenlerinden S3 yapılandırması; eksik alan varsa açık hata (sessizce yerel diske düşülmez). */
export function s3ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): S3Config {
  const need = ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"].filter((k) => !env[k]);
  if (need.length) throw new Error(`STORAGE_BACKEND=s3 için eksik ortam değişkeni: ${need.join(", ")}`);
  const endpoint = env.S3_ENDPOINT!;
  if (!/^https?:\/\//.test(endpoint)) throw new Error("S3_ENDPOINT http(s):// ile başlamalı");
  return {
    endpoint, bucket: env.S3_BUCKET!, region: env.S3_REGION || "tr-1",
    accessKeyId: env.S3_ACCESS_KEY_ID!, secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
    forcePathStyle: (env.S3_FORCE_PATH_STYLE ?? "true") !== "false",
  };
}

let instance: ObjectStorage | null = null;

export function storageFromEnv(env: NodeJS.ProcessEnv = process.env): ObjectStorage {
  const backend = env.STORAGE_BACKEND || "local";
  if (backend === "s3") return new S3Storage(s3ConfigFromEnv(env));
  if (backend !== "local") throw new Error(`Bilinmeyen STORAGE_BACKEND: ${backend} (local veya s3)`);
  return new LocalDiskStorage(env.STORAGE_LOCAL_DIR ?? path.join(process.cwd(), "data", "objects"));
}

/** Süreç genelinde tek bir depolama örneği — YENİ yazmalar buraya (test izolasyonu için `resetObjectStorageForTests`). */
export function objectStorage(): ObjectStorage {
  if (!instance) instance = storageFromEnv();
  return instance;
}

const byBackend = new Map<string, ObjectStorage>();
/**
 * OKUMA: kaydın storage_backend değerine göre doğru depolama. Geçiş kesintisiz olur — STORAGE_BACKEND=s3'e geçildikten
 * sonra henüz taşınmamış eski kayıtlar yerel diskten, yeniler S3'ten okunur (scripts/migrate-storage.mjs taşır).
 */
export function storageFor(backend: string | null | undefined): ObjectStorage {
  const current = objectStorage();
  if (!backend || backend === current.backend) return current;
  let s = byBackend.get(backend);
  if (!s) {
    s = storageFromEnv({ ...process.env, STORAGE_BACKEND: backend });
    byBackend.set(backend, s);
  }
  return s;
}

export function resetObjectStorageForTests(root: string | ObjectStorage): void {
  instance = typeof root === "string" ? new LocalDiskStorage(root) : root;
  byBackend.clear();
}

export function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function newObjectKey(companyId: string, area: string, fileName: string): string {
  const safe = fileName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
  return `${companyId}/${area}/${randomUUID()}-${safe}`;
}
