import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, post } from "../lib/api";
import { Empty, ErrorNotice, Loading, useCan } from "../lib/ui";
import { ItemPicker } from "./ItemPicker";

const VERDICT: Record<string, [string, string]> = {
  candidate: ["Aday (kurallardan geçti)", "ok"],
  insufficient_evidence: ["Kanıt yetersiz", "warn"],
  rejected_by_rules: ["Kuralla elendi", "bad"],
  research_only: ["Araştırma adayı (kapsam dışı kategori)", "warn"],
};
const STATUS: Record<string, [string, string]> = {
  compatible: ["uyumlu", "ok"],
  incompatible: ["uyumsuz", "bad"],
  insufficient_evidence: ["kanıt yetersiz", "warn"],
};
type Doc = { title: string; text: string };
const emptyDoc: Doc = { title: "", text: "" };
const docOrUndef = (d: Doc) => (d.text.trim().length >= 20 ? { title: d.title.trim() || "Belge", text: d.text } : undefined);

/** R12 — "AI'ya sor / Alternatif bul": verilen belgelerle alan alan karşılaştırma + sürümlü kategori kuralları. */
export function AlternateResearch({ onProposed }: { onProposed: () => void }) {
  const can = useCan();
  const qc = useQueryClient();
  const cats = useQuery({ queryKey: ["altResearchCats"], queryFn: () => get<any>("/api/alternate-research/categories") });
  const [item, setItem] = useState<any | null>(null);
  const [category, setCategory] = useState("mosfet");
  const [f, setF] = useState({ application: "", temperature: "", targetQty: "", firmwareEvidence: "" });
  const [primaryDs, setPrimaryDs] = useState<Doc>(emptyDoc);
  const [schematic, setSchematic] = useState<Doc>(emptyDoc);
  const [cands, setCands] = useState<{ item: any; ds: Doc }[]>([]);
  const [picker, setPicker] = useState<any | null>(null);
  const [ext, setExt] = useState<{ mpn: string; manufacturer: string; ds: Doc }[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const runs = useQuery({ queryKey: ["altResearchRuns", item?.id], queryFn: () => get<any[]>(`/api/items/${item.id}/alternate-research`), enabled: !!item });
  const run = useQuery({ queryKey: ["altResearch", runId], queryFn: () => get<any>(`/api/alternate-research/${runId}`), enabled: !!runId });

  const start = useMutation({
    mutationFn: () => post<any>(`/api/items/${item.id}/alternate-research`, {
      category,
      application: f.application || undefined, temperature: f.temperature || undefined, targetQty: f.targetQty || undefined,
      firmwareEvidence: f.firmwareEvidence || undefined,
      primaryDatasheet: docOrUndef(primaryDs), schematic: docOrUndef(schematic),
      candidateItemIds: cands.map((c) => c.item.id),
      candidateDatasheets: Object.fromEntries(cands.flatMap((c) => { const d = docOrUndef(c.ds); return d ? [[c.item.id, d]] : []; })),
      externalCandidates: ext.map((x) => ({ mpn: x.mpn, manufacturer: x.manufacturer, datasheet: docOrUndef(x.ds) })),
    }),
    onSuccess: (r) => { setRunId(r.id); qc.invalidateQueries({ queryKey: ["altResearchRuns", item?.id] }); },
  });

  if (!can("product.create") && !can("product.approve.production")) return null;
  const pinCats = new Set((cats.data?.categories ?? []).filter((c: any) => c.pinout).map((c: any) => c.key));

  return (
    <section className="card">
      <h2>AI'ya sor — alternatif araştırması</h2>
      <p className="muted" style={{ margin: 0 }}>
        AI yalnız burada verdiğiniz belgelerle (datasheet alıntısı, pin tablosu, şema) karşılaştırır; kaynak göstermediği "uyumlu" sonuç kanıt sayılmaz.
        Karar sürümlü kategori kurallarıyla verilir (kural v{cats.data?.rulesVersion ?? "?"}); güven yüzdesi yoktur. Aday ancak sizin kararınızla Ar-Ge + üretim onayına öneri olarak gider.
      </p>
      {cats.data && !cats.data.aiAvailable ? <div className="notice warn">AI sağlayıcısı yapılandırılmadı (ANTHROPIC_API_KEY). Araştırma başlatılamaz.</div> : null}
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); start.mutate(); }}>
        <div className="row" style={{ alignItems: "flex-start" }}>
          <ItemPicker label="Birincil parça" value={item} onChange={(i) => { setItem(i); setRunId(null); }} />
          <label className="field">Kategori
            <select aria-label="Parça kategorisi" value={category} onChange={(e) => setCategory(e.target.value)}>
              {(cats.data?.categories ?? []).map((c: any) => <option key={c.key} value={c.key}>{c.label}</option>)}
              <option value="other">Diğer (kapsam dışı — yalnız araştırma adayı)</option>
            </select>
          </label>
          <label className="field" style={{ flex: 1 }}>Uygulamadaki işlev<input aria-label="Uygulamadaki işlev" value={f.application} onChange={(e) => setF({ ...f, application: e.target.value })} /></label>
          <label className="field">Sıcaklık<input aria-label="Sıcaklık aralığı" placeholder="-40…85 °C" value={f.temperature} onChange={(e) => setF({ ...f, temperature: e.target.value })} /></label>
          <label className="field">Hedef adet / tarih<input aria-label="Hedef adet" value={f.targetQty} onChange={(e) => setF({ ...f, targetQty: e.target.value })} /></label>
        </div>
        <DocField label={`Birincil parça datasheet alıntısı${pinCats.has(category) ? " (pin tablosu dahil)" : ""}`} value={primaryDs} onChange={setPrimaryDs} />
        <DocField label="Şema / netlist alıntısı (yoksa uygulamaya uygunluk kesinleşmez)" value={schematic} onChange={setSchematic} />
        {category === "mcu" ? (
          <label className="field">Firmware / çevre birimi / bellek gereksinimleri (yoksa firmware uyumu "kanıt yetersiz" kalır)
            <textarea aria-label="Firmware kanıtı" value={f.firmwareEvidence} onChange={(e) => setF({ ...f, firmwareEvidence: e.target.value })} />
          </label>
        ) : null}

        <h3>Adaylar (en çok 5 + 5)</h3>
        {cands.map((c, i) => (
          <div key={c.item.id} className="card" style={{ background: "var(--surface-2)" }}>
            <div className="row between"><span><b className="mono">{c.item.code}</b> {c.item.name}</span><button type="button" className="link" onClick={() => setCands(cands.filter((_, j) => j !== i))}>çıkar</button></div>
            <DocField label="Aday datasheet alıntısı" value={c.ds} onChange={(d) => setCands(cands.map((x, j) => (j === i ? { ...x, ds: d } : x)))} />
          </div>
        ))}
        {cands.length < 5 ? (
          <div className="row" style={{ alignItems: "flex-end" }}>
            <ItemPicker label="Kalem kartından aday" value={picker} onChange={setPicker} />
            <button type="button" disabled={!picker || picker.id === item?.id || cands.some((c) => c.item.id === picker.id)} onClick={() => { setCands([...cands, { item: picker, ds: emptyDoc }]); setPicker(null); }}>Aday ekle</button>
          </div>
        ) : null}
        {ext.map((x, i) => (
          <div key={i} className="card" style={{ background: "var(--surface-2)" }}>
            <div className="row">
              <label className="field">MPN<input aria-label="Dış aday MPN" required minLength={2} value={x.mpn} onChange={(e) => setExt(ext.map((y, j) => (j === i ? { ...y, mpn: e.target.value } : y)))} /></label>
              <label className="field">Üretici<input aria-label="Dış aday üretici" required minLength={2} value={x.manufacturer} onChange={(e) => setExt(ext.map((y, j) => (j === i ? { ...y, manufacturer: e.target.value } : y)))} /></label>
              <button type="button" className="link" style={{ alignSelf: "flex-end" }} onClick={() => setExt(ext.filter((_, j) => j !== i))}>çıkar</button>
            </div>
            <DocField label="Dış aday datasheet alıntısı" value={x.ds} onChange={(d) => setExt(ext.map((y, j) => (j === i ? { ...y, ds: d } : y)))} />
          </div>
        ))}
        {ext.length < 5 ? <button type="button" onClick={() => setExt([...ext, { mpn: "", manufacturer: "", ds: emptyDoc }])}>Kalem kartında olmayan aday ekle</button> : null}
        <div style={{ marginTop: 8 }}>
          <button className="primary" disabled={!item || start.isPending || (!cands.length && !ext.length)}>{start.isPending ? "Araştırılıyor…" : "AI ile karşılaştır"}</button>
        </div>
        <ErrorNotice error={start.error} />
      </form>

      {item && runs.data?.length ? (
        <div className="row" style={{ marginTop: 8 }}>
          <span className="muted">Önceki araştırmalar:</span>
          {runs.data.map((r) => <button key={r.id} type="button" className="link" onClick={() => setRunId(r.id)}>{new Date(r.createdAt).toLocaleString("tr-TR")} · {r.category} · {r.passing}/{r.candidates} aday</button>)}
        </div>
      ) : null}
      {runId ? (run.isLoading ? <Loading /> : run.data ? <ResearchResult r={run.data} onProposed={() => { qc.invalidateQueries({ queryKey: ["altResearch", runId] }); onProposed(); }} /> : <ErrorNotice error={run.error} />) : null}
    </section>
  );
}

