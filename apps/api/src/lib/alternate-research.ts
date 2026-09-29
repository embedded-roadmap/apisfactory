import { z } from "zod";
import { AppError } from "./errors";
import { callStructured } from "./ai-call";

/**
 * R12 — AI ile pin uyumlu alternatif araştırması (ana talimat §11).
 *
 * AI yalnız VERİLEN belgelerden (birincil/aday datasheet alıntıları, pin tabloları, kalem kartı) alan alan karşılaştırma
 * çıkarır. Sonra sürümlü, deterministik KATEGORİ KURALLARI uygulanır ve karar bu kurallarla verilir:
 *  - Kaynağı verilen belgelerden biri olmayan "uyumlu" alan → "kanıt yetersiz" (modelin hafızası kanıt değildir).
 *  - Kategorinin kritik alanlarından biri uyumsuz → "kuralla elendi"; kanıt yetersiz → "kanıt yetersiz"; hepsi uyumlu → "aday".
 *  - Pin tablosu gereken kategoride her birincil pinin eşlemesi olmalı; farklı/bilinmeyen pin → pin uyumu uyumsuz/yetersiz.
 *  - MCU: firmware kanıtı (kullanıcı girdisi) yoksa firmware/register uyumu her zaman "kanıt yetersiz" — pin/kılıf benzerliği
 *    "firmware değişmez" sonucu vermez.
 *  - Şema/netlist verilmemişse "uygulamaya uygunluk" her zaman "kanıt yetersiz".
 *  - Desteklenmeyen kategori → "araştırma adayı" (doğrulanmış kapsam dışında).
 * Güven yüzdesi üretilmez. Aday yalnız insan kararıyla mevcut onay akışına (item_alternates) öneri olarak girer.
 */

export const RULES_VERSION = 1;
export const PROMPT_VERSION = "alt-research-1";

type Rule = { label: string; critical: { key: string; label: string }[]; pinout: boolean };

export const CATEGORY_RULES: Record<string, Rule> = {
  resistor: {
    label: "Direnç",
    pinout: false,
    critical: [
      { key: "package", label: "Kılıf / footprint" }, { key: "value", label: "Değer" }, { key: "tolerance", label: "Tolerans" },
      { key: "power", label: "Güç" }, { key: "voltage", label: "Çalışma gerilimi" }, { key: "tempco", label: "Sıcaklık katsayısı" },
      { key: "temperature", label: "Çalışma sıcaklığı" },
    ],
  },
  capacitor: {
    label: "Kondansatör",
    pinout: false,
    critical: [
      { key: "package", label: "Kılıf / footprint" }, { key: "value", label: "Kapasite" }, { key: "tolerance", label: "Tolerans" },
      { key: "voltage", label: "Anma gerilimi" }, { key: "dielectric", label: "Dielektrik / tip" }, { key: "temperature", label: "Çalışma sıcaklığı" },
    ],
  },
  regulator: {
    label: "Regülatör (LDO / anahtarlamalı)",
    pinout: true,
    critical: [
      { key: "package", label: "Kılıf / footprint" }, { key: "pinout", label: "Pin dizilimi" }, { key: "vin", label: "Giriş gerilimi aralığı" },
      { key: "vout", label: "Çıkış gerilimi" }, { key: "iout", label: "Çıkış akımı" }, { key: "dropout_efficiency", label: "Düşüm / verim" },
      { key: "stability", label: "Kararlılık (çıkış kondansatörü / ESR)" }, { key: "enable_logic", label: "Enable mantığı" },
      { key: "thermal", label: "Isıl direnç" }, { key: "temperature", label: "Çalışma sıcaklığı" },
    ],
  },
  mosfet: {
    label: "MOSFET",
    pinout: true,
    critical: [
      { key: "package", label: "Kılıf / footprint" }, { key: "pinout", label: "Pin dizilimi (G/D/S)" }, { key: "polarity", label: "Kanal (N/P)" },
      { key: "vds", label: "Vds" }, { key: "id", label: "Id" }, { key: "rds_on", label: "Rds(on) @ Vgs" }, { key: "vgs_th", label: "Vgs(th)" },
      { key: "vgs_max", label: "Vgs maks." }, { key: "gate_charge", label: "Kapı yükü" }, { key: "temperature", label: "Çalışma sıcaklığı" },
    ],
  },
  connector: {
    label: "Konnektör",
    pinout: true,
    critical: [
      { key: "footprint", label: "Footprint" }, { key: "pinout", label: "Pin sayısı / dizilim" }, { key: "pitch", label: "Adım (pitch)" },
      { key: "mating", label: "Karşı parça uyumu" }, { key: "current", label: "Akım" }, { key: "keying", label: "Mekanik kilit / yön" },
    ],
  },
  mcu: {
    label: "Mikrodenetleyici",
    pinout: true,
    critical: [
      { key: "package", label: "Kılıf / footprint" }, { key: "pinout", label: "Pin işlevleri" }, { key: "core", label: "Çekirdek / mimari" },
      { key: "memory", label: "Flash / RAM" }, { key: "peripherals", label: "Çevre birimleri" }, { key: "supply", label: "Besleme" },
      { key: "clock", label: "Saat" }, { key: "firmware", label: "Firmware / register uyumu" }, { key: "temperature", label: "Çalışma sıcaklığı" },
    ],
  },
};
export const SUPPORTED_CATEGORIES = Object.keys(CATEGORY_RULES);

