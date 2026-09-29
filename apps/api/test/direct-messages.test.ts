/**
 * R25: birebir mesajlaşma — yalnız iki katılımcı görür; gizlilik uygulamada ve veri tabanında (kısıtlayıcı RLS).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, setupWorld, type World } from "./helpers";
import { closePool } from "../src/db/pool";

let w: World;
let A: string;
const RD = "rd@a.test";
const PR = "production@a.test";
const M = "manager@a.test";
let convId: string;
let userIds: Record<string, string> = {};

beforeAll(async () => {
  clearTokens();
  w = await setupWorld();
  A = w.a.companyId;
  const people = expectOk(await call(w.app, RD, A, "GET", "/api/direct-conversations/people"));
  userIds = Object.fromEntries(people.map((p: any) => [p.name, p.id]));
});

afterAll(async () => {
  await w.app.close();
  await w.owner.end();
  await closePool();
});

describe("Birebir mesajlaşma (R25)", () => {
  it("konuşma çift başına tektir; kendinle konuşma açılmaz", async () => {
    const other = userIds["A production"]!;
    convId = expectOk(await call(w.app, RD, A, "POST", "/api/direct-conversations", { userId: other })).id;
    expect(expectOk(await call(w.app, PR, A, "POST", "/api/direct-conversations", { userId: (await call(w.app, PR, A, "GET", "/api/direct-conversations/people")).body.find((p: any) => p.name === "A rd").id })).id).toBe(convId);
    const self = (await call(w.app, RD, A, "GET", "/api/me")).body;
    expect((await call(w.app, RD, A, "POST", "/api/direct-conversations", { userId: self.user?.id ?? self.id })).status).toBe(400);
  });

  it("mesaj yalnız iki katılımcıya görünür; yönetici dahil üçüncü kişi göremez ve yazamaz", async () => {
    expectOk(await call(w.app, RD, A, "POST", `/api/threads/direct/${convId}/messages`, { body: "Prototip kartta R12 değeri yanlış olabilir mi?" }));
    const mine = expectOk(await call(w.app, PR, A, "GET", `/api/threads/direct/${convId}`));
    expect(mine).toMatchObject({ label: "A rd" });
    expect(mine.messages.map((m: any) => m.body)).toEqual(["Prototip kartta R12 değeri yanlış olabilir mi?"]);
    expect((await call(w.app, M, A, "GET", `/api/threads/direct/${convId}`)).status).toBe(404);
    expect((await call(w.app, "quality@a.test", A, "POST", `/api/threads/direct/${convId}/messages`, { body: "araya giriyorum" })).status).toBe(404);
    expect((await call(w.app, RD, A, "POST", `/api/threads/direct/${convId}/messages`, { body: "bak", mentions: [userIds["A quality"]] })).status).toBe(400);
    expect(expectOk(await call(w.app, M, A, "GET", "/api/direct-conversations"))).toEqual([]);
  });

  it("okunmamış sayısı; okununca sıfırlanır", async () => {
    let list = expectOk(await call(w.app, PR, A, "GET", "/api/direct-conversations"));
    expect(list[0]).toMatchObject({ id: convId, name: "A rd", unread: 1 });
    expectOk(await call(w.app, PR, A, "POST", `/api/threads/direct/${convId}/read`, {}));
    list = expectOk(await call(w.app, PR, A, "GET", "/api/direct-conversations"));
    expect(list[0].unread).toBe(0);
  });

  it("veri tabanı: aynı şirkette başka kullanıcı bağlamında mesaj satırı görünmez; yedek kapsamı görür", async () => {
    await w.owner.query("begin");
    try {
      await w.owner.query("select set_config('app.company_id', $1, true), set_config('app.user_id', $2, true)", [A, userIds["A manager"]]);
      expect((await w.owner.query(`select count(*)::int as n from direct_conversations`)).rows[0].n).toBe(0);
      expect((await w.owner.query(`select count(*)::int as n from messages m join threads t on t.id = m.thread_id where t.entity_type = 'direct'`)).rows[0].n).toBe(0);
      expect((await w.owner.query(`select count(*)::int as n from messages where body like 'Prototip kartta%'`)).rows[0].n).toBe(0);
      await w.owner.query("select set_config('app.system_scope', 'backup', true)");
      expect((await w.owner.query(`select count(*)::int as n from messages where body like 'Prototip kartta%'`)).rows[0].n).toBe(1);
    } finally {
      await w.owner.query("rollback");
    }
  });
});
