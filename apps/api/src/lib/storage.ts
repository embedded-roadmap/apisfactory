import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";

/**
 * Nesne depolama soyutlaması (W27, kullanıcının 2026-09-26 devam talimatı §2: "base64 saklama
 * yaklaşımını bırak... geliştirmede yerel depolama veya yerel S3 uyumlu test servisi
 * kullanılabilsin. Üretim depolama hizmeti seçimi daha sonra yapılandırılabilsin").
 *
 * Şu an yalnızca LocalDiskStorage uygulaması var — GERÇEK bir S3/MinIO bağlayıcısı bu oturumda
 * YAZILMADI (dış bağımlılık/karar bekliyor: hangi sağlayıcı, hangi bölge). Üretime geçerken bu
 * arayüzü uygulayan yeni bir sınıf (örn. S3Storage) eklenip STORAGE_BACKEND=s3 ile seçilmeli;
 * kod tarafında çağıran yerler değişmez.
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

let instance: LocalDiskStorage | null = null;

/** Süreç genelinde tek bir depolama örneği (test izolasyonu için `resetObjectStorageForTests` kullanılır). */
export function objectStorage(): LocalDiskStorage {
  if (!instance) {
    const root = process.env.STORAGE_LOCAL_DIR ?? path.join(process.cwd(), "data", "objects");
    instance = new LocalDiskStorage(root);
  }
  return instance;
}

export function resetObjectStorageForTests(root: string): void {
  instance = new LocalDiskStorage(root);
}

export function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function newObjectKey(companyId: string, area: string, fileName: string): string {
  const safe = fileName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
  return `${companyId}/${area}/${randomUUID()}-${safe}`;
}
