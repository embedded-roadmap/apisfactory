import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, post } from "../lib/api";
import { Empty, ErrorNotice, Loading, PageHeader, fmt, fmtDate, useCan } from "../lib/ui";

const iso = (d: Date) => d.toISOString().slice(0, 10);
const firstOfMonth = () => { const d = new Date(); return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))); };
const pct = (v: number | null) => (v === null ? "—" : `%${(v * 100).toLocaleString("tr-TR", { maximumFractionDigits: 1 })}`);

/**
 * Metrik sözlüğü (KPI satırı), kaynak kayıtlar, satış kârlılığı ve maliyet politikası.
 * Her rakamın tanımı, payı ve paydası görünür; hesaplanamayan değer uydurulmaz.
 */
export function ReportsPage() {
  const can = useCan();
  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo] = useState(iso(new Date()));
  const [open, setOpen] = useState<string | null>(null);
  const m = useQuery({ queryKey: ["metrics", from, to], queryFn: () => get<any>(`/api/metrics?from=${from}&to=${to}`) });
  return (
    <>
      <PageHeader title="Maliyet & Metrikler" sub="Tanımlar sürümlüdür (metrik sözlüğü v1). Her değerin pay/paydası ve kaynak kayıtları açılabilir." />
      <section className="card">
        <div className="row" role="group" aria-label="Dönem">
          <label className="field">Başlangıç<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="field">Bitiş<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          <span className="muted" style={{ alignSelf: "flex-end", flex: 1 }}>Kapsam: {m.data?.scope}</span>
        </div>
      </section>
      {m.isLoading ? <Loading /> : <ErrorNotice error={m.error} />}
      {m.data ? (
        <section className="card">
          <h2>Performans göstergeleri</h2>
          <div className="kpis">
            {m.data.metrics.map((x: any) => (
              <button key={x.key} className={`kpi ${open === x.key ? "active" : ""}`} aria-pressed={open === x.key} onClick={() => setOpen(open === x.key ? null : x.key)} disabled={x.key === "budget_variance"}>
                <small>{x.name}</small>
                <b>{x.value === null ? "—" : pct(x.value)}</b>
                <span className="muted">{x.numerator === null ? x.reason : `${fmt(x.numerator)} / ${fmt(x.denominator)}`}</span>
                {x.value === null && x.numerator !== null ? <span className="muted">{x.reason}</span> : null}
              </button>
            ))}
          </div>
          {open ? <Sources metric={m.data.metrics.find((x: any) => x.key === open)} from={from} to={to} /> : <p className="muted" style={{ margin: 0 }}>Bir göstergeye tıklayınca tanımı ve kaynak kayıtları açılır.</p>}
        </section>
      ) : null}
      {can("field.cost.view") && can("field.price.view") ? <Margin from={from} to={to} /> : null}
      {can("field.cost.view") ? <Policies /> : null}
    </>
  );
}

const SOURCE_COLS: Record<string, [string, string][]> = {
  scrap_rate: [["serial", "Seri"], ["workOrderCode", "İş emri"], ["productCode", "Ürün"], ["status", "Durum"], ["scrappedInProduction", "Üretimde hurda"]],
  rework_rate: [["serial", "Seri"], ["workOrderCode", "İş emri"], ["productCode", "Ürün"], ["status", "Durum"], ["reworked", "Yeniden işleme"]],
  first_pass_yield: [["serial", "Seri"], ["workOrderCode", "İş emri"], ["productCode", "Ürün"], ["firstPassed", "İlk testte geçti"]],
  component_scrap: [["itemCode", "Kalem"], ["lotNo", "Lot"], ["qty", "Miktar"], ["at", "Zaman"]],
  on_time_delivery: [["orderCode", "Sipariş"], ["customerName", "Müşteri"], ["lineNo", "Satır"], ["promisedDate", "Taahhüt"], ["ordered", "Sipariş"], ["shipped", "Sevk"], ["onTime", "Zamanında"], ["counted", "Kapsamda"]],
  return_rate: [["code", "İade"], ["kind", "Tür"], ["customerName", "Müşteri"], ["serial", "Seri"], ["lotNo", "Lot"], ["qty", "Miktar"], ["cause", "Neden"]],
};

