import { useState } from "react";
import { Link, NavLink, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, newKey, post } from "../lib/api";
import { Empty, ErrorNotice, Loading, PageHeader, fmt, fmtDate, useCan } from "../lib/ui";
import { History } from "./Sales";
import { Discussion } from "../components/Discussion";

const ST: Record<string, [string, string]> = { draft: ["taslak", "warn"], issued: ["kesildi — açık", "warn"], paid: ["tahsil edildi", "ok"], cancelled: ["iptal", ""] };
const today = () => new Date().toISOString().slice(0, 10);
const money = (n: number | null | undefined, c?: string) => (n === null || n === undefined ? "—" : `${fmt(String(n))}${c ? ` ${c}` : ""}`);

function Tabs() {
  return (
    <div className="row tabs" role="tablist">
      <NavLink to="/receivables" end>Müşteri faturaları</NavLink>
      <NavLink to="/receivables/aging">Yaşlandırma & kredi</NavLink>
    </div>
  );
}
const Header = () => (
  <>
    <PageHeader title="Alacaklar & tahsilat" sub="Sevk edilen sevkiyattan taslak fatura; kesilen fatura değişmez. Resmi e-fatura/e-arşiv gönderimi yok (belge TASLAK). Sistem tahsilat yapmaz — alınmış ödemenin kaydı tutulur." />
    <Tabs />
  </>
);

export function CustomerInvoicesPage() {
  const can = useCan();
  const qc = useQueryClient();
  const [status, setStatus] = useState("");
  const q = useQuery({ queryKey: ["cinvoices", status], queryFn: () => get<any[]>(`/api/customer-invoices${status ? `?status=${status}` : ""}`) });
  const ship = useQuery({ queryKey: ["uninvoiced"], queryFn: () => get<any[]>("/api/receivables/uninvoiced-shipments"), enabled: can("receivable.manage") });
  const [tax, setTax] = useState("20");
  const make = useMutation({
    mutationFn: (shipmentId: string) => post<any>("/api/customer-invoices/from-shipment", { shipmentId, taxRate: Number(tax.replace(",", ".")) || 0 }, { "Idempotency-Key": newKey() }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["cinvoices"] }); qc.invalidateQueries({ queryKey: ["uninvoiced"] }); },
  });
  return (
    <>
      <Header />
      {can("receivable.manage") ? (
        <section className="card">
          <div className="row between">
            <h2 style={{ margin: 0 }}>Faturası kesilmemiş sevkiyatlar</h2>
            <label className="row" style={{ gap: 6 }}>KDV % <input aria-label="KDV oranı" inputMode="decimal" value={tax} onChange={(e) => setTax(e.target.value)} style={{ width: 70 }} /></label>
          </div>
          <ErrorNotice error={make.error} />
          {ship.data?.length === 0 ? <Empty>Bekleyen sevkiyat yok.</Empty> : null}
          <table><tbody>{ship.data?.map((s) => (
            <tr key={s.id}>
              <td className="mono"><Link to={`/shipments/${s.id}`}>{s.code}</Link></td><td>{s.customerName}</td><td className="mono">{s.orderCode}</td><td className="muted">{fmtDate(s.shippedAt)}</td>
              <td>{s.unpriced ? <span className="badge bad">{s.unpriced} satır fiyatsız</span> : null}</td>
              <td><button disabled={make.isPending} onClick={() => make.mutate(s.id)}>Taslak fatura</button></td>
            </tr>
          ))}</tbody></table>
        </section>
      ) : null}
      <section className="card">
        <div className="row">
          <label className="field">Durum<select aria-label="Müşteri faturası durumu" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Tümü</option>{Object.entries(ST).map(([k, v]) => <option key={k} value={k}>{v[0]}</option>)}</select></label>
        </div>
        {q.isLoading ? <Loading /> : <ErrorNotice error={q.error} />}
        {q.data?.length === 0 ? <Empty>Fatura yok.</Empty> : null}
        {q.data?.length ? (
          <table>
            <thead><tr><th>No</th><th>Müşteri</th><th>Sipariş</th><th>Tarih</th><th>Vade</th><th className="num">Tutar</th><th className="num">Tahsil</th><th>Durum</th></tr></thead>
            <tbody>{q.data.map((x) => (
              <tr key={x.id}>
                <td className="mono"><Link to={`/receivables/${x.id}`}>{x.code}</Link></td><td>{x.customerName}</td><td className="mono">{x.orderCode}</td><td>{x.invoiceDate ?? "—"}</td>
                <td>{x.dueDate ?? "—"} {x.overdue ? <span className="badge bad">vadesi geçti</span> : null}</td><td className="num">{fmt(x.grossAmount)} {x.currency}</td><td className="num">{fmt(x.received)}</td>
                <td><span className={`badge ${ST[x.status]![1]}`}>{ST[x.status]![0]}</span></td>
              </tr>
            ))}</tbody>
          </table>
        ) : null}
      </section>
    </>
  );
}

