// W40 — basit yük/dayanıklılık kontrolü.
// Bu script, prompt'taki 100.000 komponent / 1M kayıt / 100 eşzamanlı kullanıcı
// hedeflerinin TAM ÖLÇEKLİ bir testi DEĞİLDİR (bu sandbox ortamında disk/süre
// bütçesi buna izin vermiyor) — amaç, gerçek API + gerçek Postgres üzerinde,
// makul bir eşzamanlılıkta (20 bağlantı, 20 sn) gerçek ölçülmüş gecikme/verim
// rakamları üretmek ve dürüstçe raporlamaktır. Sonuçlar uydurulmaz.
//
// Kullanım: node scripts/loadtest.mjs
// Önkoşul: API sunucusu http://127.0.0.1:4000 adresinde çalışıyor olmalı,
// seed.ts demo verisi yüklenmiş olmalı.

import autocannon from "autocannon";

const BASE = "http://127.0.0.1:4000";

async function login(email, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login failed for ${email}: ${res.status} ${await res.text()}`);
  const body = await res.json();
  const companyId = body.companies?.[0]?.id;
  if (!companyId) throw new Error(`no company for ${email}`);
  return { token: body.token, companyId };
}

function summarize(result) {
  return {
    duration_s: result.duration,
    connections: result.connections,
    requests_total: result.requests.total,
    requests_per_sec_avg: result.requests.average,
    latency_ms_avg: result.latency.average,
    latency_ms_p99: result.latency.p99,
    errors: result.errors,
    non2xx: result.non2xx,
    timeouts: result.timeouts,
  };
}

async function run() {
  console.log("Giriş yapılıyor (depo@demo.apisfactory.com)...");
  const { token, companyId } = await login("depo@demo.apisfactory.com", "demo1234!");
  const headers = {
    authorization: `Bearer ${token}`,
    "x-company-id": companyId,
  };

  console.log("\n=== Okuma yükü: GET /api/items (20 bağlantı, 20 sn) ===");
  const readResult = await autocannon({
    url: `${BASE}/api/items`,
    connections: 20,
    duration: 20,
    headers,
  });
  console.log(JSON.stringify(summarize(readResult), null, 2));

  console.log("\n=== Okuma yükü: GET /api/stock/balances (20 bağlantı, 20 sn) ===");
  const balResult = await autocannon({
    url: `${BASE}/api/stock/balances`,
    connections: 20,
    duration: 20,
    headers,
  });
  console.log(JSON.stringify(summarize(balResult), null, 2));

  console.log("\n=== Yazma yükü: GET /api/imports (geçmiş — daha ağır sorgu, 20 bağlantı, 15 sn) ===");
  const importsResult = await autocannon({
    url: `${BASE}/api/imports`,
    connections: 20,
    duration: 15,
    headers,
  });
  console.log(JSON.stringify(summarize(importsResult), null, 2));

  console.log("\nTamamlandı.");
}

run().catch((err) => {
  console.error("Yük testi hata verdi:", err);
  process.exit(1);
});