function DocField({ label, value, onChange }: { label: string; value: Doc; onChange: (d: Doc) => void }) {
  return (
    <div className="row" style={{ alignItems: "flex-start" }}>
      <label className="field" style={{ width: 220 }}>Belge başlığı / sürüm<input aria-label={`${label} başlığı`} placeholder="örn. Rev.3 s.4 pin tablosu" value={value.title} onChange={(e) => onChange({ ...value, title: e.target.value })} /></label>
      <label className="field" style={{ flex: 1 }}>{label}<textarea aria-label={label} rows={3} value={value.text} onChange={(e) => onChange({ ...value, text: e.target.value })} /></label>
    </div>
  );
}

function ResearchResult({ r, onProposed }: { r: any; onProposed: () => void }) {
  return (
    <div style={{ marginTop: 12 }}>
      <div className="muted">Model {r.model} · prompt {r.promptVersion} · kural v{r.rulesVersion} · {r.createdBy} · {new Date(r.createdAt).toLocaleString("tr-TR")}</div>
      {r.missingInputs.length ? <div className="notice warn"><b>Eksik girdiler:</b> {r.missingInputs.join(" · ")}</div> : null}
      {r.candidates.length === 0 ? <Empty>Aday bulunamadı.</Empty> : null}
      {r.candidates.map((c: any) => <CandidateCard key={c.id} c={c} onProposed={onProposed} />)}
    </div>
  );
}