export function CustomerInvoicePage() {
  const { id } = useParams();
  const can = useCan();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["cinvoice", id], queryFn: () => get<any>(`/api/customer-invoices/${id}`) });
  const act = useMutation({ mutationFn: (f: () => Promise<any>) => f(), onSuccess: () => { qc.invalidateQueries({ queryKey: ["cinvoice", id] }); qc.invalidateQueries({ queryKey: ["history"] }); } });
  const [rc, setRc] = useState({ amount: "", receivedOn: today(), reference: "" });
  const [rcKey, setRcKey] = useState(newKey());
  const [date, setDate] = useState(today());
  const [tax, setTax] = useState<string | null>(null);
  const [cancel, setCancel] = useState("");
  const i = q.data;
  if (!i) return q.isLoading ? <Loading /> : <ErrorNotice error={q.error} />;
  const manage = can("receivable.manage");
  return (
    <>
      <PageHeader title={`${i.code} — ${i.customerName}`} sub={<>sipariş <Link to={`/sales/${i.salesOrderId}`}>{i.salesOrderCode}</Link>{i.shipmentId ? <> · sevkiyat <Link to={`/shipments/${i.shipmentId}`}>{i.shipmentCode}</Link></> : null} · hazırlayan {i.createdBy} · <Link to="/receivables">← Faturalar</Link></>}
        actions={<span className={`badge ${ST[i.status]![1]}`}>{ST[i.status]![0]}</span>} />
      <div className="notice info">Belge modu <span className="badge mode warn">TASLAK</span>: resmi e-fatura/e-arşiv oluşturulmadı ve GİB'e gönderilmedi (W36).</div>
      <ErrorNotice error={act.error} />
      {i.overdue ? <div className="notice warn">Vadesi geçti ({i.dueDate}).</div> : null}
      {i.cancelReason ? <div className="notice">İptal: {i.cancelReason}</div> : null}
      <section className="card">
        <div className="kpis">
          <div className="kpi"><small>Net</small><b>{fmt(i.netAmount)} {i.currency}</b></div>
          <div className="kpi"><small>KDV %{Number(i.taxRate)}</small><b>{fmt(i.taxAmount)}</b></div>
          <div className="kpi"><small>Toplam</small><b>{fmt(i.grossAmount)}</b></div>
          <div className="kpi"><small>Tahsil (kayıt)</small><b>{fmt(i.received)}</b></div>
          <div className="kpi"><small>Açık</small><b>{fmt(i.open)}</b></div>
        </div>
        <p style={{ margin: 0 }}>{i.invoiceDate ? `Fatura tarihi ${i.invoiceDate} · vade ${i.dueDate} · kesen ${i.issuedBy}` : "Henüz kesilmedi."}</p>
        <table>
          <thead><tr><th>#</th><th>Ürün</th><th className="num">Miktar</th><th className="num">Birim fiyat</th><th className="num">Tutar</th></tr></thead>
          <tbody>{i.lines.map((l: any) => <tr key={l.lineNo}><td>{l.lineNo}</td><td className="mono">{l.description}</td><td className="num">{fmt(l.qty)}</td><td className="num">{fmt(l.unitPrice)}</td><td className="num">{fmt(l.amount)}</td></tr>)}</tbody>
        </table>
        {manage && i.status === "draft" ? (
          <div className="row">
            <label className="row" style={{ gap: 6 }}>KDV % <input aria-label="Taslak KDV oranı" inputMode="decimal" value={tax ?? String(Number(i.taxRate))} onChange={(e) => setTax(e.target.value)} style={{ width: 70 }} /></label>
            <button disabled={tax === null} onClick={() => act.mutate(() => post(`/api/customer-invoices/${id}/update`, { taxRate: Number((tax ?? "0").replace(",", ".")) }).then(() => setTax(null)))}>Güncelle</button>
            <label className="row" style={{ gap: 6, marginLeft: "auto" }}>Fatura tarihi <input aria-label="Fatura tarihi" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
            <button className="primary" onClick={() => act.mutate(() => post(`/api/customer-invoices/${id}/issue`, { invoiceDate: date }))}>Faturayı kes</button>
          </div>
        ) : null}
        {manage && ["draft", "issued"].includes(i.status) && Number(i.received) === 0 ? (
          <div className="row">
            <input aria-label="İptal gerekçesi" placeholder="İptal gerekçesi" value={cancel} onChange={(e) => setCancel(e.target.value)} />
            <button className="danger" disabled={cancel.length < 3} onClick={() => act.mutate(() => post(`/api/customer-invoices/${id}/cancel`, { reason: cancel }))}>İptal et</button>
            <span className="muted">Kesilmiş fatura değiştirilemez; düzeltme için iptal edip sevkiyattan yeniden hazırlayın.</span>
          </div>
        ) : null}
      </section>
      <section className="card">
        <h2>Tahsilat kayıtları</h2>
        <p className="muted" style={{ margin: 0 }}>Sistem tahsilat yapmaz; bankaya gelen ödemenin kaydını girin. Kayıt değiştirilemez.</p>
        {i.receipts.length ? <table><tbody>{i.receipts.map((r: any, k: number) => <tr key={k}><td>{r.receivedOn}</td><td className="num">{fmt(r.amount)} {i.currency}</td><td className="mono">{r.reference}</td><td className="muted">{r.recordedBy} · {fmtDate(r.createdAt)}</td></tr>)}</tbody></table> : <Empty>Tahsilat kaydı yok.</Empty>}
        {i.status === "issued" && can("payment.record") ? (
          <form className="row" onSubmit={(e) => { e.preventDefault(); act.mutate(() => post(`/api/customer-invoices/${id}/receipts`, { ...rc, amount: rc.amount.replace(",", ".") }, { "Idempotency-Key": rcKey }).then(() => { setRc({ amount: "", receivedOn: today(), reference: "" }); setRcKey(newKey()); })); }}>
            <label className="field" style={{ width: 130 }}>Tutar<input aria-label="Tahsilat tutarı" required inputMode="decimal" placeholder={i.open} value={rc.amount} onChange={(e) => setRc({ ...rc, amount: e.target.value })} /></label>
            <label className="field">Tarih<input type="date" required value={rc.receivedOn} onChange={(e) => setRc({ ...rc, receivedOn: e.target.value })} /></label>
            <label className="field" style={{ flex: 1 }}>Banka referansı<input aria-label="Tahsilat referansı" required minLength={3} value={rc.reference} onChange={(e) => setRc({ ...rc, reference: e.target.value })} /></label>
            <button className="primary" style={{ alignSelf: "flex-end" }}>Tahsilat kaydı ekle</button>
          </form>
        ) : null}
      </section>
      <Discussion entityType="customer_invoice" entityId={i.id} />
      <History entityType="customer_invoice" id={i.id} />
    </>
  );
}