function Sources({ metric, from, to }: { metric: any; from: string; to: string }) {
  const q = useQuery({ queryKey: ["metricSources", metric.key, from, to], queryFn: () => get<any>(`/api/metrics/${metric.key}/sources?from=${from}&to=${to}`) });
  const cols = SOURCE_COLS[metric.key] ?? [];
  const cell = (v: unknown, k: string) => (typeof v === "boolean" ? (v ? "evet" : "hayır") : k === "at" ? fmtDate(v as string) : k === "qty" ? fmt(v as string) : String(v ?? "—"));
  return (
    <div className="stack">
      <div className="notice"><b>{metric.name}:</b> {metric.definition}{metric.note ? ` — ${metric.note}` : ""}</div>
      {q.isLoading ? <Loading /> : <ErrorNotice error={q.error} />}
      {q.data?.rows.length === 0 ? <Empty>Kapsamda kayıt yok.</Empty> : null}
      {q.data?.rows.length ? (
        <table>
          <thead><tr>{cols.map(([, h]) => <th key={h}>{h}</th>)}</tr></thead>
          <tbody>{q.data.rows.map((r: any, i: number) => <tr key={i}>{cols.map(([k]) => <td key={k} className={["serial", "workOrderCode", "code", "orderCode", "lotNo", "itemCode"].includes(k) ? "mono" : ""}>{cell(r[k], k)}</td>)}</tr>)}</tbody>
        </table>
      ) : null}
    </div>
  );
}

