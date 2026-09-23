import { useState } from "react";
import { Link, NavLink, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, newKey, post } from "../lib/api";
import { Empty, ErrorNotice, Loading, PageHeader, fmt, fmtDate, useCan, useMe } from "../lib/ui";
import { History } from "./Sales";
import { Discussion } from "../components/Discussion";

const ST: Record<string, [string, string]> = {
  received: ["alındı", "warn"], variance: ["fark — onay bekliyor", "bad"], approved: ["ödemeye hazır", "ok"], rejected: ["reddedildi", ""], paid: ["ödendi", "ok"], cancelled: ["iptal", ""],
};
const FLAG: Record<string, string> = {
  qty_over_accepted: "Miktar > kalite kabul", price_variance: "Fiyat farkı", po_missing: "Siparişsiz", currency_mismatch: "Para birimi", supplier_mismatch: "Tedarikçi",
  po_price_missing: "Sipariş fiyatı yok", line_amount: "Satır tutarı", total_mismatch: "Toplam uyuşmuyor",
};
const today = () => new Date().toISOString().slice(0, 10);

function Tabs() {
  return (
    <div className="row tabs" role="tablist">
      <NavLink to="/payables" end>Faturalar</NavLink>
      <NavLink to="/payables/new">Fatura gir</NavLink>
      <NavLink to="/payables/aging">Vade & ödeme planı</NavLink>
      <NavLink to="/payables/policy">Eşleştirme toleransı</NavLink>
    </div>
  );
}
const Header = () => (
  <>
    <PageHeader title="Borçlar & ödeme" sub="Tedarikçi faturası sipariş ve kalite kabulüyle eşleştirilir. Sistem ödeme yapmaz; banka bağlantısı yoktur — dışarıda yapılan ödemenin kaydı tutulur." />
    <Tabs />
  </>
);

export function InvoicesPage() {
  const [status, setStatus] = useState("");
  const q = useQuery({ queryKey: ["invoices", status], queryFn: () => get<any[]>(`/api/supplier-invoices${status ? `?status=${status}` : ""}`) });
  return (
    <>
      <Header />
      <section className="card">
        <div className="row">
          <label className="field">Durum
            <select aria-label="Fatura durumu" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Tümü</option>{Object.entries(ST).map(([k, v]) => <option key={k} value={k}>{v[0]}</option>)}
            </select>
          </label>
        </div>
        {q.isLoading ? <Loading /> : <ErrorNotice error={q.error} />}
        {q.data?.length === 0 ? <Empty>Fatura yok.</Empty> : null}
        {q.data?.length ? (
          <table>
            <thead><tr><th>Kod</th><th>Fatura no</th><th>Tedarikçi</th><th>Tarih</th><th>Vade</th><th className="num">Tutar</th><th className="num">Ödenen</th><th>Durum</th></tr></thead>
            <tbody>{q.data.map((x) => (
              <tr key={x.id}>
                <td className="mono"><Link to={`/payables/${x.id}`}>{x.code}</Link></td><td className="mono">{x.invoiceNo}</td><td>{x.supplierName}</td><td>{x.invoiceDate}</td>
                <td>{x.dueDate} {x.overdue ? <span className="badge bad">vadesi geçti</span> : null}</td>
                <td className="num">{fmt(x.grossAmount)} {x.currency}</td><td className="num">{fmt(x.paid)}</td>
                <td><span className={`badge ${ST[x.status]![1]}`}>{ST[x.status]![0]}</span></td>
              </tr>
            ))}</tbody>
          </table>
        ) : null}
      </section>
    </>
  );
}

type Line = { poLineId: string; description: string; qty: string; unitPrice: string };

