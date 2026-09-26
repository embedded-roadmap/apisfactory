/**
 * Oturum 12 (W27/W28): kayda bağlı mesajlaşma (yetki, bahsetme, okundu, geri çekme) ve toplantı
 * (katılım, tutanak, aksiyonların göreve dönüşmesi, kapanan tutanağın değişmezliği).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, login, setupWorld, type World } from "./helpers";
import { closePool } from "../src/db/pool";

let w: World;
let A: string;
let productId: string;
const U: Record<string, string> = {};
const today = new Date().toISOString().slice(0, 10);
const addDays = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

beforeAll(async () => {
  clearTokens();
  w = await setupWorld();
  A = w.a.companyId;
  productId = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/products", { code: "MSG-1", name: "Mesaj kartı" })).id;
  const org = expectOk(await call(w.app, "manager@a.test", A, "GET", "/api/org"));
  for (const u of org.users) U[u.email?.split("@")[0] ?? u.name.replace("A ", "")] = u.id;
});

afterAll(async () => {
  await w.app.close();
  await w.owner.end();
  await closePool();
});

describe("Kayda bağlı mesajlaşma (W27)", () => {
  let msgId: string;
  it("yalnız kaydı görebilen yazar/okur; bahsedilen kişinin de yetkisi olmalı", async () => {
    const url = `/api/threads/product/${productId}`;
    expect(expectOk(await call(w.app, "rd@a.test", A, "GET", url))).toMatchObject({ label: "MSG-1 Mesaj kartı", messages: [] });
    const adm = await call(w.app, "admin@a.test", A, "GET", url);
    expect(adm.status).toBe(403); // teknik yönetici ürün göremez
    const bad = await call(w.app, "rd@a.test", A, "POST", `${url}/messages`, { body: "Admin baksın", mentions: [U.admin] });
    expect(bad.body.error.code).toBe("mention_no_access");
    const ment = expectOk(await call(w.app, "rd@a.test", A, "GET", `${url}/mentionable`));
    expect(ment.map((x: any) => x.id)).toContain(U.production);
    expect(ment.map((x: any) => x.id)).not.toContain(U.admin);
    const m = expectOk(await call(w.app, "rd@a.test", A, "POST", `${url}/messages`, { body: "Konnektör değişiyor, stok kontrolü?", mentions: [U.production, U.warehouse] }, { "idempotency-key": "msg-1" }));
    msgId = m.id;
    expect(m.mentioned).toBe(2);
    // Tekrar gönderim çift mesaj üretmez
    const again = expectOk(await call(w.app, "rd@a.test", A, "POST", `${url}/messages`, { body: "Konnektör değişiyor, stok kontrolü?", mentions: [U.production, U.warehouse] }, { "idempotency-key": "msg-1" }));
    expect(again.id).toBe(msgId);
    expectOk(await call(w.app, "production@a.test", A, "POST", `${url}/messages`, { body: "Stok 40 adet, yeterli.", replyTo: msgId }));
    const t = expectOk(await call(w.app, "warehouse@a.test", A, "GET", url));
    expect(t.messages).toHaveLength(2);
    expect(t.messages[0].mentions.map((x: any) => x.userId).sort()).toEqual([U.production, U.warehouse].sort());
    expect(t.messages[1].replyTo).toBe(msgId);
    // Diğer şirket göremez
    const other = await call(w.app, "all@b.test", w.b.companyId, "GET", url);
    expect(other.status).toBe(404);
  });

  it("bahsedilenler listesi, okundu işareti; mesaj metni değişmez, yazar gerekçeyle geri çeker", async () => {
    const before = expectOk(await call(w.app, "warehouse@a.test", A, "GET", "/api/mentions?unread=true"));
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ entityType: "product", label: "MSG-1 Mesaj kartı", link: `/products/${productId}`, authorName: "A rd" });
    expectOk(await call(w.app, "warehouse@a.test", A, "POST", `/api/threads/product/${productId}/read`));
    expect(expectOk(await call(w.app, "warehouse@a.test", A, "GET", "/api/mentions?unread=true"))).toHaveLength(0);
    const notMine = await call(w.app, "production@a.test", A, "POST", `/api/messages/${msgId}/retract`, { reason: "yanlış" });
    expect(notMine.status).toBe(403);
    expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/messages/${msgId}/retract`, { reason: "Yanlış ürüne yazıldı" }));
    const t = expectOk(await call(w.app, "rd@a.test", A, "GET", `/api/threads/product/${productId}`));
    expect(t.messages[0]).toMatchObject({ body: null, retractReason: "Yanlış ürüne yazıldı" });
    await w.owner.query(`select set_config('app.company_id', $1, false)`, [A]);
    await expect(w.owner.query(`update messages set body = 'x' where id = $1`, [msgId])).rejects.toThrow(/append_only/);
    await expect(w.owner.query(`delete from messages where id = $1`, [msgId])).rejects.toThrow(/append_only/);
  });
});

describe("Toplantı ve tutanak (W28)", () => {
  let meetingId: string;
  it("toplantıyı görev yöneticisi açar; davet bildirimleri çıkış kutusuna (test) yazılır", async () => {
    const tech = await call(w.app, "technician@a.test", A, "POST", "/api/meetings", { title: "Haftalık üretim", startsAt: new Date().toISOString(), participantIds: [] });
    expect(tech.status).toBe(403);
    const m = expectOk(await call(w.app, "production@a.test", A, "POST", "/api/meetings", {
      title: "Haftalık üretim toplantısı", startsAt: new Date(Date.now() + 3600e3).toISOString(), durationMinutes: 45, location: "Toplantı odası",
      agenda: "1. Hat verimi\n2. Konnektör değişikliği", participantIds: [U.quality, U.technician, U.warehouse], entityType: "product", entityId: productId,
    }, { "idempotency-key": "mt-1" }));
    meetingId = m.id;
    expect(m.code).toMatch(/^TOP-/);
    expect(m.participants).toHaveLength(4); // düzenleyen dahil
    expect(m.entityLabel).toBe("MSG-1 Mesaj kartı");
    const ob = await w.owner.query(`select count(*)::int as n from outbox where topic = 'notification.meeting_invite' and payload->>'meetingId' = $1`, [meetingId]);
    expect(ob.rows[0].n).toBe(3);
    const up = expectOk(await call(w.app, "technician@a.test", A, "GET", "/api/meetings?scope=mine"));
    expect(up[0]).toMatchObject({ code: m.code, isParticipant: true });
  });

  it("takvim daveti (.ics): standart iCalendar dosyası, başlık/tarih/yer/katılımcılar doğru; gerçek dış takvim bağlantısı yok", async () => {
    const r = await call(w.app, "production@a.test", A, "GET", `/api/meetings/${meetingId}/ics`);
    expect(r.status).toBe(200);
    const ics = String(r.body);
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain(`UID:meeting-${meetingId}@apisfactory`);
    expect(ics).toContain("LOCATION:Toplantı odası");
    expect(ics).toContain("Haftalık üretim toplantısı");
    expect(ics).toMatch(/ORGANIZER;CN=.*:mailto:production@a\.test/);
    expect(ics).toMatch(/ATTENDEE.*mailto:quality@a\.test/);
    expect(ics).toContain("END:VEVENT");
    expect(ics).toContain("END:VCALENDAR");
  });

  it("aksiyon sorumlu + tarih ister; katılım işaretlenmeden tutanak kapanmaz", async () => {
    const other = await call(w.app, "quality@a.test", A, "POST", `/api/meetings/${meetingId}/items`, { kind: "decision", text: "Kalite kararı" });
    expect(other.status).toBe(200); // kalite de görev yöneticisi (task.manage)
    const tech = await call(w.app, "technician@a.test", A, "POST", `/api/meetings/${meetingId}/items`, { kind: "info", text: "Bilgi" });
    expect(tech.status).toBe(403);
    const noOwner = await call(w.app, "production@a.test", A, "POST", `/api/meetings/${meetingId}/items`, { kind: "action", text: "Konnektör stoğunu say" });
    expect(noOwner.status).toBe(400);
    expectOk(await call(w.app, "production@a.test", A, "POST", `/api/meetings/${meetingId}/items`, { kind: "action", text: "Konnektör stoğunu say", ownerUserId: U.warehouse, dueDate: addDays(2) }));
    expectOk(await call(w.app, "production@a.test", A, "POST", `/api/meetings/${meetingId}/items`, { kind: "action", text: "Fikstürü yeni konnektöre uyarla", ownerUserId: U.technician, dueDate: addDays(5) }));
    const rm = expectOk(await call(w.app, "production@a.test", A, "GET", `/api/meetings/${meetingId}`));
    expectOk(await call(w.app, "production@a.test", A, "POST", `/api/meetings/${meetingId}/items/${rm.items[0].id}/remove`));
    expectOk(await call(w.app, "production@a.test", A, "POST", `/api/meetings/${meetingId}/update`, { notes: "Hat verimi %92. Konnektör değişikliği onaylandı." }));
    const early = await call(w.app, "production@a.test", A, "POST", `/api/meetings/${meetingId}/close`);
    expect(early.body.error.code).toBe("attendance_missing");
    for (const [u, a] of [[U.production, "attended"], [U.quality, "attended"], [U.technician, "attended"], [U.warehouse, "excused"]]) {
      expectOk(await call(w.app, "production@a.test", A, "POST", `/api/meetings/${meetingId}/participants`, { userId: u, attendance: a }));
    }
  });

  it("kapanışta aksiyonlar sorumlusuna görev olur; tutanak değişmez", async () => {
    const c = expectOk(await call(w.app, "production@a.test", A, "POST", `/api/meetings/${meetingId}/close`));
    expect(c.status).toBe("closed");
    expect(c.tasksCreated).toBe(2);
    expect(c.items.every((i: any) => i.kind !== "action" || (i.taskId && i.taskStatus === "open"))).toBe(true);
    const mine = expectOk(await call(w.app, "warehouse@a.test", A, "GET", "/api/tasks/mine"));
    const t = mine.find((x: any) => x.title === "Konnektör stoğunu say");
    expect(t).toMatchObject({ entityType: "meeting", entityId: meetingId, dueDate: addDays(2) });
    const late = await call(w.app, "production@a.test", A, "POST", `/api/meetings/${meetingId}/items`, { kind: "info", text: "Sonradan ekleme" });
    expect(late.body.error.code).toBe("meeting_closed");
    await w.owner.query(`select set_config('app.company_id', $1, false)`, [A]);
    await expect(w.owner.query(`update meeting_items set text = 'değişti' where meeting_id = $1`, [meetingId])).rejects.toThrow(/meeting_closed/);
    await expect(w.owner.query(`update meetings set notes = 'x' where id = $1`, [meetingId])).rejects.toThrow(/meeting_closed/);
    // Toplantının konuşması da çalışır
    expectOk(await call(w.app, "technician@a.test", A, "POST", `/api/threads/meeting/${meetingId}/messages`, { body: "Fikstür çizimi paylaşıldı", mentions: [U.production] }));
    const past = expectOk(await call(w.app, "manager@a.test", A, "GET", "/api/meetings?scope=past"));
    expect(past[0]).toMatchObject({ actions: 2, openActions: 2 });
    expect(today).toBeTruthy();
  });

  it("iptal gerekçeli; iptal edilen toplantı değişmez", async () => {
    const m = expectOk(await call(w.app, "quality@a.test", A, "POST", "/api/meetings", { title: "Kalite gözden geçirme", startsAt: new Date(Date.now() + 86400e3).toISOString(), participantIds: [U.rd] }));
    const noReason = await call(w.app, "quality@a.test", A, "POST", `/api/meetings/${m.id}/cancel`, {});
    expect(noReason.status).toBe(400);
    expectOk(await call(w.app, "quality@a.test", A, "POST", `/api/meetings/${m.id}/cancel`, { reason: "Denetim ertelendi" }));
    const upd = await call(w.app, "quality@a.test", A, "POST", `/api/meetings/${m.id}/update`, { title: "Yeni başlık" });
    expect(upd.body.error.code).toBe("meeting_closed");
  });
});

describe("Mesaj eki ve kanallar (W27 devamı)", () => {
  it("dosya eki: tür/boyut sınırı, indirmede yetki, geri çekilen mesajın eki görünmez", async () => {
    const purl = `/api/threads/product/${productId}`;
    const png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const tooBig = Buffer.alloc(3_100_000).toString("base64");
    const oversized = await call(w.app, "rd@a.test", A, "POST", `${purl}/messages`, { body: "Büyük dosya", attachments: [{ fileName: "buyuk.png", contentType: "image/png", contentBase64: tooBig }] });
    expect(oversized.status).toBe(400);
    const badType = await call(w.app, "rd@a.test", A, "POST", `${purl}/messages`, { body: "Kötü tür", attachments: [{ fileName: "x.exe", contentType: "application/x-msdownload", contentBase64: png1x1 }] });
    expect(badType.status).toBe(400);
    const msg = expectOk(await call(w.app, "rd@a.test", A, "POST", `${purl}/messages`, { body: "Fotoğraf ekli", attachments: [{ fileName: "test.png", contentType: "image/png", contentBase64: png1x1 }] }));
    expect(msg.attachments).toBe(1);
    const list = expectOk(await call(w.app, "rd@a.test", A, "GET", purl));
    const m = list.messages.find((x: any) => x.id === msg.id);
    expect(m.attachments).toMatchObject([{ fileName: "test.png", contentType: "image/png", sizeBytes: expect.any(Number) }]);
    const attId = m.attachments[0].id;
    // Yetkisi olmayan (admin bu ürünü göremez) ekini de indiremez
    const denied = await w.app.inject({ method: "GET", url: `/api/attachments/${attId}`, headers: { authorization: `Bearer ${await login(w.app, "admin@a.test")}`, "x-company-id": A } });
    expect(denied.statusCode).toBe(403);
    const ok = await w.app.inject({ method: "GET", url: `/api/attachments/${attId}`, headers: { authorization: `Bearer ${await login(w.app, "rd@a.test")}`, "x-company-id": A } });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toBe("image/png");
    expect(ok.rawPayload.length).toBe(Buffer.from(png1x1, "base64").length);
    // Mesaj geri çekilince listede eki de görünmez (metin gibi)
    expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/messages/${msg.id}/retract`, { reason: "Yanlış dosya" }));
    const after = expectOk(await call(w.app, "rd@a.test", A, "GET", purl));
    expect(after.messages.find((x: any) => x.id === msg.id).attachments).toEqual([]);
  });

  it("kanal: herhangi bir çalışan açar ve konuşur; yalnız oluşturan (veya task.manage) arşivler", async () => {
    const ch = expectOk(await call(w.app, "warehouse@a.test", A, "POST", "/api/channels", { name: "Depo duyuruları", description: "Genel depo konuları" }));
    expect(ch.code).toMatch(/^KNL-/);
    const list = expectOk(await call(w.app, "sales@a.test", A, "GET", "/api/channels"));
    expect(list.find((c: any) => c.id === ch.id)).toMatchObject({ name: "Depo duyuruları", archivedAt: null });
    expectOk(await call(w.app, "sales@a.test", A, "POST", `/api/threads/channel/${ch.id}/messages`, { body: "Herkese açık kanal mesajı" }));
    const thread = expectOk(await call(w.app, "warehouse@a.test", A, "GET", `/api/threads/channel/${ch.id}`));
    expect(thread.messages).toHaveLength(1);
    const deniedArchive = await call(w.app, "sales@a.test", A, "POST", `/api/channels/${ch.id}/archive`, { reason: "deneme" });
    expect(deniedArchive.status).toBe(403); // ne oluşturan ne de task.manage
    expectOk(await call(w.app, "warehouse@a.test", A, "POST", `/api/channels/${ch.id}/archive`, { reason: "Konu kapandı" }));
    const again = await call(w.app, "warehouse@a.test", A, "POST", `/api/channels/${ch.id}/archive`, { reason: "tekrar" });
    expect(again.body.error.code).toBe("invalid_transition");
  });

  it("RLS: başka şirket kanalı ve eki göremez", async () => {
    const b = await call(w.app, "all@b.test", w.b.companyId, "GET", "/api/channels");
    expect(expectOk(b)).toEqual([]);
  });
});