export type Doc = { id: string; title: string; text: string };
export type ResearchInput = {
  category: string;
  primary: { mpn: string | null; manufacturer: string | null; name: string; lifecycle: string | null };
  application: string | null;
  temperature: string | null;
  targetQty: string | null;
  schematicProvided: boolean;
  firmwareEvidence: string | null;
  docs: Doc[];
  candidates: { ref: string; mpn: string | null; manufacturer: string | null; name: string; docIds: string[] }[];
};

const STATUS = ["compatible", "incompatible", "insufficient_evidence"] as const;
const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          ref: { type: "string" },
          fields: {
            type: "array",
            items: {
              type: "object",
              properties: {
                key: { type: "string" }, primary: { type: "string" }, candidate: { type: "string" },
                status: { type: "string", enum: [...STATUS] }, source: { type: "string" }, note: { type: "string" },
              },
              required: ["key", "primary", "candidate", "status", "source", "note"],
              additionalProperties: false,
            },
          },
          pinMap: {
            type: "array",
            items: {
              type: "object",
              properties: {
                pin: { type: "string" }, primaryFunction: { type: "string" }, candidateFunction: { type: "string" },
                status: { type: "string", enum: ["same", "different", "unknown"] }, source: { type: "string" },
              },
              required: ["pin", "primaryFunction", "candidateFunction", "status", "source"],
              additionalProperties: false,
            },
          },
          testNeeds: { type: "array", items: { type: "string" } },
          designChanges: { type: "array", items: { type: "string" } },
          summary: { type: "string" },
        },
        required: ["ref", "fields", "pinMap", "testNeeds", "designChanges", "summary"],
        additionalProperties: false,
      },
    },
  },
  required: ["candidates"],
  additionalProperties: false,
} as const;

const Field = z.object({ key: z.string(), primary: z.string(), candidate: z.string(), status: z.enum(STATUS), source: z.string(), note: z.string() });
const Pin = z.object({ pin: z.string(), primaryFunction: z.string(), candidateFunction: z.string(), status: z.enum(["same", "different", "unknown"]), source: z.string() });
const Output = z.object({
  candidates: z.array(z.object({ ref: z.string(), fields: z.array(Field), pinMap: z.array(Pin), testNeeds: z.array(z.string()), designChanges: z.array(z.string()), summary: z.string() })),
});
export type AiCandidate = z.infer<typeof Output>["candidates"][number];

