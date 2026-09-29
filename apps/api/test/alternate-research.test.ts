/**
 * R12 (oturum 41, kalan işler 7d): AI ile pin uyumlu alternatif araştırması (ana talimat §11).
 * Gerçek API ÇAĞRILMAZ: `aiDeps.create` sahte yanıt döner; kategori kurallarının AI çıktısına uygulanışı sınanır.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, setupWorld, type World } from "./helpers";
import { closePool } from "../src/db/pool";
import { aiDeps, DEFAULT_AI_MODEL } from "../src/lib/ai-call";

let w: World;
let A: string;
const RD = "rd@a.test";
const items: Record<string, string> = {};
let sent: Anthropic.Beta.MessageCreateParamsNonStreaming | null = null;

const msg = (body: unknown) =>
  ({ id: "msg_t", type: "message", role: "assistant", model: DEFAULT_AI_MODEL, stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(body), citations: null }] }) as unknown as Anthropic.Beta.BetaMessage;
const mock = (body: unknown) => {
  aiDeps.create = async (p) => { sent = p; return msg(body); };
};
const f = (key: string, status: string, source: string) => ({ key, primary: "a", candidate: "b", status, source, note: "" });
const MOS_KEYS = ["package", "pinout", "polarity", "vds", "id", "rds_on", "vgs_th", "vgs_max", "gate_charge", "temperature"];
const PIN_TABLE = { title: "IRLML-A datasheet s.1 pin tablosu", text: "Pin 1: Gate, Pin 2: Source, Pin 3: Drain. SOT-23. Vds 30V, Id 5.8A, Rds(on) 29mOhm @4.5V." };

beforeAll(async () => {
  clearTokens();
  w = await setupWorld();
  A = w.a.companyId;
  for (const [code, name, mpn, mfr] of [
    ["MOS-A", "N-MOSFET 30V SOT-23", "IRLML-A", "Infineon"],
    ["MOS-B", "N-MOSFET 30V SOT-23 muadil", "AO-B", "AOS"],
    ["MOS-C", "N-MOSFET 30V SOT-23 farklı pin", "XX-C", "Other"],
    ["MCU-A", "MCU 32-bit QFN32", "STM-A", "ST"],
    ["MCU-B", "MCU 32-bit QFN32 muadil", "GD-B", "GigaDevice"],
  ]) {
    items[code] = expectOk(await call(w.app, RD, A, "POST", "/api/items", { code, name, kind: "component", mpn, manufacturer: mfr })).id;
  }
  await w.owner.query("select set_config('app.company_id', $1, false)", [A]);
});

afterEach(() => {
  aiDeps.create = null;
  sent = null;
});

afterAll(async () => {
  await w.app.close();
  await w.owner.end();
  await closePool();
});

describe("AI ile alternatif araştırması (R12)", () => {
  it("kategori kapsamı açık; yetki, aday zorunluluğu ve AI yapılandırması", async () => {
    const cats = expectOk(await call(w.app, "technician@a.test", A, "GET", "/api/alternate-research/categories"));
    expect(cats.categories.map((c: any) => c.key)).toEqual(["resistor", "capacitor", "regulator", "mosfet", "connector", "mcu"]);
    expect(cats.aiAvailable).toBe(false);
    const body = { category: "mosfet", candidateItemIds: [items["MOS-B"]] };
    expect((await call(w.app, "sales@a.test", A, "POST", `/api/items/${items["MOS-A"]}/alternate-research`, body)).status).toBe(403);
    expect((await call(w.app, RD, A, "POST", `/api/items/${items["MOS-A"]}/alternate-research`, { category: "mosfet" })).body.error.code).toBe("no_candidates");
    expect((await call(w.app, RD, A, "POST", `/api/items/${items["MOS-A"]}/alternate-research`, body)).body.error.code).toBe("ai_not_configured");
  });

  let passing: any;
  let mosRunId: string;
  let rejected: any;
  it("MOSFET: belgeli aday geçer; kaynaksız 'uyumlu' kanıt sayılmaz; farklı pin kuralla eler", async () => {
    mock({
      candidates: [
        {
          ref: "C1", summary: "Pin ve elektriksel değerler uyumlu.", testNeeds: ["Anahtarlama kaybı ölçümü"], designChanges: [],
          fields: MOS_KEYS.map((k) => f(k, "compatible", k === "package" ? "D0 s.1" : "DC1 s.2")),
          pinMap: [["1", "Gate"], ["2", "Source"], ["3", "Drain"]].map(([pin, fn]) => ({ pin, primaryFunction: fn, candidateFunction: fn, status: "same", source: "DC1 s.1" })),
        },
        {
          ref: "C2", summary: "Pin dizilimi farklı.", testNeeds: [], designChanges: ["Footprint değişikliği"],
          fields: MOS_KEYS.map((k) => f(k, "compatible", k === "vds" ? "hafıza" : "D0")),
          pinMap: [{ pin: "1", primaryFunction: "Gate", candidateFunction: "Drain", status: "different", source: "D0" }],
        },
      ],
    });
    const run = expectOk(await call(w.app, RD, A, "POST", `/api/items/${items["MOS-A"]}/alternate-research`, {
      category: "mosfet", application: "Yük anahtarı, 3,3 V lojik sürüş", temperature: "-40…85 °C",
      primaryDatasheet: PIN_TABLE, schematic: { title: "Güç kartı şeması", text: "Q1 IRLML-A: G=MCU PA1 üzerinden 100R, S=GND, D=yük." },
      candidateItemIds: [items["MOS-B"], items["MOS-C"]],
      candidateDatasheets: { [items["MOS-B"]]: { title: "AO-B datasheet", text: "Pin 1 Gate, Pin 2 Source, Pin 3 Drain. SOT-23. Vds 30V." } },
    }));
    // Giden istek: şemalı çıktı, sunucu yedek modeli, belgeler kimlikli.
    expect(sent!.model).toBe(DEFAULT_AI_MODEL);
    expect(sent!.output_config?.format).toMatchObject({ type: "json_schema" });
    expect(sent!.system).toContain("rds_on");
    expect(JSON.stringify(sent!.messages)).toContain("--- D0: IRLML-A datasheet");
    expect(JSON.stringify(sent!.messages)).toContain("--- DC1: AO-B datasheet");

    expect(run).toMatchObject({ category: "mosfet", rulesVersion: 1, promptVersion: "alt-research-1", model: DEFAULT_AI_MODEL });
    expect(run.missingInputs).toEqual(expect.arrayContaining(["Hedef adet / tarih", "XX-C: aday datasheet alıntısı"]));
    expect(run.inputs.docs.find((d: any) => d.id === "D0")).toMatchObject({ title: PIN_TABLE.title, chars: PIN_TABLE.text.length });
    expect(run.inputs.docs[0].text).toBeUndefined(); // tam metin saklanmaz

    mosRunId = run.id;
    passing = run.candidates.find((c: any) => c.ref === "C1");
    rejected = run.candidates.find((c: any) => c.ref === "C2");
    expect(passing).toMatchObject({ mpn: "AO-B", source: "item_master", verdict: "candidate", ruleFindings: [] });
    expect(passing.supply).toMatchObject({ freeStock: 0, offer: null });
    expect(rejected.verdict).toBe("rejected_by_rules");
    expect(rejected.fields.find((x: any) => x.key === "vds")).toMatchObject({ status: "insufficient_evidence" });
    expect(rejected.fields.find((x: any) => x.key === "pinout").status).toBe("incompatible");
    expect(rejected.ruleFindings.join(" ")).toMatch(/kaynaksız/);

    const list = expectOk(await call(w.app, "production@a.test", A, "GET", `/api/items/${items["MOS-A"]}/alternate-research`));
    expect(list[0]).toMatchObject({ category: "mosfet", candidates: 2, passing: 1 });
    await expect(w.owner.query(`update alternate_research_candidates set verdict = 'candidate'`)).rejects.toThrow(/append/i);
  });

  it("insan kararı: elenen aday öneri olamaz; geçen aday Ar-Ge + üretim onay akışına girer", async () => {
    expect((await call(w.app, RD, A, "POST", `/api/alternate-research/candidates/${rejected.id}/propose`, { reason: "Denemek istiyoruz, footprint değişir" })).body.error.code).toBe("rejected_by_rules");
    const alt = expectOk(await call(w.app, RD, A, "POST", `/api/alternate-research/candidates/${passing.id}/propose`, { reason: "Tedarik riski nedeniyle ikinci kaynak" }));
    expect(alt).toMatchObject({ status: "proposed", origin: "ai_research", pinCompatible: true, footprintSame: true, alternateMpn: "AO-B" });
    expect(alt.missingApprovals).toEqual(["rd", "production"]);
    expect(alt.evidence).toContain("karar: candidate");
    expect((await call(w.app, RD, A, "POST", `/api/alternate-research/candidates/${passing.id}/propose`, { reason: "Tekrar öneri denemesi" })).body.error.code).toBe("alternate_exists");
    const run = expectOk(await call(w.app, RD, A, "GET", `/api/alternate-research/${mosRunId}`));
    expect(run.candidates.find((c: any) => c.ref === "C1").proposalId).toBe(alt.id);
  });

  it("MCU: pin/kılıf uyumu firmware uyumu sayılmaz; şema yoksa uygulamaya uygunluk kesinleşmez", async () => {
    const keys = ["package", "pinout", "core", "memory", "peripherals", "supply", "clock", "firmware", "temperature"];
    mock({
      candidates: [{
        ref: "C1", summary: "Pin uyumlu klon.", testNeeds: [], designChanges: [],
        fields: keys.map((k) => f(k, "compatible", "DC1 s.10")),
        pinMap: [{ pin: "1", primaryFunction: "VDD", candidateFunction: "VDD", status: "same", source: "DC1 s.10" }],
      }],
    });
    const run = expectOk(await call(w.app, RD, A, "POST", `/api/items/${items["MCU-A"]}/alternate-research`, {
      category: "mcu", candidateItemIds: [items["MCU-B"]],
      primaryDatasheet: { title: "STM-A pin tablosu", text: "Pin 1 VDD, Pin 2 PA0 … QFN32 pinout tablosu, 64KB flash." },
      candidateDatasheets: { [items["MCU-B"]]: { title: "GD-B pin tablosu", text: "Pin 1 VDD, Pin 2 PA0 … QFN32, 64KB flash." } },
    }));
    const c = run.candidates[0];
    expect(c.verdict).toBe("insufficient_evidence");
    expect(c.fields.find((x: any) => x.key === "firmware")).toMatchObject({ status: "insufficient_evidence" });
    expect(c.fields.find((x: any) => x.key === "application_fit")).toMatchObject({ status: "insufficient_evidence" });
    expect(c.ruleFindings.join(" ")).toMatch(/Firmware/);
    expect(run.missingInputs).toEqual(expect.arrayContaining(["Firmware / çevre birimi / bellek gereksinimleri", "Şema / netlist (uygulamaya özel uygunluk için)"]));
  });

  it("desteklenmeyen kategori yalnız araştırma adayı; dış aday kalem kartı olmadan öneri olamaz", async () => {
    mock({ candidates: [{ ref: "X1", summary: "Benzer sensör.", testNeeds: [], designChanges: [], fields: [f("range", "compatible", "DX1")], pinMap: [] }] });
    const run = expectOk(await call(w.app, RD, A, "POST", `/api/items/${items["MOS-A"]}/alternate-research`, {
      category: "sensor", externalCandidates: [{ mpn: "SEN-X", manufacturer: "Acme", datasheet: { title: "SEN-X datasheet", text: "Ölçüm aralığı ve pin tablosu burada yer alıyor." } }],
    }));
    const c = run.candidates[0];
    expect(c).toMatchObject({ ref: "X1", source: "user_supplied", candidateItemId: null, verdict: "research_only" });
    expect(c.ruleFindings[0]).toContain("doğrulanmış kural kapsamında değil");
    expect((await call(w.app, RD, A, "POST", `/api/alternate-research/candidates/${c.id}/propose`, { reason: "Dış aday denemesi yapılacak" })).body.error.code).toBe("item_required");
  });
});
