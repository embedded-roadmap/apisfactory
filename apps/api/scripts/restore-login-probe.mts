// R46 test yardımcı script'i: restore.mjs'in "yetki" (RLS/rol) doğrulama bacağı için, RESTORE EDİLMİŞ
// hedef veritabanına bağlı GERÇEK ikinci bir API sunucusu başlatır — ayrı bir SÜREÇTE. Bunun nedeni:
// bu projenin config/db-pool modülleri süreç başına TEK bir veritabanı bağlantı dizesini (module-level
// sabit) varsayar; asıl test sürecinde zaten SOURCE veritabanına bağlı bir pool açıkken, AYNI süreç
// içinde ikinci bir buildApp()'ı FARKLI bir (restore edilmiş) hedefe bağlamanın güvenilir bir yolu yok.
// Bu yüzden test, DATABASE_URL/MIGRATION_DATABASE_URL ortam değişkenlerini hedefe işaret edecek şekilde
// ayarlayıp bu script'i `pnpm exec tsx` ile AYRI bir süreçte çalıştırır (backup.mjs/restore.mjs'in
// migrate.ts'i kendi süreçlerinde çalıştırmasıyla aynı desen).
//
// Script, backup ÖNCESİ kaynak veritabanında oluşturulan GERÇEK kullanıcı bilgileriyle GERÇEK bir giriş
// (/api/auth/login — parola hash'i R46 yedeğine dahildir) yapar ve /api/me çağırır; sonucu JSON olarak
// stdout'a yazar. Test bunu ayrıştırıp: girişin başarılı olduğunu (restore edilmiş password_hash
// çalışıyor), ve /api/me'nin YALNIZCA doğru şirketi döndüğünü (RLS restore sonrası da izolasyonu
// koruyor) doğrular.
import { buildApp } from "../src/app";
import { closePool } from "../src/db/pool";

async function main() {
  const app = await buildApp();
  try {
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: process.env.PROBE_EMAIL, password: process.env.PROBE_PASSWORD },
    });
    if (login.statusCode !== 200) {
      console.log(JSON.stringify({ ok: false, step: "login", status: login.statusCode, body: login.body }));
      return;
    }
    const session = login.json();
    const companyId = session.companies[0].id;
    const me = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: `Bearer ${session.token}`, "x-company-id": companyId },
    });
    console.log(
      JSON.stringify({
        ok: true,
        loginStatus: login.statusCode,
        meStatus: me.statusCode,
        me: me.statusCode === 200 ? me.json() : me.body,
        companyId,
        companyCount: session.companies.length,
      }),
    );
  } finally {
    await app.close();
    await closePool();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.log(JSON.stringify({ ok: false, error: String(e) }));
    process.exit(1);
  });