function systemPrompt(rule: Rule | undefined) {
  const keys = rule ? rule.critical.map((c) => `${c.key} (${c.label})`).join(", ") : "kategoriye uygun kritik alanlar";
  return `Bir elektronik üretim şirketinde Ar-Ge mühendisine alternatif komponent karşılaştırması hazırlıyorsun.
Sana birincil parça, aday parçalar ve BELGELER (kimlikli datasheet alıntıları, pin tabloları, kalem kartı) verilecek.
Kurallar:
- Yalnız verilen belgelere dayan. Her alanın "source" değeri belge kimliği ve mümkünse sayfa/tablo olsun (ör. "D2 s.4 Tablo 3"). Belgede yoksa "source" boş, durum "insufficient_evidence".
- Hafızandan değer, pin işlevi veya MPN uydurma. Aday listesine yeni parça ekleme; yalnız verilen adayları karşılaştır.
- Her aday için şu alanları değerlendir: ${keys}. Anahtarları aynen kullan.
- Pin eşlemesi: birincil parçanın her pini için adaydaki işlevi yaz (pin tablosu yoksa boş bırak).
- Firmware/register uyumunu yalnız firmware kanıtı verilmişse değerlendir; pin/kılıf benzerliği firmware uyumu kanıtı değildir.
- Güven yüzdesi verme. Belirsizliği "insufficient_evidence" olarak işaretle ve notta neyin eksik olduğunu yaz.
- testNeeds: onaydan önce gereken doğrulama testleri; designChanges: gerekiyorsa tasarım/footprint/firmware değişiklikleri. Türkçe yaz.`;
}

/** Kategori kurallarını AI çıktısına uygular; karar ve kural bulguları deterministiktir. */
export function applyRules(input: ResearchInput, ai: AiCandidate | undefined) {
  const rule = CATEGORY_RULES[input.category];
  const docIds = new Set([...input.docs.map((d) => d.id), "IM"]);
  const findings: string[] = [];
  if (!rule) {
    return {
      verdict: "research_only" as const, fields: ai?.fields ?? [], pinMap: ai?.pinMap ?? [],
      findings: [`"${input.category}" kategorisi doğrulanmış kural kapsamında değil (desteklenen: ${SUPPORTED_CATEGORIES.join(", ")}); sonuç yalnız araştırma adayıdır.`],
    };
  }
  if (!ai) {
    return { verdict: "insufficient_evidence" as const, fields: [], pinMap: [], findings: ["AI bu aday için karşılaştırma döndürmedi."] };
  }
  const fields = rule.critical.map((c) => {
    const f = ai.fields.find((x) => x.key === c.key);
    if (!f) {
      findings.push(`${c.label}: AI çıktısında yok → kanıt yetersiz`);
      return { key: c.key, label: c.label, primary: "", candidate: "", status: "insufficient_evidence" as const, source: "", note: "Değerlendirilmedi" };
    }
    let status: (typeof STATUS)[number] = f.status;
    let note = f.note;
    const cited = f.source.trim().split(/[\s,;]+/)[0] ?? "";
    if (status === "compatible" && !docIds.has(cited)) {
      status = "insufficient_evidence";
      note = `Kaynak verilen belgelerden biri değil ("${f.source}") — kural ${RULES_VERSION}: kaynaksız uyum kabul edilmez. ${note}`.trim();
      findings.push(`${c.label}: kaynaksız "uyumlu" → kanıt yetersiz`);
    }
    if (input.category === "mcu" && c.key === "firmware" && !input.firmwareEvidence && status !== "insufficient_evidence") {
      status = "insufficient_evidence";
      note = `Firmware kanıtı verilmedi — pin/kılıf benzerliği firmware uyumu kanıtı değildir. ${note}`.trim();
      findings.push("Firmware / register uyumu: firmware kanıtı yok → kanıt yetersiz");
    }
    return { key: c.key, label: c.label, primary: f.primary, candidate: f.candidate, status, source: f.source, note };
  });
  if (rule.pinout) {
    const pf = fields.find((f) => f.key === "pinout")!;
    const pins = ai.pinMap;
    if (!pins.length) {
      if (pf.status === "compatible") {
        pf.status = "insufficient_evidence";
        pf.note = `Pin eşlemesi yok. ${pf.note}`.trim();
        findings.push("Pin dizilimi: pin eşlemesi olmadan uyumlu sayılmaz");
      }
    } else if (pins.some((p) => p.status === "different")) {
      if (pf.status !== "incompatible") findings.push("Pin dizilimi: farklı işlevli pin var → uyumsuz");
      pf.status = "incompatible";
    } else if (pins.some((p) => p.status === "unknown" || !docIds.has((p.source.trim().split(/[\s,;]+/)[0] ?? "")))) {
      if (pf.status === "compatible") {
        pf.status = "insufficient_evidence";
        findings.push("Pin dizilimi: belirsiz veya kaynaksız pin var → kanıt yetersiz");
      }
    }
  }
  const applicationFit = input.schematicProvided
    ? null
    : { key: "application_fit", label: "Uygulamaya uygunluk", primary: "", candidate: "", status: "insufficient_evidence" as const, source: "", note: "Şema/netlist verilmedi; uygulamaya özel uygunluk kesinleştirilemez." };
  const all = applicationFit ? [...fields, applicationFit] : fields;
  const verdict = fields.some((f) => f.status === "incompatible")
    ? ("rejected_by_rules" as const)
    : all.some((f) => f.status === "insufficient_evidence")
      ? ("insufficient_evidence" as const)
      : ("candidate" as const);
  return { verdict, fields: all, pinMap: ai.pinMap, findings };
}

