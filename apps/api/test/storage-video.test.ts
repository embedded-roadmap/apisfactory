/**
 * Oturum 37 (W27, devam talimatı §2): nesne depolama soyutlaması, gerçek dosya türü/süre
 * doğrulaması, ve büyük video eklerinin ön-yükleme → iliştirme → indirme akışı.
 *
 * Not (dürüst raporlama): burada yalnızca sınırın ALTINDA gerçek bir sentetik video test edilir.
 * 200 MB / 5 dakikalık gerçek bir dosya üretip yüklemek bu test takımında yapılmadı (disk/süre
 * maliyeti) — VIDEO_MAX_BYTES/VIDEO_MAX_SECONDS eşikleri kod incelemesiyle doğrulanabilir, ancak
 * gerçek bir 200 MB+ yükleme reddi bu oturumda uçtan uca doğrulanmadı; bu, devam notunda bilinen
 * bir kalan olarak işaretlenir.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, login, setupWorld, type World } from "./helpers";
import { closePool } from "../src/db/pool";
import { LocalDiskStorage, newObjectKey, sha256Hex } from "../src/lib/storage";
import { probeVideo, sniffContentType } from "../src/lib/media";

const execFileAsync = promisify(execFile);

let w: World;
let A: string;
let productId: string;
let workDir: string;
let mp4: Buffer;
let webm: Buffer;

beforeAll(async () => {
  clearTokens();
  w = await setupWorld();
  A = w.a.companyId;
  productId = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/products", { code: "VID-1", name: "Video test kartı" })).id;
  workDir = await mkdtemp(join(tmpdir(), "apf-video-test-"));
  const mp4Path = join(workDir, "clip.mp4");
  const webmPath = join(workDir, "clip.webm");
  // 1 saniyelik, sesli/görüntülü küçük gerçek klipler — süre/codec gerçekten ffprobe ile okunacak.
  await execFileAsync("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc=size=64x64:rate=10", "-t", "1", "-pix_fmt", "yuv420p", "-c:v", "libx264", mp4Path]);
  await execFileAsync("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc=size=64x64:rate=10", "-t", "1", "-pix_fmt", "yuv420p", "-c:v", "libvpx", webmPath]);
  mp4 = await readFile(mp4Path);
  webm = await readFile(webmPath);
});

afterAll(async () => {
  await w.app.close();
  await w.owner.end();
  await closePool();
  await rm(workDir, { recursive: true, force: true });
});

describe("Nesne depolama kitaplığı (lib/storage.ts)", () => {
  it("LocalDiskStorage: yaz/oku/sil", async () => {
    const dir = await mkdtemp(join(tmpdir(), "apf-storage-unit-"));
    const storage = new LocalDiskStorage(dir);
    const data = Buffer.from("merhaba dünya");
    await storage.put("a/b/c.txt", data);
    expect((await storage.get("a/b/c.txt")).toString()).toBe("merhaba dünya");
    await storage.delete("a/b/c.txt");
    await expect(storage.get("a/b/c.txt")).rejects.toThrow();
    await rm(dir, { recursive: true, force: true });
  });

  it("kaçış yollarını reddeder (path traversal)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "apf-storage-unit-"));
    const storage = new LocalDiskStorage(dir);
    await expect(storage.put("../evil.txt", Buffer.from("x"))).rejects.toThrow();
    await rm(dir, { recursive: true, force: true });
  });

  it("sha256Hex ve newObjectKey", () => {
    expect(sha256Hex(Buffer.from("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const key = newObjectKey("company-1", "videos", "../../etc/passwd.mp4");
    expect(key.startsWith("company-1/videos/")).toBe(true);
    // Anahtar üretimi dosya adını sonundan kırpıp güvenli karakterlere indirger; gerçek gezinme
    // koruması LocalDiskStorage.resolve() içindeki ".." kontrolüdür (bkz. yukarıdaki "kaçış yollarını
    // reddeder" testi) — burada yalnızca anahtarın tek segment beklenen yapıda kaldığı doğrulanır.
    expect(key.split("/")).toHaveLength(3);
  });
});

describe("Gerçek dosya türü/süre tespiti (lib/media.ts)", () => {
  it("magic-byte tespiti: gerçek MP4/WebM/PNG tanınır, rastgele bayt tanınmaz", () => {
    expect(sniffContentType(mp4)).toBe("video/mp4");
    expect(sniffContentType(webm)).toBe("video/webm");
    expect(sniffContentType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toBe("image/png");
    expect(sniffContentType(Buffer.from("bu bir video değil, düz metin"))).toBeNull();
  });

  it("probeVideo: gerçek süreyi ffprobe ile ölçer, bozuk dosyada null döner", async () => {
    const mp4Path = join(workDir, "clip.mp4");
    const probe = await probeVideo(mp4Path);
    expect(probe).not.toBeNull();
    expect(probe!.durationSeconds).toBeGreaterThan(0);
    expect(probe!.durationSeconds).toBeLessThan(3);
    expect(probe!.codec).toBe("h264");

    const junkPath = join(workDir, "junk.mp4");
    await writeFile(junkPath, randomBytes(200));
    expect(await probeVideo(junkPath)).toBeNull();
  });
});

describe("Video eki ön-yükleme → iliştirme → indirme akışı (W27)", () => {
  let stagedId: string;

  it("gerçek olmayan (beyanla uyuşmayan) içerik reddedilir", async () => {
    const r = await call(w.app, "rd@a.test", A, "POST", "/api/attachments/video/stage", Buffer.from("bu video değildir"), {
      "content-type": "video/mp4",
      "x-file-name": "sahte.mp4",
    } as any);
    expect(r.status).toBe(400);
  });

  it("gerçek bir MP4 ön-yüklenir: sunucu tarafında gerçek süre/tür doğrulanır", async () => {
    const r = expectOk(
      await call(w.app, "rd@a.test", A, "POST", "/api/attachments/video/stage", mp4, {
        "content-type": "video/mp4",
        "x-file-name": "test-klip.mp4",
      } as any),
    );
    expect(r.contentType).toBe("video/mp4");
    expect(r.codec).toBe("h264");
    expect(r.durationSeconds).toBeGreaterThan(0);
    expect(r.durationSeconds).toBeLessThan(3);
    stagedId = r.stagedUploadId;
  });

  it("ön-yüklenen video mesaja iliştirilir; indirilen baytlar orijinaliyle eşleşir", async () => {
    const url = `/api/threads/product/${productId}`;
    const m = expectOk(await call(w.app, "rd@a.test", A, "POST", `${url}/messages`, { body: "Hata anı kaydı ekte", attachments: [{ stagedUploadId: stagedId }] }));
    expect(m.attachments).toBe(1);
    const t = expectOk(await call(w.app, "rd@a.test", A, "GET", url));
    const att = t.messages.find((x: any) => x.id === m.id).attachments[0];
    expect(att.fileName).toBe("test-klip.mp4");
    expect(att.durationSeconds ?? null).not.toBeNull();
    const dl = await w.app.inject({
      method: "GET",
      url: `/api/attachments/${att.id}`,
      headers: { authorization: `Bearer ${await login(w.app, "rd@a.test")}`, "x-company-id": A },
    });
    expect(dl.statusCode).toBe(200);
    expect(Buffer.compare(dl.rawPayload, mp4)).toBe(0);
  });

  it("aynı ön-yükleme ikinci kez iliştirilemez (zaten kullanılmış)", async () => {
    const url = `/api/threads/product/${productId}`;
    const r = await call(w.app, "rd@a.test", A, "POST", `${url}/messages`, { body: "Tekrar dene", attachments: [{ stagedUploadId: stagedId }] });
    expect(r.body.error?.code).toBe("staged_upload_not_found");
  });

  it("başka bir kullanıcının ön-yüklemesi iliştirilemez", async () => {
    const staged = expectOk(
      await call(w.app, "rd@a.test", A, "POST", "/api/attachments/video/stage", webm, {
        "content-type": "video/webm",
        "x-file-name": "baskasi.webm",
      } as any),
    );
    const url = `/api/threads/product/${productId}`;
    const r = await call(w.app, "production@a.test", A, "POST", `${url}/messages`, { body: "El koymaya çalış", attachments: [{ stagedUploadId: staged.stagedUploadId }] });
    expect(r.body.error?.code).toBe("staged_upload_not_found");
  });

  it("eski satır içi (inline base64) ek desteği bozulmadı", async () => {
    const url = `/api/threads/product/${productId}`;
    const m = expectOk(
      await call(w.app, "rd@a.test", A, "POST", `${url}/messages`, {
        body: "Fotoğraf ekli",
        attachments: [{ fileName: "not.txt", contentType: "text/plain", contentBase64: Buffer.from("eski usul ek").toString("base64") }],
      }),
    );
    expect(m.attachments).toBe(1);
  });
});
