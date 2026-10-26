#!/usr/bin/env node
/**
 * Uçtan uca iş akışı testi (gerçek HTTP, gerçek iş kuralları). Her çalıştırmada YENİ bir şirket kurar, rol rol
 * kullanıcı davet eder ve zinciri baştan sona oynatır:
 *   kurulum → davet → ilk girişte zorunlu parola değişimi → Ar-Ge (ürün, BOM, revizyon, 3 birim devir onayı)
 *   → satın alma (talep, kendi onayı reddi, yönetici onayı, RFQ, 2 teklif, gerekçe kuralı, sipariş, gönderim, teyit)
 *   → mal kabul (kısmi, yanlış kalem reddi) → giriş kalite (kısmi ret) → satış (müşteri, adres, sipariş, kesinleştirme)
 *   → siparişsiz kabul + kalite → üretim (iş emri, malzeme çıkışı, operasyon sırası, cihaz testi, limit kontrolü,
 *     hurda, kalite kapısı, serbest bırakma) → sevkiyat (barkodla paket, hurda/tekrar okutma reddi, kontrol listesi,
 *     sevk, teslim) → fatura (KDV hesabı, kesim) → kişiler (durum, arama, birebir mesaj) → yönetici parola sıfırlama.
 * Yalnız YEREL sunucuda çalışır (canlıda hesap açmaz). Parolalar çalışma sırasında üretilir, yazdırılmaz.
 *
 * Kullanım:  node scripts/e2e-flow.mjs            (varsayılan http://localhost:4000)
 *            E2E_BASE=http://127.0.0.1:4000 node scripts/e2e-flow.mjs
 */
import { randomBytes } from "node:crypto";

const BASE = process.env.E2E_BASE ?? "http://localhost:4000";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) {
  console.error(`Güvenlik: bu betik yalnız yerel sunucuda çalışır (verilen: ${BASE}).`);
  process.exit(2);
}
const stamp = new Date().toISOString().replace(/\D/g, "").slice(2, 14);
const CODE = `E2E-${stamp}`;
const mail = (who) => `${who}.${stamp}@e2e.test`;
const pw = () => `${randomBytes(9).toString("base64url")}-Aa1`;
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

let ok = 0;
const fails = [];
const step = (title) => console.log(`\n▶ ${title}`);
function check(cond, label, extra) {
  if (cond) { ok++; console.log(`  ✓ ${label}`); }
  else { fails.push(label); console.log(`  ✗ ${label}${extra !== undefined ? ` — ${typeof extra === "string" ? extra : JSON.stringify(extra).slice(0, 300)}` : ""}`); }
}