export function NewInvoicePage() {
  const nav = useNavigate();
  const can = useCan();
  const sup = useQuery({ queryKey: ["suppliers"], queryFn: () => get<any[]>("/api/suppliers") });
  const [h, setH] = useState({ supplierId: "", invoiceNo: "", invoiceDate: today(), dueDate: "", currency: "TRY", taxAmount: "0" });
  const [lines, setLines] = useState<Line[]>([]);
  const able = useQuery({ queryKey: ["invoiceable", h.supplierId], queryFn: () => get<any[]>(`/api/payables/invoiceable?supplierId=${h.supplierId}`), enabled: !!h.supplierId });
  const [key] = useState(newKey());
  const amount = (l: Line) => (Number(l.qty.replace(",", ".")) * Number(l.unitPrice.replace(",", ".")) || 0).toFixed(2);
  const net = lines.reduce((a, l) => a + Number(amount(l)), 0).toFixed(2);
  const body = () => ({
    ...h, dueDate: h.dueDate || undefined, netAmount: net, taxAmount: (Number(h.taxAmount.replace(",", ".")) || 0).toFixed(2),
    lines: lines.map((l) => ({ poLineId: l.poLineId || undefined, description: l.description || undefined, qty: l.qty.replace(",", "."), unitPrice: l.unitPrice.replace(",", "."), amount: amount(l) })),
  });
  const preview = useMutation({ mutationFn: () => post<any>("/api/supplier-invoices/preview", body()) });
  const save = useMutation({ mutationFn: () => post<any>("/api/supplier-invoices", body(), { "Idempotency-Key": key }), onSuccess: (r) => nav(`/payables/${r.id}`) });
  const set = (i: number, p: Partial<Line>) => { setLines(lines.map((l, j) => (j === i ? { ...l, ...p } : l))); preview.reset(); };
  if (!can("invoice.manage")) return <><Header /><Empty>Fatura girişi için yetkiniz yok.</Empty></>;
  const pv = preview.data;
  return (
    <>
      <Header />
      <section className="card">
        <h2>Tedarikçi faturası</h2>
        <div className="row" style={{ flexWrap: "wrap" }}>
          <label className="field">Tedarikçi<select aria-label="Fatura tedarikçisi" value={h.supplierId} onChange={(e) => { setH({ ...h, supplierId: e.target.value }); setLines([]); preview.reset(); }}><option value="">Seçin</option>{sup.data?.map((s) => <option key={s.id} value={s.id}>{s.code} — {s.name} (vade {s.paymentTermsDays} g)</option>)}</select></label>
          <label className="field">Fatura no<input aria-label="Fatura no" value={h.invoiceNo} onChange={(e) => setH({ ...h, invoiceNo: e.target.value })} /></label>
          <label className="field">Fatura tarihi<input type="date" value={h.invoiceDate} onChange={(e) => setH({ ...h, invoiceDate: e.target.value })} /></label>
          <label className="field">Vade (boşsa tedarikçi şartı)<input type="date" value={h.dueDate} onChange={(e) => setH({ ...h, dueDate: e.target.value })} /></label>
          <label className="field" style={{ width: 80 }}>Para<input value={h.currency} onChange={(e) => setH({ ...h, currency: e.target.value.toUpperCase() })} /></label>
        </div>
      </section>
      {h.supplierId ? (
        <section className="card">
          <h2>Faturalanabilir sipariş satırları</h2>
          <p className="muted" style={{ margin: 0 }}>Kalite kabul edilmiş ve henüz faturalanmamış miktar. Seçince satır eklenir (fiyat siparişten gelir; faturadaki fiyatı yazın).</p>
          {able.data?.length === 0 ? <Empty>Faturalanabilir satır yok.</Empty> : null}
          <table><tbody>{able.data?.map((a) => (
            <tr key={a.poLineId}><td className="mono">{a.poCode}</td><td className="mono">{a.itemCode}</td><td className="num">kabul {fmt(a.accepted)} · faturalı {fmt(a.invoiced)}</td><td className="num">sipariş fiyatı {a.unitPrice ? fmt(a.unitPrice) : "—"} {a.currency ?? ""}</td>
              <td><button disabled={lines.some((l) => l.poLineId === a.poLineId)} onClick={() => { setLines([...lines, { poLineId: a.poLineId, description: "", qty: String(Number(a.invoiceableQty)), unitPrice: a.unitPrice ? String(Number(a.unitPrice)) : "" }]); preview.reset(); }}>Ekle</button></td></tr>
          ))}</tbody></table>
        </section>
      ) : null}
      {h.supplierId ? (
        <section className="card">
          <h2>Fatura satırları</h2>
          <table>
            <thead><tr><th>Sipariş satırı</th><th>Açıklama</th><th className="num">Miktar</th><th className="num">Birim fiyat</th><th className="num">Tutar</th><th>Eşleştirme</th><th /></tr></thead>
            <tbody>{lines.map((l, i) => {
              const a = able.data?.find((x) => x.poLineId === l.poLineId);
              const m = pv?.lines[i];
              return (
                <tr key={i}>
                  <td className="mono">{a ? `${a.poCode} ${a.itemCode}` : l.poLineId ? "—" : "siparişsiz"}</td>
                  <td><input aria-label={`Satır ${i + 1} açıklama`} value={l.description} onChange={(e) => set(i, { description: e.target.value })} /></td>
                  <td><input aria-label={`Satır ${i + 1} miktar`} inputMode="decimal" value={l.qty} onChange={(e) => set(i, { qty: e.target.value })} style={{ width: 90 }} /></td>
                  <td><input aria-label={`Satır ${i + 1} fiyat`} inputMode="decimal" value={l.unitPrice} onChange={(e) => set(i, { unitPrice: e.target.value })} style={{ width: 100 }} /></td>
                  <td className="num">{amount(l)}</td>
                  <td>{m ? (m.flags.length ? m.flags.map((f: any) => <div key={f.code}><span className="badge bad">{FLAG[f.code] ?? f.code}</span> <span className="muted" style={{ fontSize: 13 }}>{f.message}</span></div>) : <span className="badge ok">eşleşti</span>) : null}</td>
                  <td><button className="link" onClick={() => { setLines(lines.filter((_, j) => j !== i)); preview.reset(); }}>sil</button></td>
                </tr>
              );
            })}</tbody>
          </table>
          <div className="row">
            <button onClick={() => { setLines([...lines, { poLineId: "", description: "", qty: "1", unitPrice: "" }]); preview.reset(); }}>Siparişsiz satır (ör. nakliye)</button>
            <span style={{ marginLeft: "auto" }}>Net <b>{net}</b></span>
            <label className="row" style={{ gap: 6 }}>KDV <input aria-label="KDV tutarı" inputMode="decimal" value={h.taxAmount} onChange={(e) => setH({ ...h, taxAmount: e.target.value })} style={{ width: 100 }} /></label>
            <span>Toplam <b>{(Number(net) + (Number(h.taxAmount.replace(",", ".")) || 0)).toFixed(2)} {h.currency}</b></span>
          </div>
          {pv ? (
            <div className={`notice ${pv.matched ? "" : "warn"}`}>
              {pv.matched ? "Üç yönlü eşleşme tolerans içinde: kaydedilince otomatik ödemeye hazır olur." : "Fark var: kaydedilince muhasebe onayına düşer (faturayı giren onaylayamaz)."} Tolerans: fiyat %{pv.tolerance.pricePct}, miktar %{pv.tolerance.qtyPct}{pv.policyVersion ? ` (politika v${pv.policyVersion})` : " (varsayılan)"}.
              {pv.headerFlags.map((f: any) => <div key={f.code}>{f.message}</div>)}
            </div>
          ) : null}
          <div className="row">
            <button disabled={!lines.length || !h.invoiceNo || preview.isPending} onClick={() => preview.mutate()}>Eşleştir (önizleme)</button>
            <button className="primary" disabled={!pv || save.isPending} onClick={() => save.mutate()}>Faturayı kaydet</button>
          </div>
          <ErrorNotice error={preview.error ?? save.error} />
        </section>
      ) : null}
    </>
  );
}

