import { useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConfirmResult, ProductSummary, SalesOrder } from "@apisfactory/shared";
import { get, newKey, post } from "../lib/api";
import { Empty, ErrorNotice, Loading, PageHeader, StateBadge, fmt, fmtDate, useCan } from "../lib/ui";

export function SalesPage() {
  const can = useCan();
  const nav = useNavigate();
  const orders = useQuery({ queryKey: ["orders"], queryFn: () => get<any[]>("/api/sales-orders") });
  return (
    <>
      <PageHeader title="Satış & Termin" sub="Teklif taslağı ile kesin sipariş ayrıdır. Kesinleştirme uygunluk ve devir kontrolünden geçer." />
      {can("sales.create") ? <NewOrder onCreated={(id) => nav(`/sales/${id}`)} /> : null}
      <section className="card">
        {orders.isLoading ? <Loading /> : <ErrorNotice error={orders.error} />}
        {orders.data?.length === 0 ? <Empty /> : null}
        {orders.data && orders.data.length > 0 ? (
          <table>
            <thead><tr><th>Sipariş</th><th>Müşteri</th><th>İstenen tarih</th><th className="num">Miktar</th><th>Durum</th></tr></thead>
            <tbody>
              {orders.data.map((o) => (
                <tr key={o.id} className="click" onClick={() => nav(`/sales/${o.id}`)}>
                  <td className="mono">{o.code}</td><td>{o.customerName}</td><td>{o.requestedDate}</td><td className="num">{fmt(o.totalQty)}</td><td><StateBadge value={o.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>
    </>
  );
}

function NewOrder({ onCreated }: { onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const customers = useQuery({ queryKey: ["customers"], queryFn: () => get<{ id: string; name: string }[]>("/api/customers") });
  const products = useQuery({ queryKey: ["products"], queryFn: () => get<ProductSummary[]>("/api/products") });
  const [f, setF] = useState({ customerId: "", revisionId: "", qty: "", unitPrice: "", requestedDate: "" });
  const create = useMutation({
    mutationFn: () =>
      post<SalesOrder>("/api/sales-orders", {
        customerId: f.customerId,
        requestedDate: f.requestedDate,
        lines: [{ productRevisionId: f.revisionId, qty: f.qty, unitPrice: f.unitPrice || undefined, currency: "TRY" }],
      }),
    onSuccess: (o) => { qc.invalidateQueries({ queryKey: ["orders"] }); onCreated(o.id); },
  });
  const revs = products.data?.flatMap((p) => p.revisions.map((r) => ({ ...r, label: `${p.code} Rev.${r.rev}` }))) ?? [];
  return (
    <form className="card" onSubmit={(e: FormEvent) => { e.preventDefault(); create.mutate(); }}>
      <h2>Yeni sipariş taslağı</h2>
      <ErrorNotice error={create.error} />
      <div className="grid4">
        <label className="field">Müşteri
          <select required value={f.customerId} onChange={(e) => setF({ ...f, customerId: e.target.value })}>
            <option value="">Seçin…</option>
            {customers.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="field">Ürün / revizyon
          <select required value={f.revisionId} onChange={(e) => setF({ ...f, revisionId: e.target.value })}>
            <option value="">Seçin…</option>
            {revs.map((r) => <option key={r.id} value={r.id}>{r.label} {r.status !== "released" ? "(devir tamamlanmadı)" : ""}</option>)}
          </select>
        </label>
        <label className="field">Miktar<input required inputMode="decimal" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} /></label>
        <label className="field">İstenen tarih<input required type="date" value={f.requestedDate} onChange={(e) => setF({ ...f, requestedDate: e.target.value })} /></label>
        <label className="field">Birim fiyat (TRY)<input inputMode="decimal" value={f.unitPrice} onChange={(e) => setF({ ...f, unitPrice: e.target.value })} /></label>
      </div>
      <div><button className="primary" disabled={create.isPending}>Taslak oluştur</button></div>
    </form>
  );
}

export function SalesOrderPage() {
  const { id } = useParams();
  const can = useCan();
  const qc = useQueryClient();
  const order = useQuery({ queryKey: ["order", id], queryFn: () => get<SalesOrder & { confirmResult: ConfirmResult | null }>(`/api/sales-orders/${id}`) });
  const avail = useQuery({ queryKey: ["availability", id], queryFn: () => get<any>(`/api/sales-orders/${id}/availability`), enabled: order.data?.status === "draft" });
  const [key] = useState(newKey());
  const confirm = useMutation({
    mutationFn: () => post<ConfirmResult>(`/api/sales-orders/${id}/confirm`, undefined, { "idempotency-key": key }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["order", id] }); qc.invalidateQueries({ queryKey: ["history"] }); },
  });
  if (order.isLoading) return <Loading />;
  if (order.error) return <ErrorNotice error={order.error} />;
  const o = order.data!;
  const plan: ConfirmResult["lines"] | undefined = o.confirmResult?.lines ?? avail.data?.lines;
  return (
    <>
      <PageHeader title={`Sipariş ${o.code}`} sub={`${o.customerName} · istenen tarih ${o.requestedDate}`} actions={<StateBadge value={o.status} />} />
      <section className="card">
        <table>
          <thead><tr><th>Ürün</th><th className="num">Miktar</th><th className="num">Birim fiyat</th></tr></thead>
          <tbody>
            {o.lines.map((l) => (
              <tr key={l.id}><td className="mono">{l.productCode} Rev.{l.rev}</td><td className="num">{fmt(l.qty)}</td><td className="num">{l.unitPrice === undefined ? <span className="muted">gizli</span> : `${fmt(l.unitPrice)} ${l.currency}`}</td></tr>
            ))}
          </tbody>
        </table>
      </section>
      {o.status === "draft" && avail.data && !avail.data.canConfirm ? (
        <div className="notice bad">
          Devir onayı tamamlanmamış ürün var; kesin sipariş açılamaz: {avail.data.blockedLines.map((b: any) => `${b.product} (${b.status})`).join(", ")}
        </div>
      ) : null}
      <ErrorNotice error={confirm.error} />
      {plan ? (
        <section className="card">
          <div className="row between">
            <h2>{o.status === "firm" ? "Kesinleştirme sonucu" : "Uygunluk önizlemesi (kayıt yazılmadı)"}</h2>
            {o.status === "draft" && can("sales.confirm") ? (
              <button className="primary" disabled={confirm.isPending || (avail.data && !avail.data.canConfirm)} onClick={() => confirm.mutate()}>Siparişi kesinleştir</button>
            ) : null}
          </div>
          {plan.map((l) => (
            <div key={l.lineId} className="stack">
              <div className="grid4">
                <div className="stat"><small>Bitmiş stoktan rezerve</small><b>{fmt(l.reservedQty)}</b></div>
                <div className="stat"><small>Üretim ihtiyacı</small><b>{fmt(l.productionNeedQty)}</b></div>
              </div>
              {l.materials.length > 0 ? (
                <table>
                  <thead><tr><th>Malzeme</th><th className="num">Brüt</th><th className="num">Stoktan</th><th className="num">Teyitli açık alımdan</th><th className="num">Net ihtiyaç</th><th>Talep</th></tr></thead>
                  <tbody>
                    {l.materials.map((m) => (
                      <tr key={m.itemId}>
                        <td className="mono">{m.itemCode}</td><td className="num">{fmt(m.grossQty)}</td><td className="num">{fmt(m.reservedQty)}</td>
                        <td className="num">{fmt(m.openPurchaseQty)}</td><td className="num"><b>{fmt(m.netQty)}</b></td>
                        <td>{m.purchaseRequestId ? <span className="badge warn">Açıldı</span> : Number(m.netQty) > 0 ? <span className="muted">onayda açılır</span> : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </div>
          ))}
          <p className="muted" style={{ margin: 0 }}>Termin hesabı (kapasite, vardiya, test) bu fazda yok; müşteriye taahhüt tarihi ayrıca girilecek (W16).</p>
        </section>
      ) : o.status === "draft" ? <Loading /> : null}
      {o.status === "firm" ? <Shipments order={o} /> : null}
      {can("sales.cancel") && ["draft", "firm"].includes(o.status) ? <CancelOrder id={o.id} /> : null}
      <History entityType="sales_order" id={o.id} />
    </>
  );
}

function Shipments({ order }: { order: SalesOrder }) {
  const can = useCan();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["shipments", order.id], queryFn: () => get<any[]>(`/api/sales-orders/${order.id}/shipments`), enabled: can("shipment.view") });
  const [qty, setQty] = useState("");
  const [key, setKey] = useState(newKey());
  const line = order.lines[0]!;
  const ship = useMutation({
    mutationFn: () => post(`/api/sales-orders/${order.id}/ship`, { lineId: line.id, qty }, { "idempotency-key": key }),
    onSuccess: () => { setQty(""); setKey(newKey()); qc.invalidateQueries({ queryKey: ["shipments", order.id] }); qc.invalidateQueries({ queryKey: ["history"] }); },
  });
  return (
    <section className="card">
      <h2>Sevkiyat</h2>
      <p className="muted" style={{ margin: 0 }}>Yalnızca bu satıra ayrılmış ve son kaliteden geçmiş bitmiş ürün sevk edilir. İrsaliye/fatura sağlayıcısı bağlı değil; belge <span className="badge mode">TASLAK</span> olarak işaretlenir.</p>
      {can("shipment.create") ? (
        <div className="row">
          <label className="field">Miktar ({line.productCode} Rev.{line.rev})<input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} /></label>
          <button className="primary" style={{ alignSelf: "flex-end" }} disabled={!qty || ship.isPending} onClick={() => ship.mutate()}>Sevk et</button>
        </div>
      ) : null}
      <ErrorNotice error={ship.error} />
      {list.data?.length === 0 ? <Empty>Henüz sevkiyat yok.</Empty> : null}
      <table>
        <tbody>
          {list.data?.map((s) => <tr key={s.id}><td className="mono">{s.code}</td><td className="num">{fmt(s.qty)}</td><td><span className="badge mode">{s.documentMode === "draft" ? "TASLAK BELGE" : s.documentMode}</span></td><td className="muted">{fmtDate(s.shippedAt)} · {s.shippedBy}</td></tr>)}
        </tbody>
      </table>
    </section>
  );
}

function CancelOrder({ id }: { id: string }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState("");
  const cancel = useMutation({
    mutationFn: () => post<any>(`/api/sales-orders/${id}/cancel`, { reason }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["order", id] }); qc.invalidateQueries({ queryKey: ["history"] }); },
  });
  const impact = cancel.data?.impact;
  return (
    <section className="card">
      <h2>Siparişi iptal et</h2>
      <p className="muted" style={{ margin: 0 }}>Rezervasyonlar bırakılır; başlamamış üretim ihtiyacı ve açık satın alma talepleri iptal edilir. Başlamış iş emri ve onaylanmış talepler için ayrı karar gerekir.</p>
      <ErrorNotice error={cancel.error} />
      {impact ? (
        <div className="notice warn">
          İptal edildi. Bırakılan rezervasyon: {impact.releasedReservations} · iptal edilen ihtiyaç: {impact.cancelledNeeds} · iptal edilen talep: {impact.cancelledPurchaseRequests}
          {impact.workOrdersInProgress.length ? ` · devam eden iş emri: ${impact.workOrdersInProgress.join(", ")}` : ""}
          {impact.approvedPurchaseRequests.length ? ` · tedarikçi iptali değerlendirilecek: ${impact.approvedPurchaseRequests.join(", ")}` : ""}
        </div>
      ) : (
        <div className="row">
          <input aria-label="İptal gerekçesi" placeholder="Gerekçe (zorunlu)" value={reason} onChange={(e) => setReason(e.target.value)} style={{ flex: 1 }} />
          <button className="danger" disabled={reason.length < 3 || cancel.isPending} onClick={() => cancel.mutate()}>İptal et</button>
        </div>
      )}
    </section>
  );
}

export function History({ entityType, id }: { entityType: string; id: string }) {
  const q = useQuery({ queryKey: ["history", entityType, id], queryFn: () => get<any[]>(`/api/history/${entityType}/${id}`) });
  return (
    <section className="card">
      <h2>İşlem geçmişi</h2>
      {q.data?.length === 0 ? <Empty /> : null}
      <table>
        <tbody>
          {q.data?.map((e) => (
            <tr key={e.id}><td className="muted">{fmtDate(e.createdAt)}</td><td className="mono">{e.eventType}</td><td>{e.actorName ?? e.actorKind}</td><td>{e.reason ?? ""}</td></tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