export function ReceivablesAgingPage() {
  const can = useCan();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["arAging"], queryFn: () => get<any>("/api/receivables/aging") });
  const customers = useQuery({ queryKey: ["customers"], queryFn: () => get<any[]>("/api/customers") });
  const [f, setF] = useState({ customerId: "", creditLimit: "", paymentTermsDays: "30", overdueBlockDays: "", reason: "" });
  const save = useMutation({
    mutationFn: () => post(`/api/customers/${f.customerId}/credit`, { creditLimit: f.creditLimit ? f.creditLimit.replace(",", ".") : null, paymentTermsDays: Number(f.paymentTermsDays) || 0, overdueBlockDays: f.overdueBlockDays ? Number(f.overdueBlockDays) : null, reason: f.reason }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["arAging"] }); setF({ ...f, reason: "" }); },
  });
  const d = q.data;
  return (
    <>
      <Header />
      {q.isLoading ? <Loading /> : <ErrorNotice error={q.error} />}
      <section className="card">
        <h2>Alacak yaşlandırma</h2>
        {d?.buckets.length === 0 ? <Empty>Açık alacak yok.</Empty> : (
          <table>
            <thead><tr><th>Müşteri</th><th>Para</th><th className="num">Vadesi gelmemiş</th><th className="num">1–30 geçmiş</th><th className="num">31–60</th><th className="num">60+</th><th className="num">Toplam</th></tr></thead>
            <tbody>{d?.buckets.map((b: any) => <tr key={b.customerId + b.currency}><td>{b.customerName}</td><td>{b.currency}</td>{["current", "over1", "over31", "over60", "total"].map((k) => <td key={k} className="num">{b[k] ? fmt(b[k]) : "—"}</td>)}</tr>)}</tbody>
          </table>
        )}
      </section>
      <section className="card">
        <h2>Kredi riski</h2>
        <p className="muted" style={{ margin: 0 }}>Risk = açık alacak + faturalanmamış kesin siparişler (KDV hariç). Limit aşımı veya izin verilen günden fazla gecikmiş alacak, yeni siparişin kesinleşmesini engeller; yetkili sipariş bazında gerekçeyle serbest bırakabilir.</p>
        {d?.credit.length ? (
          <table>
            <thead><tr><th>Müşteri</th><th className="num">Limit</th><th className="num">Açık alacak</th><th className="num">Gecikmiş</th><th className="num">Faturalanmamış sipariş</th><th className="num">Risk</th><th className="num">Kullanılabilir</th><th>Durum</th></tr></thead>
            <tbody>{d.credit.map((c: any) => (
              <tr key={c.customerId}>
                <td>{c.customer}<div className="muted" style={{ fontSize: 13 }}>vade {c.paymentTermsDays} g{c.overdueBlockDays !== null ? ` · gecikme sınırı ${c.overdueBlockDays} g` : ""}</div></td>
                <td className="num">{money(c.creditLimit, c.currency)}</td><td className="num">{money(c.openReceivables)}</td>
                <td className="num">{c.overdueAmount ? <>{money(c.overdueAmount)}<div className="muted">{c.maxOverdueDays} gün</div></> : "—"}</td>
                <td className="num">{money(c.uninvoicedOrders)}</td><td className="num"><b>{money(c.exposure)}</b></td><td className="num">{money(c.available)}</td>
                <td>{c.blocked ? <span className="badge bad" title={c.reasons.join("; ")}>engelli</span> : <span className="badge ok">açık</span>}</td>
              </tr>
            ))}</tbody>
          </table>
        ) : <Empty>Kredi tanımlı veya açık alacağı olan müşteri yok.</Empty>}
        {can("receivable.manage") ? (
          <form className="row" style={{ flexWrap: "wrap" }} onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
            <label className="field">Müşteri<select aria-label="Kredi müşterisi" required value={f.customerId} onChange={(e) => setF({ ...f, customerId: e.target.value })}><option value="">Seçin</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}</select></label>
            <label className="field" style={{ width: 130 }}>Kredi limiti (TRY)<input aria-label="Kredi limiti" inputMode="decimal" placeholder="boş = limitsiz" value={f.creditLimit} onChange={(e) => setF({ ...f, creditLimit: e.target.value })} /></label>
            <label className="field" style={{ width: 100 }}>Vade (gün)<input aria-label="Müşteri vadesi" inputMode="numeric" value={f.paymentTermsDays} onChange={(e) => setF({ ...f, paymentTermsDays: e.target.value })} /></label>
            <label className="field" style={{ width: 150 }}>Gecikme sınırı (gün)<input aria-label="Gecikme sınırı" inputMode="numeric" placeholder="boş = yok" value={f.overdueBlockDays} onChange={(e) => setF({ ...f, overdueBlockDays: e.target.value })} /></label>
            <label className="field" style={{ flex: 1 }}>Gerekçe<input aria-label="Kredi gerekçesi" required minLength={3} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></label>
            <button className="primary" style={{ alignSelf: "flex-end" }}>Kaydet</button>
          </form>
        ) : null}
        <ErrorNotice error={save.error} />
      </section>
    </>
  );
}

