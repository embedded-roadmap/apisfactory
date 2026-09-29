/**
 * R29 (oturum 41, kalan işler 7c): kaynak kapasitesi ve vardiya.
 * Vardiya şablonu, iş merkezine istasyonlu atama, tarihli istisna, tatil; termin/senaryo aynı takvimi kullanır;
 * kaynak yükü açık operasyonları sonlu kapasiteyle yükler.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, setupWorld, type World } from "./helpers";
import { closePool } from "../src/db/pool";

let w: World;
let A: string;
let revA: string;
const P = "production@a.test";
const M = "manager@a.test";
const mapping = { refdes: "Designator", manufacturer: "Manufacturer", mpn: "MPN", qty: "Quantity", description: "Description", dnp: "DNP" };
const today = new Date().toISOString().slice(0, 10);
const addDays = (s: string, n: number) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const isoWd = (s: string) => ((new Date(`${s}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
/** `from` dahil sonraki ilk verilen hafta günü (1 = Pzt). */
const nextWd = (from: string, wd: number) => { let d = from; while (isoWd(d) !== wd) d = addDays(d, 1); return d; };
const monday = nextWd(addDays(today, 1), 1);
const tuesday = addDays(monday, 1);
const wednesday = addDays(monday, 2);
const thursday = addDays(monday, 3);
const saturday = addDays(monday, 5);
const sunday = addDays(monday, 6);
let gunduz: string;
let gece: string;
let smtAssignment: string;

const load = async (from: string, to: string) => expectOk(await call(w.app, P, A, "GET", `/api/capacity/load?from=${from}&to=${to}`));
const dayOf = (l: any, code: string, day: string) => l.workCenters.find((x: any) => x.code === code).days.find((d: any) => d.day === day);
const scenario = async () => expectOk(await call(w.app, M, A, "POST", "/api/scenarios", { name: "Kapasite testi", productRevisionId: revA, qty: "900" })).result.baseline;

beforeAll(async () => {
  clearTokens();
  w = await setupWorld();
  A = w.a.companyId;
  const productId = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/products", { code: "KP-1", name: "Kapasite kartı" })).id;
  const csv = ["Designator;Manufacturer;MPN;Quantity;Description;DNP", "U1;TestSemi;MCU-K;1;MCU;"].join("\n");
  const prev = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/imports/bom/preview", { productId, fileName: "k.csv", content: csv, mapping }));
  const bom = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/imports/${prev.jobId}/commit`, {})).bomVersionId;
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/boms/${bom}/publish`));
  revA = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/products/${productId}/revisions`, { rev: "A", bomVersionId: bom })).id;
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/revisions/${revA}/transition`, { action: "submit_handover" }));
  for (const [u, area] of [["rd", "rd"], ["production", "production"], ["quality", "quality"]]) {
    expectOk(await call(w.app, `${u}@a.test`, A, "POST", `/api/revisions/${revA}/handover`, { area, decision: "approve" }));
  }
  expectOk(await call(w.app, P, A, "PUT", "/api/work-centers/SMT", { dailyMinutes: 450, setupMinutes: 60, minutesPerUnit: 1 }));
  // Stok: senaryoda malzeme hazır olsun (temin süresi tanımsız kalemi "hesaplanamadı" yapmasın).
  const sp = expectOk(await call(w.app, "warehouse@a.test", A, "POST", "/api/imports/stock/preview", {
    fileName: "k.csv", content: "kod,miktar,lot,konum\nCMP-TESTSEMI-MCU-K,5000,MK-1,STK", mapping: { itemCode: "kod", qty: "miktar", lotNo: "lot", locationCode: "konum" },
  }));
  expectOk(await call(w.app, "warehouse@a.test", A, "POST", `/api/imports/${sp.jobId}/commit`, {}));
  await w.owner.query("select set_config('app.company_id', $1, false)", [A]);
});

afterAll(async () => {
  await w.app.close();
  await w.owner.end();
  await closePool();
});