/** Eksik girdiler (§11 "Eksik girdileri açık göster"). */
export function missingInputs(input: ResearchInput) {
  const out: string[] = [];
  if (!input.primary.mpn) out.push("Birincil parçanın tam MPN'si");
  if (!input.primary.manufacturer) out.push("Birincil parçanın üreticisi");
  if (!input.docs.some((d) => d.id === "D0")) out.push("Birincil parça datasheet alıntısı (sürümüyle)");
  if (CATEGORY_RULES[input.category]?.pinout && !input.docs.some((d) => /pin/i.test(d.title) || /pin/i.test(d.text.slice(0, 400)))) out.push("Pin tablosu");
  if (!input.application) out.push("Uygulamadaki işlev");
  if (!input.temperature) out.push("Sıcaklık aralığı");
  if (!input.schematicProvided) out.push("Şema / netlist (uygulamaya özel uygunluk için)");
  if (input.category === "mcu" && !input.firmwareEvidence) out.push("Firmware / çevre birimi / bellek gereksinimleri");
  if (!input.targetQty) out.push("Hedef adet / tarih");
  for (const c of input.candidates) if (!c.docIds.length) out.push(`${c.mpn ?? c.name}: aday datasheet alıntısı`);
  return out;
}

export async function runAiComparison(input: ResearchInput) {
  const rule = CATEGORY_RULES[input.category];
  const user = [
    `Kategori: ${rule?.label ?? input.category} (kural sürümü ${RULES_VERSION})`,
    `Birincil parça: ${JSON.stringify(input.primary)}`,
    `Uygulamadaki işlev: ${input.application ?? "verilmedi"}; sıcaklık: ${input.temperature ?? "verilmedi"}; hedef: ${input.targetQty ?? "verilmedi"}`,
    `Şema/netlist: ${input.schematicProvided ? "verildi (belgelerde)" : "verilmedi"}`,
    `Firmware kanıtı: ${input.firmwareEvidence ?? "verilmedi"}`,
    `Adaylar (ref = kimlik; docIds = adayın belgeleri): ${JSON.stringify(input.candidates)}`,
    `Belgeler ("IM" = kalem kartı, yukarıdaki parça bilgileri):`,
    ...input.docs.map((d) => `--- ${d.id}: ${d.title} ---\n${d.text}`),
  ].join("\n");
  const { model, text } = await callStructured({ system: systemPrompt(rule), user, schema: OUTPUT_SCHEMA as unknown as Record<string, unknown> });
  let parsed: z.infer<typeof Output>;
  try {
    parsed = Output.parse(JSON.parse(text));
  } catch {
    throw new AppError(502, "ai_bad_output", "AI yanıtı beklenen biçimde değil");
  }
  return { model, candidates: parsed.candidates };
}
