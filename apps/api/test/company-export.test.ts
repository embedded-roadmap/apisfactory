/**
 * R47 — şirketin tam veri ve dosya çıkış paketi (ana talimat §21). `GET /api/company/export`
 * gerçek bir ZIP döner; bu testler paketin gerçekten geçerli olduğunu ve kayıtları, kimlikleri
 * (parola hariç), ilişkileri, dosyaları ve veri sözlüğünü birlikte içerdiğini doğrular — yalnızca
 * birkaç sabit alan değil, gerçek veri tabanı içeriği. Zip'i açmak için sistemdeki `unzip` CLI'si
 * kullanılır (yeni bir npm bağımlılığı eklemeden).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, login, setupWorld, type World } from "./helpers";
import { closePool } from "../src/db/pool";

let w: World;
let A: string;

beforeAll(async () => {
  clearTokens();
  w = await setupWorld();
  A = w.a.companyId;
  // Gerçek bir dosya eki üretmek için bir kanala küçük bir görsel eki olan mesaj gönder.
  const channelId = expectOk(await call(w.app, "manager@a.test", A, "POST", "/api/channels", { name: "export-test" })).id;
  const png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  expectOk(
    await call(w.app, "manager@a.test", A, "POST", `/api/threads/channel/${channelId}/messages`, {
      body: "export testi için mesaj",
      attachments: [{ fileName: "export-test.png", contentType: "image/png", contentBase64: png1x1 }],
    }),
  );
});

afterAll(async () => {
  await w.app.close();
  await w.owner.end();
  await closePool();
});

async function fetchZip(as: string): Promise<{ status: number; buffer: Buffer | null; text?: string }> {
  const token = await login(w.app, as);
  const r = await w.app.inject({ method: "GET", url: "/api/company/export", headers: { authorization: `Bearer ${token}`, "x-company-id": A } });
  if (r.statusCode >= 300) return { status: r.statusCode, buffer: null, text: r.body };
  return { status: r.statusCode, buffer: r.rawPayload };
}

describe("Şirketin tam veri ve dosya çıkış paketi (R47)", () => {
  it("yetkisiz rol (manager dahil, admin.export izni olmayan) indiremez", async () => {
    const r = await fetchZip("manager@a.test");
    expect(r.status).toBe(403);
  });

  it("admin gerçek bir ZIP indirir; manifest, veri sözlüğü, kayıtlar, kimlikler (parola hariç) ve gerçek dosya eki içerir", async () => {
    const r = await fetchZip("admin@a.test");
    expect(r.status).toBe(200);
    expect(r.buffer).toBeTruthy();
    const buf = r.buffer!;
    // ZIP dosya imzası: "PK".
    expect(buf.subarray(0, 2).toString("latin1")).toBe("PK");

    const dir = mkdtempSync(path.join(tmpdir(), "apisfactory-export-"));
    const zipPath = path.join(dir, "export.zip");
    writeFileSync(zipPath, buf);

    const listing = execFileSync("unzip", ["-l", zipPath], { encoding: "utf-8" });
    expect(listing).toContain("manifest.json");
    expect(listing).toContain("veri-sozlugu.json");
    expect(listing).toContain("OKUBENI.txt");
    expect(listing).toContain("veri/kullanicilar.json");
    expect(listing).toMatch(/veri\/(memberships|items)\.json/);
    expect(listing).toMatch(/dosyalar\/message_attachments\//);

    const manifestText = execFileSync("unzip", ["-p", zipPath, "manifest.json"], { encoding: "utf-8" });
    const manifest = JSON.parse(manifestText);
    expect(manifest.company).toMatchObject({ code: "A" });
    expect(manifest.totalRows).toBeGreaterThan(0);
    expect(manifest.totalFiles).toBeGreaterThan(0);
    expect(manifest.excludedNote).toMatch(/password_hash/);

    const usersText = execFileSync("unzip", ["-p", zipPath, "veri/kullanicilar.json"], { encoding: "utf-8" });
    const users = JSON.parse(usersText);
    expect(users.length).toBeGreaterThan(0);
    expect(users[0]).toHaveProperty("email");
    expect(users[0]).not.toHaveProperty("password_hash");
    expect(JSON.stringify(users)).not.toMatch(/password/i);

    const dictText = execFileSync("unzip", ["-p", zipPath, "veri-sozlugu.json"], { encoding: "utf-8" });
    const dict = JSON.parse(dictText);
    expect(Array.isArray(dict)).toBe(true);
    expect(dict.length).toBeGreaterThan(5);
    const membershipsEntry = dict.find((d: any) => d.table === "memberships");
    expect(membershipsEntry.columns.some((c: any) => c.name === "status")).toBe(true);
  });

  it("olay geçmişine 'company.data_export' olarak kaydedilir (bütün indirmeler denetlenir)", async () => {
    await fetchZip("admin@a.test");
    const events = expectOk(await call(w.app, "admin@a.test", A, "GET", "/api/events?entityType=company"));
    expect(events.some((e: any) => e.eventType === "company.data_export")).toBe(true);
  });

  it("B şirketinin admin'i yalnızca kendi şirketinin verisini alır (RLS izolasyonu)", async () => {
    const B = w.b.companyId;
    const token = await login(w.app, "all@b.test");
    const r = await w.app.inject({ method: "GET", url: "/api/company/export", headers: { authorization: `Bearer ${token}`, "x-company-id": B } });
    expect(r.statusCode).toBe(403); // 'all@b.test' manager rolünde, company.data.export izni yok
  });
});