function CandidateCard({ c, onProposed }: { c: any; onProposed: () => void }) {
  const can = useCan();
  const [reason, setReason] = useState("");
  const [altItem, setAltItem] = useState<any | null>(null);
  const propose = useMutation({
    mutationFn: () => post(`/api/alternate-research/candidates/${c.id}/propose`, { reason, alternateItemId: c.candidateItemId ? undefined : altItem?.id }),
    onSuccess: () => { setReason(""); onProposed(); },
  });
  const [label, tone] = VERDICT[c.verdict] ?? [c.verdict, "warn"];
  return (
    <div className="card" style={{ background: "var(--surface-2)" }}>
      <div className="row between">
        <h3 style={{ margin: 0 }}>{c.ref} · <span className="mono">{c.mpn ?? c.name}</span> <span className="muted">{c.manufacturer ?? ""} · {c.source === "item_master" ? "kalem kartı" : "dış aday"}</span></h3>
        <span className={`badge state ${tone}`}>{label}</span>
      </div>
      {c.summary ? <p style={{ margin: "4px 0" }}>{c.summary}</p> : null}
      {c.ruleFindings.length ? <ul className="muted" style={{ margin: 0 }}>{c.ruleFindings.map((x: string) => <li key={x}>Kural: {x}</li>)}</ul> : null}
      <table>
        <thead><tr><th>Alan</th><th>Birincil</th><th>Aday</th><th>Durum</th><th>Kaynak</th><th>Not</th></tr></thead>
        <tbody>{c.fields.map((x: any) => {
          const [l, t] = STATUS[x.status] ?? [x.status, "warn"];
          return <tr key={x.key}><td>{x.label ?? x.key}</td><td>{x.primary}</td><td>{x.candidate}</td><td><span className={`badge state ${t}`}>{l}</span></td><td className="mono">{x.source || "—"}</td><td className="muted">{x.note}</td></tr>;
        })}</tbody>
      </table>
      {c.pinMap.length ? (
        <details><summary>Pin eşlemesi ({c.pinMap.length})</summary>
          <table><thead><tr><th>Pin</th><th>Birincil</th><th>Aday</th><th>Durum</th><th>Kaynak</th></tr></thead>
            <tbody>{c.pinMap.map((p: any) => <tr key={p.pin}><td className="mono">{p.pin}</td><td>{p.primaryFunction}</td><td>{p.candidateFunction}</td><td>{p.status === "same" ? "aynı" : p.status === "different" ? "farklı" : "belirsiz"}</td><td className="mono">{p.source || "—"}</td></tr>)}</tbody>
          </table>
        </details>
      ) : null}
      {c.testNeeds.length ? <div><b>Gereken testler:</b> {c.testNeeds.join(" · ")}</div> : null}
      {c.designChanges.length ? <div><b>Tasarım değişikliği:</b> {c.designChanges.join(" · ")}</div> : null}
      {c.supply ? <div className="muted">Serbest stok {c.supply.freeStock}{c.supply.offer ? ` · ${c.supply.offer.source}: stok ${c.supply.offer.stock ?? "?"}, MOQ ${c.supply.offer.moq ?? "?"}, temin ${c.supply.offer.leadTimeDays ?? "?"} gün (${new Date(c.supply.offer.fetchedAt).toLocaleDateString("tr-TR")})` : " · distribütör teklifi yok"}</div> : null}
      {c.proposalId ? <div className="notice">Öneriye dönüştürüldü — onay akışında.</div> : c.verdict !== "rejected_by_rules" && can("product.create") ? (
        <form className="row" style={{ marginTop: 6 }} onSubmit={(e: FormEvent) => { e.preventDefault(); propose.mutate(); }}>
          {!c.candidateItemId ? <ItemPicker label="Kalem kartı (önce açın)" value={altItem} onChange={setAltItem} /> : null}
          <input aria-label="Öneri gerekçesi" style={{ flex: 1 }} required minLength={10} placeholder="Gerekçe (≥ 10 karakter)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <button disabled={propose.isPending || (!c.candidateItemId && !altItem)}>Öneriye dönüştür (Ar-Ge + üretim onayı)</button>
        </form>
      ) : null}
      <ErrorNotice error={propose.error} />
    </div>
  );
}