export function InvoicePage() {
  const { id } = useParams();
  const can = useCan();
  const { me } = useMe();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["invoice", id], queryFn: () => get<any>(`/api/supplier-invoices/${id}`) });
  const act = useMutation({ mutationFn: (f: () => Promise<any>) => f(), onSuccess: () => { qc.invalidateQueries({ queryKey: ["invoice", id] }); qc.invalidateQueries({ queryKey: ["history"] }); } });
  const [note, setNote] = useState("");
  const [pay, setPay] = useState({ amount: "", paidOn: today(), reference: "" });
  const [payKey, setPayKey] = useState(newKey());
  const [cancel, setCancel] = useState("");
  const i = q.data;
  if (!i) return q.isLoading ? <Loading /> : <ErrorNotice error={q.error} />;
  const m = i.matchResult;
  return (
    <>
      <PageHeader title={`${i.code} — ${i.supplierName} ${i.invoiceNo}`} sub={<>fatura {i.invoiceDate} · vade {i.dueDate} · giren {i.enteredBy} {fmtDate(i.createdAt)} · <Link to="/payables">← Faturalar</Link></>}
        actions={<span className={`badge ${ST[i.status]![1]}`}>{ST[i.status]![0]}</span>} />
      <ErrorNotice error={act.error} />
      {i.overdue ? <div className="notice warn">Vadesi geçti.</div> : null}
      <section className="card">
        <div className="kpis">
          <div className="kpi"><small>Net</small><b>{fmt(i.netAmount)} {i.currency}</b></div>
          <div className="kpi"><small>KDV</small><b>{fmt(i.taxAmount)}</b></div>
          <div className="kpi"><small>Toplam</small><b>{fmt(i.grossAmount)}</b></div>
          <div className="kpi"><small>Ödenen (kayıt)</small><b>{fmt(i.paid)}</b></div>
          <div className="kpi"><small>Açık</small><b>{fmt(i.open)}</b></div>
        </div>
        {i.decidedAt ? <p style={{ margin: 0 }}>Karar: {i.decidedBy ?? "otomatik"} · {fmtDate(i.decidedAt)} — {i.decisionNote}</p> : null}
      </section>
      <section className="card">
        <h2>Üç yönlü eşleştirme</h2>
        <p className="muted" style={{ margin: 0 }}>Tolerans: fiyat %{m?.tolerance.pricePct}, miktar %{m?.tolerance.qtyPct}, tutar {m?.tolerance.amount} · politika {m?.policyVersion ? `v${m.policyVersion}` : "varsayılan"} (kayıt anındaki).</p>
        {m?.headerFlags.map((f: any) => <div key={f.code} className="notice warn">{f.message}</div>)}
        <table>
          <thead><tr><th>#</th><th>Sipariş</th><th>Kalem</th><th className="num">Fatura miktar</th><th className="num">Kabul</th><th className="num">Önceki fatura</th><th className="num">Fatura fiyat</th><th className="num">Sipariş fiyat</th><th className="num">Tutar</th><th>Sonuç</th></tr></thead>
          <tbody>{i.lines.map((l: any, k: number) => {
            const r = m?.lines[k] ?? {};
            return (
              <tr key={l.lineNo}>
                <td>{l.lineNo}</td><td className="mono">{l.poCode ?? "—"}</td><td className="mono">{l.itemCode ?? l.description}</td>
                <td className="num">{fmt(l.qty)}</td><td className="num">{r.accepted != null ? fmt(String(r.accepted)) : "—"}{r.pendingInspection ? <div className="muted">+{r.pendingInspection} bekliyor</div> : null}</td><td className="num">{r.invoicedBefore ?? "—"}</td>
                <td className="num">{fmt(l.unitPrice)}</td><td className="num">{r.poPrice != null ? fmt(String(r.poPrice)) : "—"}{r.priceDeviationPct ? <div className="muted">%{r.priceDeviationPct}</div> : null}</td><td className="num">{fmt(l.amount)}</td>
                <td>{r.flags?.length ? r.flags.map((f: any) => <div key={f.code}><span className="badge bad">{FLAG[f.code] ?? f.code}</span></div>) : <span className="badge ok">eşleşti</span>}</td>
              </tr>
            );
          })}</tbody>
        </table>
        {i.status === "variance" && can("invoice.approve") ? (
          i.enteredById === me?.user.id ? <p className="muted">Faturayı siz girdiniz; fark onayını başka yetkili vermeli (görev ayrılığı).</p> : (
            <div className="row">
              <input aria-label="Karar gerekçesi" placeholder="Gerekçe (en az 10 karakter)" value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: 1 }} />
              <button className="primary" disabled={note.length < 10} onClick={() => act.mutate(() => post(`/api/supplier-invoices/${id}/decision`, { decision: "approve", note }))}>Farkı onayla</button>
              <button className="danger" disabled={note.length < 10} onClick={() => act.mutate(() => post(`/api/supplier-invoices/${id}/decision`, { decision: "reject", note }))}>Reddet</button>
            </div>
          )
        ) : null}
      </section>
      <section className="card">
        <h2>Ödeme kayıtları</h2>
        <p className="muted" style={{ margin: 0 }}>Sistem ödeme başlatmaz; bankada yapılmış ödemenin kaydını girin. Kayıt değiştirilemez.</p>
        {i.payments.length ? (
          <table><tbody>{i.payments.map((p: any, k: number) => <tr key={k}><td>{p.paidOn}</td><td className="num">{fmt(p.amount)} {i.currency}</td><td className="mono">{p.reference}</td><td className="muted">{p.recordedBy} · {fmtDate(p.createdAt)}</td></tr>)}</tbody></table>
        ) : <Empty>Ödeme kaydı yok.</Empty>}
        {i.status === "approved" && can("payment.record") ? (
          <form className="row" onSubmit={(e) => { e.preventDefault(); act.mutate(() => post(`/api/supplier-invoices/${id}/payments`, { amount: pay.amount.replace(",", "."), paidOn: pay.paidOn, reference: pay.reference }, { "Idempotency-Key": payKey }).then(() => { setPay({ amount: "", paidOn: today(), reference: "" }); setPayKey(newKey()); })); }}>
            <label className="field" style={{ width: 130 }}>Tutar<input aria-label="Ödeme tutarı" required inputMode="decimal" value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} placeholder={i.open} /></label>
            <label className="field">Ödeme tarihi<input type="date" required value={pay.paidOn} onChange={(e) => setPay({ ...pay, paidOn: e.target.value })} /></label>
            <label className="field" style={{ flex: 1 }}>Banka referansı<input aria-label="Banka referansı" required minLength={3} value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} /></label>
            <button className="primary" style={{ alignSelf: "flex-end" }}>Ödeme kaydı ekle</button>
          </form>
        ) : null}
        {can("invoice.manage") && !["paid", "cancelled"].includes(i.status) && Number(i.paid) === 0 ? (
          <div className="row">
            <input aria-label="İptal gerekçesi" placeholder="İptal gerekçesi" value={cancel} onChange={(e) => setCancel(e.target.value)} />
            <button className="danger" disabled={cancel.length < 3} onClick={() => act.mutate(() => post(`/api/supplier-invoices/${id}/cancel`, { reason: cancel }))}>Faturayı iptal et</button>
          </div>
        ) : null}
      </section>
      <Discussion entityType="supplier_invoice" entityId={i.id} />
      <History entityType="supplier_invoice" id={i.id} />
    </>
  );
}

