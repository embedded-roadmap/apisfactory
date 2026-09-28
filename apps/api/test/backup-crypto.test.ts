/**
 * Oturum 41 — yedek betikleri artık openssl/tar/bash komutlarını çağırmıyor. Bu test Node uygulamasının
 * `openssl enc -aes-256-cbc -pbkdf2 -salt` ile BİREBİR aynı dosya biçimini ürettiğini İKİ YÖNLÜ doğrular
 * (önceden openssl ile alınmış yedekler açılabilmeli; yeni yedekler openssl ile de açılabilmeli).
 * Makinede openssl yoksa (ör. salt Windows) çapraz kontrol atlanır; Node gidiş-dönüşü her zaman koşar.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error - .mjs betiğinin tip tanımı yok
import { copyDirectory, countCsvRows, createArchive, decryptFile, encryptFile, extractArchive } from "../scripts/backup.mjs";

const hasOpenssl = spawnSync("openssl", ["version"], { encoding: "utf8" }).status === 0;
const PASS = "yedek-anahtari-ğüşİÖç-1";
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "backup-crypto-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("Yedek şifreleme (openssl uyumlu) ve arşiv", () => {
  it("Node şifrele → Node çöz; yanlış anahtar açık hatayla reddedilir", async () => {
    const plain = Buffer.from("x".repeat(100_000) + "son");
    await writeFile(path.join(dir, "a.bin"), plain);
    await encryptFile(path.join(dir, "a.bin"), path.join(dir, "a.enc"), PASS);
    const enc = await readFile(path.join(dir, "a.enc"));
    expect(enc.subarray(0, 8).toString("latin1")).toBe("Salted__");
    await decryptFile(path.join(dir, "a.enc"), path.join(dir, "a.out"), PASS);
    expect((await readFile(path.join(dir, "a.out"))).equals(plain)).toBe(true);
    await expect(decryptFile(path.join(dir, "a.enc"), path.join(dir, "a.bad"), "yanlis")).rejects.toThrow(/yanlış anahtar/);
  });

  it.skipIf(!hasOpenssl)("openssl ile şifrelenmiş yedeği Node açar; Node ile şifrelenmiş yedeği openssl açar", async () => {
    // Windows'ta komut satırı argümanı openssl.exe'ye sistem kod sayfasıyla geçer; ASCII dışı anahtar farklı baytlara
    // dönüşür (algoritma farkı değil). Linux'ta argüman UTF-8'dir — Türkçe anahtarla iki yön de Linux openssl'e karşı
    // elle doğrulandı (oturum 41). Bu yüzden Windows'ta çapraz kontrol ASCII anahtarla yapılır.
    const PASS = process.platform === "win32" ? "ascii-yedek-anahtari-1" : "yedek-anahtari-ğüşİÖç-1";
    const plain = Buffer.from("eski yedek içeriği — çok satırlı\n".repeat(500));
    await writeFile(path.join(dir, "b.bin"), plain);
    const o = spawnSync("openssl", ["enc", "-aes-256-cbc", "-pbkdf2", "-salt", "-in", path.join(dir, "b.bin"), "-out", path.join(dir, "b.enc"), "-pass", `pass:${PASS}`], { encoding: "utf8" });
    expect(o.status, o.stderr).toBe(0);
    await decryptFile(path.join(dir, "b.enc"), path.join(dir, "b.out"), PASS);
    expect((await readFile(path.join(dir, "b.out"))).equals(plain)).toBe(true);

    await encryptFile(path.join(dir, "b.bin"), path.join(dir, "c.enc"), PASS);
    const d = spawnSync("openssl", ["enc", "-d", "-aes-256-cbc", "-pbkdf2", "-in", path.join(dir, "c.enc"), "-out", path.join(dir, "c.out"), "-pass", `pass:${PASS}`], { encoding: "utf8" });
    expect(d.status, d.stderr).toBe(0);
    expect((await readFile(path.join(dir, "c.out"))).equals(plain)).toBe(true);
  });

  it("arşiv (tar.gz) gidiş-dönüşü, dizin kopyalama ve CSV satır sayımı (tail -n +2 | wc -l ile aynı anlam)", async () => {
    const src = path.join(dir, "src");
    await mkdir(path.join(src, "alt", "derin"), { recursive: true });
    await writeFile(path.join(src, "k.csv"), "id,ad\n1,a\n2,\"çok\nsatırlı\"\n");
    await writeFile(path.join(src, "alt", "derin", "d.txt"), "dosya");
    await createArchive(path.join(dir, "x.tar.gz"), src, ["k.csv", "alt"]);
    const out = path.join(dir, "out");
    await mkdir(out);
    await extractArchive(path.join(dir, "x.tar.gz"), out);
    expect(await readFile(path.join(out, "alt", "derin", "d.txt"), "utf8")).toBe("dosya");
    expect(await copyDirectory(src, path.join(dir, "copy"))).toBe(2);
    expect(await copyDirectory(path.join(dir, "yok"), path.join(dir, "copy2"))).toBe(0);
    expect(await countCsvRows(path.join(out, "k.csv"))).toBe(3); // wc -l: çok satırlı alan 2 sayılır (önceki davranışla aynı)
    await writeFile(path.join(dir, "h.csv"), "id,ad\n");
    expect(await countCsvRows(path.join(dir, "h.csv"))).toBe(0);
    expect(await countCsvRows(path.join(dir, "yok.csv"))).toBe(0);
  });
});