describe("Vardiya ve kaynak kapasitesi (R29)", () => {
  it("vardiya şablonu: net süre (mola düşülür, gece yarısını geçebilir); yetki ve geçersiz süre", async () => {
    const body = { code: "GUNDUZ", name: "Gündüz", startTime: "08:00", endTime: "16:30", breakMinutes: 30, weekdays: [1, 2, 3, 4, 5, 6] };
    expect((await call(w.app, "technician@a.test", A, "POST", "/api/shift-patterns", body)).status).toBe(403);
    expect((await call(w.app, P, A, "POST", "/api/shift-patterns", { ...body, code: "X", breakMinutes: 600 })).body.error.code).toBe("invalid_shift");
    expect((await call(w.app, P, A, "POST", "/api/shift-patterns", { ...body, code: "Y", startTime: "25:00" })).status).toBe(400);
    const g = expectOk(await call(w.app, P, A, "POST", "/api/shift-patterns", body));
    expect(g.netMinutes).toBe(480);
    gunduz = g.id;
    const n = expectOk(await call(w.app, P, A, "POST", "/api/shift-patterns", { code: "GECE", name: "Gece", startTime: "22:00", endTime: "06:00", breakMinutes: 0, weekdays: [1, 2, 3, 4, 5] }));
    expect(n.netMinutes).toBe(480);
    gece = n.id;
    const list = expectOk(await call(w.app, "technician@a.test", A, "GET", "/api/shift-patterns"));
    expect(list.map((s: any) => [s.code, s.startTime, s.endTime, s.netMinutes])).toEqual([["GECE", "22:00", "06:00", 480], ["GUNDUZ", "08:00", "16:30", 480]]);
    // Şirket izolasyonu
    expect(expectOk(await call(w.app, "all@b.test", w.b.companyId, "GET", "/api/shift-patterns"))).toHaveLength(0);
  });

  it("vardiyası olmayan merkez eski davranışta: hafta içi günlük dakika, hafta sonu 0", async () => {
    const l = await load(monday, sunday);
    expect(l.workCenters.find((x: any) => x.code === "SMT").source).toBe("default");
    expect(dayOf(l, "SMT", monday).available).toBe(450);
    expect(dayOf(l, "SMT", saturday).available).toBe(0);
    expect(dayOf(l, "SMT", sunday).available).toBe(0);
  });

  it("atama: vardiya × istasyon; cumartesi vardiyası; çakışan atama reddi; termin/senaryo aynı takvimi kullanır", async () => {
    const before = await scenario();
    const smtBefore = before.productionDays;
    smtAssignment = expectOk(await call(w.app, P, A, "POST", "/api/work-center-shifts", { workCenterCode: "SMT", shiftPatternId: gunduz, stations: 2, validFrom: addDays(today, -7), reason: "İki hat, tek vardiya" })).id;
    const dup = await call(w.app, P, A, "POST", "/api/work-center-shifts", { workCenterCode: "SMT", shiftPatternId: gunduz, stations: 1, validFrom: today, reason: "tekrar" });
    expect(dup.body.error.code).toBe("overlapping_shift");
    // SMT 900 adet: 60 + 900 × 1 = 960 dk → 450 dk/gün ile 3 gün, 2 × 480 = 960 dk/gün ile 1 gün.
    const after = await scenario();
    expect(before.productionDays - after.productionDays).toBe(2);
    expect(smtBefore).toBeGreaterThan(after.productionDays);
    // Yalnız SMT etkisi ölçüldükten sonra TST'ye gece vardiyası.
    expectOk(await call(w.app, P, A, "POST", "/api/work-center-shifts", { workCenterCode: "TST", shiftPatternId: gece, validFrom: addDays(today, -7), reason: "Gece testi" }));

    const l = await load(monday, sunday);
    const smt = l.workCenters.find((x: any) => x.code === "SMT");
    expect(smt.source).toBe("shifts");
    expect(dayOf(l, "SMT", monday).available).toBe(960);
    expect(dayOf(l, "SMT", saturday).available).toBe(960);
    expect(dayOf(l, "SMT", sunday).available).toBe(0);
    expect(dayOf(l, "TST", monday).available).toBe(480); // 22:00–06:00, başladığı güne
    expect(dayOf(l, "TST", saturday).available).toBe(0);
  });

  it("istisna (fazla mesai / bakım) ve tatil gün kapasitesini değiştirir; istisna değişmez", async () => {
    expect((await call(w.app, "technician@a.test", A, "POST", "/api/capacity-exceptions", { workCenterCode: "SMT", day: monday, minutesDelta: -300, reason: "Bakım" })).status).toBe(403);
    expect((await call(w.app, P, A, "POST", "/api/capacity-exceptions", { workCenterCode: "SMT", day: monday, minutesDelta: 0, reason: "sıfır" })).status).toBe(400);
    expectOk(await call(w.app, P, A, "POST", "/api/capacity-exceptions", { workCenterCode: "SMT", day: monday, minutesDelta: -300, reason: "Fırın bakımı" }));
    expectOk(await call(w.app, P, A, "POST", "/api/capacity-exceptions", { day: monday, minutesDelta: 120, reason: "Tüm merkezlerde fazla mesai" }));
    expectOk(await call(w.app, P, A, "POST", "/api/holidays", { day: tuesday, name: "Tatil" }));
    const l = await load(monday, sunday);
    expect(dayOf(l, "SMT", monday).available).toBe(780); // 960 − 300 + 120
    expect(dayOf(l, "HAZ", monday).available).toBe(570); // varsayılan 450 + 120
    expect(dayOf(l, "SMT", tuesday).available).toBe(0);
    await expect(w.owner.query(`update capacity_exceptions set minutes_delta = 1`)).rejects.toThrow(/append/i);
    const ex = expectOk(await call(w.app, "technician@a.test", A, "GET", `/api/capacity-exceptions?from=${monday}`));
    expect(ex.map((e: any) => [e.workCenterCode, e.minutesDelta])).toEqual([[null, 120], ["SMT", -300]]);
  });

  it("kaynak yükü: açık iş emri operasyonu kapasiteye yüklenir; atama sonlanınca kapasite düşer", async () => {
    const wo = expectOk(await call(w.app, P, A, "POST", "/api/work-orders", { productRevisionId: revA, qty: "10" }));
    const smtOp = wo.operations.find((o: any) => o.workCenter === "SMT");
    expect(smtOp.plannedMinutes).toBe(70);
    const l = await load(today, addDays(today, 13));
    const smt = l.workCenters.find((x: any) => x.code === "SMT");
    expect(smt.openMinutes).toBe(70);
    expect(smt.load).toBe(70);
    expect(smt.overflowMinutes).toBe(0);
    const loadedDay = smt.days.find((d: any) => d.load > 0);
    expect(loadedDay.items[0]).toMatchObject({ woCode: wo.code, minutes: 70 });
    expect(loadedDay.available).toBeGreaterThan(0);

    expect((await call(w.app, P, A, "POST", `/api/work-center-shifts/${smtAssignment}/end`, { validTo: addDays(today, -30), reason: "geçersiz" })).body.error.code).toBe("invalid_range");
    expectOk(await call(w.app, P, A, "POST", `/api/work-center-shifts/${smtAssignment}/end`, { validTo: wednesday, reason: "Tek hatta dönüldü" }));
    expect((await call(w.app, P, A, "POST", `/api/work-center-shifts/${smtAssignment}/end`, { validTo: wednesday, reason: "tekrar" })).body.error.code).toBe("already_ended");
    const l2 = await load(monday, sunday);
    expect(dayOf(l2, "SMT", wednesday).available).toBe(960);
    expect(dayOf(l2, "SMT", thursday).available).toBe(0); // vardiya tanımlı merkezde geçerli atama yok → kapasite yok
    const hist = expectOk(await call(w.app, P, A, "GET", "/api/work-center-shifts"));
    expect(hist.find((a: any) => a.id === smtAssignment)).toMatchObject({ validTo: wednesday });
  });
});