export function AgingPage() {
  const q = useQuery({ queryKey: ["aging"], queryFn: () => get<any>("/api/payables/aging") });
  const d = q.data;
  const cols: [string, string][] = [["over60", "60+ gün geçmiş"], ["over31", "31–60 geçmiş"], ["over1", "1–30 geçmiş"], ["due7", "7 gün içinde"], ["due30", "8–30 gün"], ["later", "30+ gün"], ["onHold", "fark (beklemede)"], ["total", "Toplam açık"]];
  const weeks = [...new Set((d?.plan ?? []).map((p: any) => p.week))] as string[];
  const currencies = [...new Set((d?.plan ?? []).map((p: any) => p.currency))] as string[];
  return (
    <>
      <Header />
      {q.isLoading ? <Loading /> : <ErrorNotice error={q.error} />}
      <section className="card">
        <h2>Vade yaşlandırma</h2>
        {d?.buckets.length === 0 ? <Empty>Açık tedarikçi borcu yok.</Empty> : (
          <table>
            <thead><tr><th>Para</th>{cols.map(([, l]) => <th key={l} className="num">{l}</th>)}</tr></thead>
            <tbody>{d?.buckets.map((b: any) => <tr key={b.currency}><td>{b.currency}</td>{cols.map(([k]) => <td key={k} className="num">{b[k] ? fmt(b[k]) : "—"}</td>)}</tr>)}</tbody>
          </table>
        )}
      </section>
      <section className="card">
        <h2>8 haftalık ödeme planı (onaylı faturalar)</h2>
        <p className="muted" style={{ margin: 0 }}>{d?.note} Kur dönüşümü yapılmaz; para birimleri ayrı toplanır.</p>
        {weeks.length === 0 ? <Empty>Planlanacak ödeme yok.</Empty> : (
          <table>
            <thead><tr><th>Hafta (Pzt)</th>{currencies.map((c) => <th key={c} className="num">{c}</th>)}</tr></thead>
            <tbody>{weeks.map((w) => <tr key={w}><td>{w}</td>{currencies.map((c) => { const x = d.plan.find((p: any) => p.week === w && p.currency === c); return <td key={c} className="num">{x ? fmt(x.amount) : "—"}</td>; })}</tr>)}</tbody>
          </table>
        )}
      </section>
    </>
  );
}