/** Sipariş sayfasında kredi durumu ve (yetkiliyse) gerekçeli serbest bırakma. */
export function OrderCredit({ order }: { order: { id: string; customerId: string; status: string; creditReleaseReason?: string | null; creditReleasedAt?: string | null } }) {
  const can = useCan();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["credit", order.customerId], queryFn: () => get<any>(`/api/customers/${order.customerId}/credit`), enabled: can("receivable.view") });
  const [reason, setReason] = useState("");
  const rel = useMutation({ mutationFn: () => post(`/api/sales-orders/${order.id}/credit-release`, { reason }), onSuccess: () => { qc.invalidateQueries({ queryKey: ["order", order.id] }); qc.invalidateQueries({ queryKey: ["history"] }); } });
  const c = q.data;
  if (!c) return null;
  return (
    <section className="card">
      <h2>Müşteri kredi durumu</h2>
      <p style={{ margin: 0 }}>
        Limit {money(c.creditLimit, c.currency)} · açık alacak {money(c.openReceivables)} · faturalanmamış sipariş {money(c.uninvoicedOrders)} · risk <b>{money(c.exposure)}</b>
        {c.maxOverdueDays ? <> · en eski gecikme <b>{c.maxOverdueDays} gün</b></> : null}
      </p>
      <p className="muted" style={{ margin: 0 }}>Bu siparişin tutarı kesinleştirmede riske eklenir. {c.warnings.join(" ")}</p>
      {order.creditReleasedAt ? <div className="notice">Kredi engeli bu sipariş için kaldırıldı: {order.creditReleaseReason}</div> : null}
      {!order.creditReleasedAt && ["draft", "availability_review"].includes(order.status) && can("credit.override") ? (
        <div className="row">
          <input aria-label="Kredi serbest bırakma gerekçesi" placeholder="Engel varsa bu sipariş için gerekçeyle serbest bırak (en az 10 karakter)" value={reason} onChange={(e) => setReason(e.target.value)} style={{ flex: 1 }} />
          <button disabled={reason.length < 10 || rel.isPending} onClick={() => rel.mutate()}>Serbest bırak</button>
        </div>
      ) : null}
      <ErrorNotice error={rel.error} />
    </section>
  );
}