const users = {}; // rol → { email, password, token }
let companyId;
async function http(who, method, url, body, extraHeaders = {}) {
  const u = who ? users[who] : null;
  const headers = { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(u?.token ? { authorization: `Bearer ${u.token}` } : {}), ...(companyId ? { "x-company-id": companyId } : {}), ...extraHeaders };
  const r = await fetch(`${BASE}${url}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: r.status, body: json };
}
/** Başarılı olmalı; değilse kaydeder ve hata fırlatır (sonraki adımlar anlamsızlaşır). */
async function must(who, method, url, body, label) {
  const r = await http(who, method, url, body);
  if (r.status >= 300) { check(false, label ?? `${method} ${url}`, r.body); throw new Error(`Akış durdu: ${label ?? url}`); }
  if (label) check(true, label);
  return r.body;
}
/** Belirli bir hata kodu ile reddedilmeli. */
async function mustFail(who, method, url, body, code, label) {
  const r = await http(who, method, url, body);
  const got = r.body?.error?.code;
  check(r.status >= 400 && (code === undefined || got === code), label, r.status < 400 ? `başarılı oldu (${r.status})` : `kod: ${got}`);
}
async function login(who) {
  const r = await http(null, "POST", "/api/auth/login", { email: users[who].email, password: users[who].password });
  if (r.status !== 200) throw new Error(`${who} girişi başarısız: ${r.status}`);
  users[who].token = r.body.token;
  return r.body;
}

async function main() {
  step("0. Sunucu");
  check((await http(null, "GET", "/health")).body?.ok === true, "API sağlıklı");

  step("1. Şirket kurulumu (kurucu = yönetici)");
  users.admin = { email: mail("yonetici"), password: pw() };
  const setup = await http(null, "POST", "/api/setup/company", { companyName: `E2E Test ${stamp}`, companyCode: CODE, adminName: "E2E Yönetici", adminEmail: users.admin.email, adminPassword: users.admin.password, founderDoesAll: false });
  check(setup.status === 200, "şirket kuruldu", setup.body);
  users.admin.token = setup.body.token;
  companyId = setup.body.companies[0].id;
  const meAdmin = await must("admin", "GET", "/api/me");
  check(JSON.stringify(meAdmin.roles.slice().sort()) === JSON.stringify(["admin", "manager"]), "kurucu yalnız admin + manager", meAdmin.roles);
  check(meAdmin.mustChangePassword === false, "kurucudan parola değişimi istenmez");

  step("2. Ekip daveti ve ilk girişte zorunlu parola değişimi");
  const ROLES = { arge: "rd", satinalma: "purchasing", depo: "warehouse", uretim: "production", kalite: "quality", teknisyen: "technician", satis: "sales", muhasebe: "accounting" };
  for (const [who, role] of Object.entries(ROLES)) {
    const r = await must("admin", "POST", "/api/admin/users", { email: mail(who), name: `E2E ${who}`, roles: [role] });
    users[who] = { email: mail(who), password: r.temporaryPassword, membershipId: r.membershipId };
  }
  check(Object.values(users).every((u) => u.password), "8 kullanıcı eklendi, geçici parolalar üretildi");
  let forcedOk = true;
  for (const who of Object.keys(ROLES)) {
    await login(who);
    const me = await http(who, "GET", "/api/me");
    const blocked = await http(who, "GET", "/api/products");
    const temp = users[who].password;
    users[who].password = pw();
    const ch = await http(who, "POST", "/api/auth/password", { current: temp, next: users[who].password });
    const after = await http(who, "GET", "/api/products");
    if (!(me.body?.mustChangePassword === true && blocked.status === 403 && blocked.body?.error?.code === "password_change_required" && ch.status === 200 && after.status === 200)) {
      forcedOk = false; console.log(`    ${who}: me=${me.body?.mustChangePassword} blocked=${blocked.status} change=${ch.status} after=${after.status}`);
    }
  }
  check(forcedOk, "her davetli: önce engellendi, parolasını değiştirince açıldı");

  step("3. Ar-Ge: ürün, BOM, revizyon, devir");
  await mustFail("satis", "POST", "/api/products", { code: "X", name: "Yetkisiz" }, undefined, "satış ürün açamaz (yetki)");
  const product = await must("arge", "POST", "/api/products", { code: "E2E-KART", name: "E2E Kontrol Kartı" }, "ürün açıldı");
  const csv = ["Designator,Manufacturer,MPN,Quantity,Description", "U1,STMicroelectronics,STM32F103C8T6,1,MCU", "U2,Texas Instruments,NE555DR,1,Timer", "U3,Texas Instruments,LM358DR,1,Op-amp", '"C1,C2,C3,C4",Murata,GRM188R71H104KA93D,4,100nF'].join("\n");
  const mapping = { refdes: "Designator", manufacturer: "Manufacturer", mpn: "MPN", qty: "Quantity", description: "Description" };
  const prev = await must("arge", "POST", "/api/imports/bom/preview", { productId: product.id, fileName: "e2e.csv", content: csv, mapping, decimalSeparator: "." });
  check(prev.summary?.errors === 0 && prev.rows?.length === 4, "BOM önizleme: 4 satır, 0 hata", prev.summary);
  const bomId = (await must("arge", "POST", `/api/imports/${prev.jobId}/commit`, {})).bomVersionId;
  await must("arge", "POST", `/api/boms/${bomId}/publish`, undefined, "BOM yayımlandı");
  const bom = await must("arge", "GET", `/api/boms/${bomId}`);
  const item = Object.fromEntries(bom.lines.map((l) => [l.mpn, l.itemId]));
  check(Object.keys(item).length === 4, "4 komponent kalemi oluştu");
  const rev = await must("arge", "POST", `/api/products/${product.id}/revisions`, { rev: "A", bomVersionId: bomId }, "Rev.A açıldı");
  await must("arge", "POST", `/api/revisions/${rev.id}/transition`, { action: "submit_handover" }, "devre gönderildi");
  await mustFail("satis", "POST", `/api/revisions/${rev.id}/handover`, { area: "production", decision: "approve" }, undefined, "satış üretim adına devir onaylayamaz");
  for (const [who, area] of [["arge", "rd"], ["uretim", "production"], ["kalite", "quality"]]) await must(who, "POST", `/api/revisions/${rev.id}/handover`, { area, decision: "approve" });
  const prod = (await must("arge", "GET", `/api/products/${product.id}`));
  check(prod.revisions?.find((r) => r.id === rev.id)?.status === "released", "3 birim onayıyla Rev.A yayımlandı");

  step("4. Satın alma: talep → onay → teklif → sipariş");
  const supA = await must("satinalma", "POST", "/api/suppliers", { code: "E2E-A", name: "E2E Elektronik A", defaultLeadTimeDays: 5 });
  const supB = await must("satinalma", "POST", "/api/suppliers", { code: "E2E-B", name: "E2E Elektronik B", defaultLeadTimeDays: 14 });
  await mustFail("satis", "POST", "/api/suppliers", { code: "E2E-X", name: "Yetkisiz" }, undefined, "satış tedarikçi açamaz (yetki)");
  const pr = await must("satinalma", "POST", "/api/purchase-requests", { itemId: item.STM32F103C8T6, qty: "50", needDate: day(40), note: "E2E pilot üretim MCU" }, "talep açıldı");
  await mustFail("satinalma", "POST", `/api/purchase-requests/${pr.id}/decision`, { decision: "approve" }, "self_approval", "kendi talebini onaylayamaz");
  await must("admin", "POST", `/api/purchase-requests/${pr.id}/decision`, { decision: "approve" }, "yönetici onayladı");
  const rfq = await must("satinalma", "POST", "/api/rfqs", { purchaseRequestId: pr.id }, "teklif talebi açıldı");
  await must("satinalma", "POST", `/api/rfqs/${rfq.id}/quotes`, { supplierId: supA.id, unitPrice: "185.50", currency: "TRY", leadTimeDays: 5 });
  const quotes = (await must("satinalma", "POST", `/api/rfqs/${rfq.id}/quotes`, { supplierId: supB.id, unitPrice: "172.00", currency: "TRY", leadTimeDays: 14 })).quotes;
  const qa = quotes.find((q) => q.supplierCode === "E2E-A"); const qb = quotes.find((q) => q.supplierCode === "E2E-B");
  check(qb?.cheapest === true && qa?.fastest === true && qa?.total === "9275.00", "karşılaştırma: B en ucuz, A en hızlı, A toplam 9275.00", { qa, qb });
  await mustFail("satinalma", "POST", `/api/rfqs/${rfq.id}/award`, { quoteId: qa.id }, "award_reason_required", "en ucuz olmayan teklif gerekçesiz seçilemez");
  const award = await must("satinalma", "POST", `/api/rfqs/${rfq.id}/award`, { quoteId: qa.id, reason: "Pilot takvimi: 9 gün erken teslim" }, "gerekçeyle seçildi, sipariş taslağı");
  await must("satinalma", "POST", `/api/purchase-orders/${award.poId}/send`, undefined, "satın almacı kendi talebinin siparişini gönderebildi");
  const po = await must("satinalma", "GET", `/api/purchase-orders/${award.poId}`);
  await must("satinalma", "POST", `/api/purchase-orders/${award.poId}/lines/${po.lines[0].id}/confirm`, { confirmedDate: day(5), supplierReference: "E2E-SO-1" }, "tedarikçi teyidi");

  step("5. Mal kabul ve giriş kalite");
  await mustFail("depo", "POST", "/api/receipts", { supplierName: "E2E Elektronik A", purchaseOrderLineId: po.lines[0].id, lines: [{ itemId: item.NE555DR, lotNo: "E2E-YANLIS", qty: "5" }] }, "po_item_mismatch", "sipariş satırıyla uyuşmayan kalem reddedildi");
  const rc = await must("depo", "POST", "/api/receipts", { supplierName: "E2E Elektronik A", purchaseOrderLineId: po.lines[0].id, lines: [{ itemId: item.STM32F103C8T6, lotNo: "E2E-MCU-1", qty: "30" }] }, "30 adet kısmi kabul");
  await mustFail("depo", "POST", `/api/receipt-lines/${rc.lines[0].id}/inspection`, { acceptedQty: "28", rejectedQty: "2" }, undefined, "depo kalite kararı veremez");
  await must("kalite", "POST", `/api/receipt-lines/${rc.lines[0].id}/inspection`, { acceptedQty: "28", rejectedQty: "2", note: "2 adet bükük bacak" }, "kalite: 28 kabul / 2 ret");
  const poAfter = await must("satinalma", "GET", `/api/purchase-orders/${award.poId}`);
  check(Number(poAfter.lines[0].qtyReceived) === 30, "sipariş satırında alınan 30", poAfter.lines[0]);

  step("6. Satış: müşteri, adres, sipariş, kesinleştirme");
  const cust = await must("satis", "POST", "/api/customers", { code: "E2E-MUS", name: "E2E Müşteri A.Ş." }, "müşteri açıldı");
  await mustFail("satis", "POST", "/api/customers", { code: "E2E-MUS", name: "Kopya" }, "duplicate", "aynı müşteri kodu reddedildi");
  await must("satis", "POST", `/api/customers/${cust.id}/addresses`, { label: "Merkez", recipient: "E2E Teslim Alan", line1: "OSB 5. Cadde No:12", city: "Bursa", isDefault: true }, "teslim adresi eklendi");
  const so = await must("satis", "POST", "/api/sales-orders", { customerId: cust.id, requestedDate: day(45), lines: [{ productRevisionId: rev.id, qty: "10", unitPrice: "1250", currency: "TRY" }] }, "satış siparişi taslağı");
  const conf = await must("satis", "POST", `/api/sales-orders/${so.id}/confirm`, undefined, "sipariş kesinleşti");
  const opened = (conf.materials ?? conf.result?.materials ?? []).filter((m) => m.purchaseRequestId || m.requestCreated || m.request === "opened").length;
  const prs = await must("satinalma", "GET", "/api/purchase-requests");
  check(prs.filter((p) => p.sourceType === "production_need").length >= 3, "eksik 3 parça için otomatik talep açıldı", { opened, total: prs.length });
  await must("satis", "POST", `/api/sales-orders/${so.id}/delivery`, { allowPartial: true }, "kısmi teslim kabul");

  step("7. Siparişsiz kabul ve kalite (eksik parçalar)");
  for (const [mpn, qty, lot] of [["GRM188R71H104KA93D", "50", "E2E-C100N"], ["LM358DR", "10", "E2E-LM358"], ["NE555DR", "10", "E2E-NE555"]]) {
    const r = await must("depo", "POST", "/api/receipts", { supplierName: "E2E Elektronik B", lines: [{ itemId: item[mpn], lotNo: lot, qty }] });
    await must("kalite", "POST", `/api/receipt-lines/${r.lines[0].id}/inspection`, { acceptedQty: qty, rejectedQty: "0" });
  }
  check(true, "3 parça kabul edildi ve kaliteden geçti");

  step("8. Üretim: iş emri, malzeme, operasyonlar, test, serbest bırakma");
  const need = (await must("uretim", "GET", "/api/production-needs")).find((n) => n.salesOrderCode === so.code);
  check(Number(need?.qty) === 10, "satış siparişinden 10 adetlik üretim ihtiyacı", need);
  await mustFail("teknisyen", "POST", "/api/work-orders", { productionNeedId: need.id }, undefined, "teknisyen iş emri açamaz");
  const woNew = await must("uretim", "POST", "/api/work-orders", { productionNeedId: need.id, stage: "pilot" }, "iş emri açıldı");
  await must("uretim", "POST", `/api/work-orders/${woNew.id}/release`, undefined, "iş emri yayımlandı (seri numaraları)");
  let wo = await must("uretim", "GET", `/api/work-orders/${woNew.id}`);
  check(wo.devices?.length === 10, "10 seri numarası oluştu", wo.devices?.length);
  const ops = wo.operations.slice().sort((a, b) => a.seq - b.seq);
  await mustFail("teknisyen", "POST", `/api/work-orders/${wo.id}/operations/${ops[1].id}/start`, undefined, "sequence", "operasyon sırası atlanamaz");
  await must("teknisyen", "POST", `/api/work-orders/${wo.id}/operations/${ops[0].id}/start`);
  await mustFail("teknisyen", "POST", `/api/work-orders/${wo.id}/operations/${ops[0].id}/complete`, undefined, "materials_incomplete", "malzeme çıkışı olmadan hazırlık kapanmaz");
  for (const m of wo.materials) {
    const lots = await must("depo", "GET", `/api/lots/lookup?code=${encodeURIComponent({ [item.STM32F103C8T6]: "E2E-MCU-1", [item.GRM188R71H104KA93D]: "E2E-C100N", [item.LM358DR]: "E2E-LM358", [item.NE555DR]: "E2E-NE555" }[m.itemId])}`);
    const usable = lots.find((l) => l.locationType === "usable" || l.inspectionStatus === "accepted" || l.inspectionStatus === "partial") ?? lots[0];
    await must("depo", "POST", `/api/work-orders/${wo.id}/issue`, { lotId: usable.lotId ?? usable.id, qty: String(Number(m.required ?? m.requiredQty ?? m.qty)) }, undefined);
  }
  wo = await must("uretim", "GET", `/api/work-orders/${wo.id}`);
  check(wo.materials.every((m) => m.complete), "4 malzemenin hepsi çıkıldı", wo.materials.map((m) => [m.itemCode, m.issued ?? m.issuedQty, m.complete]));
  for (const op of ops) {
    if (op.isQualityGate) break;
    if (op.seq !== ops[0].seq) await must("teknisyen", "POST", `/api/work-orders/${wo.id}/operations/${op.id}/start`);
    await must("teknisyen", "POST", `/api/work-orders/${wo.id}/operations/${op.id}/complete`);
  }
  const gate = ops.find((o) => o.isQualityGate);
  await must("teknisyen", "POST", `/api/work-orders/${wo.id}/operations/${gate.id}/start`, undefined, "kalite kapısı operasyonu başladı");
  const meas = (v) => [{ name: "3V3", value: v, unit: "V", low: 3.2, high: 3.4 }];
  const serials = wo.devices.map((d) => d.serial);
  await mustFail("teknisyen", "POST", `/api/devices/${serials[9]}/test`, { result: "pass", measurements: meas(2.9) }, "measurement_out_of_limit", "limit dışı ölçümle 'geçti' kaydedilemez");
  for (const s of serials.slice(0, 9)) await must("teknisyen", "POST", `/api/devices/${s}/test`, { result: "pass", measurements: meas(3.3) });
  await must("teknisyen", "POST", `/api/devices/${serials[9]}/test`, { result: "fail", measurements: meas(2.9) }, "10. cihaz kaldı");
  await mustFail("teknisyen", "POST", `/api/work-orders/${wo.id}/operations/${gate.id}/complete`, undefined, "quality_gate", "karar verilmemiş cihaz varken kapı kapanmaz");
  await mustFail("teknisyen", "POST", `/api/devices/${serials[9]}/disposition`, { decision: "scrap", note: "Regülatör" }, undefined, "teknisyen hurda kararı veremez");
  await must("kalite", "POST", `/api/devices/${serials[9]}/disposition`, { decision: "scrap", note: "3V3 regülatör 2,9 V" }, "kalite: hurda");
  await mustFail("kalite", "POST", `/api/work-orders/${wo.id}/release-to-stock`, undefined, "quality_gate", "kapı bitmeden serbest bırakma yok");
  await must("teknisyen", "POST", `/api/work-orders/${wo.id}/operations/${gate.id}/complete`, undefined, "kalite kapısı kapandı");
  for (const op of ops.filter((o) => o.seq > gate.seq)) {
    await must("teknisyen", "POST", `/api/work-orders/${wo.id}/operations/${op.id}/start`);
    await must("teknisyen", "POST", `/api/work-orders/${wo.id}/operations/${op.id}/complete`);
  }
  await must("kalite", "POST", `/api/work-orders/${wo.id}/release-to-stock`, undefined, "son kalite: 9 cihaz serbest");
  wo = await must("uretim", "GET", `/api/work-orders/${wo.id}`);
  check(Number(wo.stats?.released) === 9 && Number(wo.stats?.scrapped ?? wo.stats?.scrap) === 1, "istatistik: 9 serbest, 1 hurda", wo.stats);
  await must("uretim", "POST", `/api/work-orders/${wo.id}/complete`, undefined, "iş emri kapandı");

  step("9. Sevkiyat");
  const order = await must("satis", "GET", `/api/sales-orders/${so.id}`);
  const ship = await must("depo", "POST", `/api/sales-orders/${so.id}/shipments`, { lines: [{ lineId: order.lines[0].id, qty: "9" }] }, "9 adetlik sevkiyat hazırlandı");
  const pkg = (await must("depo", "GET", `/api/shipments/${ship.id}`)).packages[0].id;
  await mustFail("depo", "POST", `/api/packages/${pkg}/items`, { code: serials[9] }, "not_released", "hurda cihaz pakete konamaz");
  for (const s of serials.slice(0, 9)) await must("depo", "POST", `/api/packages/${pkg}/items`, { code: s });
  await mustFail("depo", "POST", `/api/packages/${pkg}/items`, { code: serials[0] }, "already_packed", "aynı seri iki kez okutulamaz");
  await mustFail("depo", "POST", `/api/packages/${pkg}/close`, { checklist: { box: true, accessories: false, label: true, inspection: true } }, undefined, "kontrol listesi eksikken paket kapanmaz");
  await must("depo", "POST", `/api/packages/${pkg}/close`, { checklist: { box: true, accessories: true, label: true, inspection: true }, weightKg: 1.2 }, "paket kapandı");
  await must("depo", "POST", `/api/shipments/${ship.id}/pack-complete`, undefined, "paketleme tamam");
  await must("depo", "POST", `/api/shipments/${ship.id}/ship`, { carrier: "Firma aracı" }, "sevk edildi");
  await must("depo", "POST", `/api/shipments/${ship.id}/delivery`, { outcome: "delivered" }, "teslim edildi");

  step("10. Fatura");
  const inv = await must("muhasebe", "POST", "/api/customer-invoices/from-shipment", { shipmentId: ship.id, taxRate: 20 }, "taslak fatura");
  check(Number(inv.netAmount) === 11250 && Number(inv.taxAmount) === 2250 && Number(inv.grossAmount) === 13500, "9 × 1.250 = 11.250 + %20 KDV 2.250 = 13.500", { net: inv.netAmount, tax: inv.taxAmount, gross: inv.grossAmount });
  const issued = await must("muhasebe", "POST", `/api/customer-invoices/${inv.id}/issue`, { invoiceDate: day(0) }, "fatura kesildi");
  check(/^MF-\d+/.test(issued.code ?? ""), "kesin fatura numarası", issued.code);

  step("11. Kişiler, arama, birebir mesaj");
  await must("satis", "PUT", "/api/presence/status", { status: "busy" });
  await must("depo", "POST", "/api/presence/heartbeat");
  const pres = await must("admin", "GET", "/api/presence");
  const st = (n) => pres.people.find((p) => p.name === `E2E ${n}`)?.status;
  check(st("satis") === "busy" && st("depo") === "available" && st("muhasebe") === "offline", "durumlar: satış meşgul, depo çevrimiçi, muhasebe çevrimdışı", pres.people.map((p) => `${p.name}:${p.status}`));
  const sr = await must("admin", "GET", `/api/search?q=${encodeURIComponent(so.code)}`);
  check(sr.results.some((r) => r.type === "sales_order"), "arama satış siparişini buldu");
  const srDepo = await must("depo", "GET", "/api/search?q=E2E-A");
  check(!srDepo.results.some((r) => r.type === "supplier"), "depo tedarikçi kaydı görmez (yetki)");
  const dm = await must("satis", "POST", "/api/direct-conversations", { userId: (await must("admin", "GET", "/api/me")).user.id });
  await must("satis", "POST", `/api/threads/direct/${dm.id}/messages`, { body: "Kalan 1 kartın termini?" }, "birebir mesaj gönderildi");
  const unread = (await must("admin", "GET", "/api/direct-conversations")).find((c) => c.id === dm.id)?.unread;
  check(unread === 1, "yöneticide 1 okunmamış mesaj", unread);
  await mustFail("arge", "GET", `/api/threads/direct/${dm.id}`, undefined, undefined, "üçüncü kişi birebir konuşmayı göremez");

  step("12. Yönetici parola sıfırlaması");
  const reset = await must("admin", "POST", `/api/admin/users/${users.muhasebe.membershipId}/reset-password`, { reason: "Parolasını unuttu" }, "geçici parola verildi");
  check((await http(null, "POST", "/api/auth/login", { email: users.muhasebe.email, password: users.muhasebe.password })).status === 401, "eski parola geçersiz");
  users.muhasebe.password = reset.temporaryPassword;
  await login("muhasebe");
  check((await http("muhasebe", "GET", "/api/me")).body?.mustChangePassword === true, "geçici parolayla girişte değişim zorunlu");
  await mustFail("admin", "POST", `/api/admin/users/${users.satis.membershipId}/roles`, { roles: ["sales", "subcontractor"] }, undefined, "fason üretici rolü başka rolle verilemez");
}

main()
  .catch((e) => { fails.push(`beklenmeyen: ${e.message}`); console.error(`\n✗ ${e.message}`); })
  .finally(() => {
    console.log(`\n══ Sonuç: ${ok} kontrol geçti, ${fails.length} başarısız (şirket ${CODE}) ══`);
    if (fails.length) { for (const f of fails) console.log(`  ✗ ${f}`); process.exitCode = 1; }
  });