function Margin({ from, to }: { from: string; to: string }) {
  const q = useQuery({ queryKey: ["margin", from, to], queryFn: () => get<any>(`/api/reports/margin?from=${from}&to=${to}`) });
  const r = q.data;
  return (
    <section className="card">
      <h2>Satış kârlılığı (sevk edilen)</h2>
      {q.isLoading ? <Loading /> : <ErrorNotice error={q.error} />}
      {r ? (
        <>
          <div className="kpis">
            {r.totals.length === 0 ? <div className="kpi"><small>Brüt kâr</small><b>—</b><span className="muted">Hesaplanabilir satır yok</span></div> : null}
            {r.totals.map((t: any) => (
              <div key={t.currency} className="kpi">
                <small>Brüt kâr ({t.currency})</small><b>{fmt(t.grossProfit)}</b>
                <span className="muted">gelir {fmt(t.revenue)} · maliyet {fmt(t.cogs)} · marj {pct(t.grossMargin)}</span>
              </div>
            ))}
            <div className="kpi"><small>Eksik veri</small><b>{r.incompleteLines}</b><span className="muted">satır hesaplanamadı</span></div>
            <div className="kpi"><small>İade (dönem)</small><b>{r.returns.count}</b><span className="muted">{fmt(r.returns.qty)} adet · {r.returns.creditNoteRequests} alacak talebi</span></div>
          </div>
          {r.rows.length === 0 ? <Empty>Dönemde sevkiyat yok; satılmamış stokta kâr gösterilmez.</Empty> : (
            <table>
              <thead><tr><th>Sevk</th><th>Sipariş</th><th>Müşteri</th><th>Ürün / lot</th><th className="num">Adet</th><th className="num">Birim fiyat</th><th className="num">Birim maliyet</th><th className="num">Gelir</th><th className="num">Maliyet</th><th className="num">Brüt kâr</th><th className="num">Marj</th><th>Not</th></tr></thead>
              <tbody>
                {r.rows.map((x: any, i: number) => (
                  <tr key={i}>
                    <td className="mono">{x.shipmentCode}</td><td className="mono">{x.orderCode}</td><td>{x.customerName}</td><td><span className="mono">{x.product}</span><div className="muted mono">{x.lotNo}</div></td>
                    <td className="num">{fmt(x.qty)}</td><td className="num">{fmt(x.unitPrice)} {x.currency}</td><td className="num">{fmt(x.unitCost)}<div className="muted">{x.costSource ?? ""}</div></td>
                    <td className="num">{fmt(x.revenue)}</td><td className="num">{fmt(x.cogs)}</td><td className="num"><b>{fmt(x.grossProfit)}</b></td><td className="num">{pct(x.grossMargin)}</td><td className="muted">{x.note ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <ul className="muted" style={{ margin: 0 }}>{r.notes.map((n: string) => <li key={n}>{n}</li>)}</ul>
        </>
      ) : null}
    </section>
  );
}

function Policies() {
  const can = useCan();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["costPolicies"], queryFn: () => get<any[]>("/api/cost-policies") });
  const [f, setF] = useState({ validFrom: iso(new Date()), currency: "TRY", laborRatePerHour: "", overheadPerLaborHour: "0", overheadPctOfMaterial: "0", note: "" });
  const add = useMutation({ mutationFn: () => post("/api/cost-policies", f), onSuccess: () => { qc.invalidateQueries({ queryKey: ["costPolicies"] }); setF({ ...f, note: "" }); } });
  return (
    <section className="card">
      <h2>Maliyet politikası (sürümlü)</h2>
      <p className="muted" style={{ margin: 0 }}>Sürümler değiştirilmez; yeni politika geçerlilik tarihinden itibaren yeni hesaplarda kullanılır. Değerleme: lot bazında gerçek maliyet. Hurda maliyeti sağlam adetlere yüklenir.</p>
      {q.data?.length === 0 ? <div className="notice warn">Politika yok: işçilik ve genel gider hesaplanamaz, maliyet hesapları "eksik" kalır.</div> : null}
      {q.data?.length ? (
        <table>
          <thead><tr><th>Sürüm</th><th>Geçerlilik</th><th className="num">İşçilik / saat</th><th className="num">Genel gider / saat</th><th className="num">Genel gider % malzeme</th><th>Not</th><th>Kaydeden</th></tr></thead>
          <tbody>{q.data.map((p) => <tr key={p.id}><td>v{p.versionNo}</td><td>{p.validFrom}</td><td className="num">{fmt(p.laborRatePerHour)} {p.currency}</td><td className="num">{fmt(p.overheadPerLaborHour)}</td><td className="num">%{fmt(p.overheadPctOfMaterial)}</td><td>{p.note}</td><td className="muted">{p.createdBy} · {fmtDate(p.createdAt)}</td></tr>)}</tbody>
        </table>
      ) : null}
      {can("cost.manage") ? (
        <form className="row" onSubmit={(e: FormEvent) => { e.preventDefault(); add.mutate(); }}>
          <label className="field">Geçerlilik<input type="date" required value={f.validFrom} onChange={(e) => setF({ ...f, validFrom: e.target.value })} /></label>
          <label className="field" style={{ width: 80 }}>Para<input required pattern="[A-Z]{3}" value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} /></label>
          <label className="field" style={{ width: 120 }}>İşçilik/saat<input required inputMode="decimal" value={f.laborRatePerHour} onChange={(e) => setF({ ...f, laborRatePerHour: e.target.value })} /></label>
          <label className="field" style={{ width: 120 }}>Genel gider/saat<input inputMode="decimal" value={f.overheadPerLaborHour} onChange={(e) => setF({ ...f, overheadPerLaborHour: e.target.value })} /></label>
          <label className="field" style={{ width: 120 }}>% malzeme<input inputMode="decimal" value={f.overheadPctOfMaterial} onChange={(e) => setF({ ...f, overheadPctOfMaterial: e.target.value })} /></label>
          <label className="field" style={{ flex: 1 }}>Gerekçe / not<input required minLength={3} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
          <button className="primary" style={{ alignSelf: "flex-end" }} disabled={add.isPending}>Yeni sürüm</button>
        </form>
      ) : null}
      <ErrorNotice error={add.error} />
    </section>
  );
}

/** İş emri maliyet paneli: sürümler, kalemler, eksikler. */
export function WorkOrderCost({ woId }: { woId: string }) {
  const can = useCan();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["woCost", woId], queryFn: () => get<any[]>(`/api/work-orders/${woId}/costs`) });
  const [sel, setSel] = useState<number | null>(null);
  const run = useMutation({ mutationFn: () => post<any>(`/api/work-orders/${woId}/costs`), onSuccess: () => { setSel(null); qc.invalidateQueries({ queryKey: ["woCost", woId] }); } });
  const versions = q.data ?? [];
  const cur = versions.find((v) => v.versionNo === sel) ?? versions[0];
  const r = cur?.result;
  return (
    <section className="card">
      <div className="row between">
        <h2>Maliyet</h2>
        <div className="row">
          {versions.length > 1 ? (
            <select aria-label="Hesap sürümü" value={cur?.versionNo} onChange={(e) => setSel(Number(e.target.value))}>
              {versions.map((v) => <option key={v.versionNo} value={v.versionNo}>v{v.versionNo} · {fmtDate(v.createdAt)}</option>)}
            </select>
          ) : null}
          {can("cost.manage") ? <button onClick={() => run.mutate()} disabled={run.isPending}>{versions.length ? "Yeniden hesapla" : "Hesapla"}</button> : null}
        </div>
      </div>
      <ErrorNotice error={run.error ?? q.error} />
      {run.data?.unchanged ? <div className="notice">Girdiler değişmedi; yeni sürüm açılmadı (v{run.data.versionNo}).</div> : null}
      {!r ? <Empty>Henüz maliyet hesabı yok.</Empty> : (
        <>
          <div className="kpis">
            <div className="kpi"><small>Toplam {r.currency ?? ""}</small><b>{fmt(r.totals.total)}</b><span className="muted">malzeme {fmt(r.totals.material)} · işçilik {fmt(r.totals.labor)} · genel {fmt(r.totals.overhead)}</span></div>
            <div className="kpi"><small>Birim maliyet</small><b>{r.unitCost === null ? "Hesaplanamaz" : fmt(r.unitCost)}</b><span className="muted">{r.unitCostNote}</span></div>
            <div className="kpi"><small>Sağlam / hurda / başlanan</small><b>{r.devices.good} / {r.devices.scrapped} / {r.devices.started}</b><span className="muted">işçilik {fmt(r.laborHours)} saat</span></div>
            <div className="kpi"><small>Durum</small><b>{r.complete ? "Tamam" : "Eksik"}</b><span className="muted">v{cur.versionNo} · politika {r.policy ? `v${r.policy.versionNo}` : "yok"}</span></div>
          </div>
          {r.gaps.length ? <div className="notice warn"><b>Eksik:</b> {r.gaps.join(" · ")}</div> : null}
          <table>
            <thead><tr><th>Kalem</th><th>Lot</th><th className="num">Miktar</th><th className="num">Birim maliyet</th><th>Kaynak</th><th className="num">Tutar</th></tr></thead>
            <tbody>{r.materials.map((m: any) => <tr key={m.itemCode + m.lotNo}><td className="mono">{m.itemCode}</td><td className="mono">{m.lotNo}</td><td className="num">{fmt(m.qty)}</td><td className="num">{m.unitCost === null ? "—" : `${fmt(m.unitCost)} ${m.currency}`}</td><td className="muted">{m.costSource ? `${m.costSource} · ${m.costReference ?? ""}` : m.note}</td><td className="num">{fmt(m.cost)}</td></tr>)}</tbody>
          </table>
          <p className="muted" style={{ margin: 0 }}>{r.externalNote}. Hesap girdilerden deterministik üretilir; değişen girdi yeni sürüm açar, eski sürüm değişmez.</p>
        </>
      )}
    </section>
  );
}

/** Lot maliyet geçmişi ve fatura/elle giriş. */
export function LotCosts({ lotId, lotNo }: { lotId: string; lotNo: string }) {
  const can = useCan();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["lotCosts", lotId], queryFn: () => get<any[]>(`/api/lots/${lotId}/costs`) });
  const [f, setF] = useState({ unitCost: "", currency: "TRY", source: "invoice", reference: "" });
  const add = useMutation({ mutationFn: () => post(`/api/lots/${lotId}/cost`, f), onSuccess: () => { qc.invalidateQueries({ queryKey: ["lotCosts", lotId] }); setF({ ...f, unitCost: "", reference: "" }); } });
  return (
    <div className="stack">
      <b>Lot {lotNo} maliyet geçmişi</b>
      <ErrorNotice error={q.error ?? add.error} />
      {q.data?.length === 0 ? <span className="muted">Maliyet kaydı yok.</span> : null}
      {q.data?.length ? (
        <table><tbody>{q.data.map((c, i) => <tr key={c.id}><td className="num">{fmt(c.unitCost)} {c.currency}</td><td>{c.source}{i === 0 ? <span className="badge ok">güncel</span> : null}</td><td>{c.reference}</td><td className="muted">{c.recordedBy} · {fmtDate(c.createdAt)}</td></tr>)}</tbody></table>
      ) : null}
      {can("lot.cost.record") ? (
        <form className="row" onSubmit={(e: FormEvent) => { e.preventDefault(); add.mutate(); }}>
          <label className="field" style={{ width: 120 }}>Birim maliyet<input required inputMode="decimal" value={f.unitCost} onChange={(e) => setF({ ...f, unitCost: e.target.value })} /></label>
          <label className="field" style={{ width: 80 }}>Para<input required pattern="[A-Z]{3}" value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} /></label>
          <label className="field">Kaynak<select value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}><option value="invoice">Fatura</option><option value="manual">Elle düzeltme</option></select></label>
          <label className="field" style={{ flex: 1 }}>Belge no / gerekçe<input required minLength={2} value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></label>
          <button className="primary" style={{ alignSelf: "flex-end" }}>Kaydet</button>
        </form>
      ) : null}
    </div>
  );
}