export function ApPolicyPage() {
  const can = useCan();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["apPolicy"], queryFn: () => get<any>("/api/payables/policy") });
  const [f, setF] = useState({ priceTolerancePct: "", qtyTolerancePct: "", amountTolerance: "", note: "" });
  const save = useMutation({
    mutationFn: () => post("/api/payables/policy", { priceTolerancePct: Number(f.priceTolerancePct.replace(",", ".")), qtyTolerancePct: Number(f.qtyTolerancePct.replace(",", ".")), amountTolerance: Number(f.amountTolerance.replace(",", ".")) || 0, note: f.note }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["apPolicy"] }); setF({ priceTolerancePct: "", qtyTolerancePct: "", amountTolerance: "", note: "" }); },
  });
  const c = q.data?.current;
  return (
    <>
      <Header />
      <section className="card">
        <h2>Eşleştirme toleransı</h2>
        {c ? <p>{c.versionNo ? <b>v{c.versionNo}</b> : <span className="muted">{q.data.defaults}</span>} · fiyat %{c.priceTolerancePct} · miktar %{c.qtyTolerancePct} · tutar {c.amountTolerance}</p> : null}
        <p className="muted" style={{ margin: 0 }}>Fiyat farkı hem yüzde toleransı hem tutar toleransını aşarsa fark sayılır. Miktar toleransı kalite kabul edilen miktara uygulanır. Yeni sürüm yalnız sonraki faturaları etkiler.</p>
        {can("cost.manage") ? (
          <form className="row" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
            <label className="field" style={{ width: 120 }}>Fiyat %<input aria-label="Fiyat toleransı" required inputMode="decimal" value={f.priceTolerancePct} onChange={(e) => setF({ ...f, priceTolerancePct: e.target.value })} /></label>
            <label className="field" style={{ width: 120 }}>Miktar %<input aria-label="Miktar toleransı" required inputMode="decimal" value={f.qtyTolerancePct} onChange={(e) => setF({ ...f, qtyTolerancePct: e.target.value })} /></label>
            <label className="field" style={{ width: 120 }}>Tutar<input aria-label="Tutar toleransı" inputMode="decimal" value={f.amountTolerance} onChange={(e) => setF({ ...f, amountTolerance: e.target.value })} /></label>
            <label className="field" style={{ flex: 1 }}>Gerekçe<input aria-label="Tolerans gerekçesi" required minLength={3} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
            <button className="primary" style={{ alignSelf: "flex-end" }}>Yeni sürüm</button>
          </form>
        ) : null}
        <ErrorNotice error={save.error} />
        {q.data?.history.length ? <table><tbody>{q.data.history.map((h: any) => <tr key={h.versionNo}><td>v{h.versionNo}</td><td>fiyat %{Number(h.priceTolerancePct)} · miktar %{Number(h.qtyTolerancePct)} · tutar {Number(h.amountTolerance)}</td><td>{h.note}</td><td className="muted">{h.createdBy} · {fmtDate(h.createdAt)}</td></tr>)}</tbody></table> : null}
      </section>
    </>
  );
}
