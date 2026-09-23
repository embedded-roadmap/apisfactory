import { useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConfirmResult, ProductSummary, SalesOrder } from "@apisfactory/shared";
import { get, newKey, post } from "../lib/api";
import { OrderDelivery } from "./Shipping";
import { Empty, ErrorNotice, Loading, PageHeader, StateBadge, fmt, fmtDate, useCan } from "../lib/ui";
import { Discussion } from "../components/Discussion";
import { OrderCredit } from "./Receivables";

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
    onError: () => qc.invalidateQueries({ queryKey: ["history"] }),
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
      {(confirm.error as any)?.code === "credit_blocked" ? <div className="notice bad">Kredi kontrolü: sipariş kesinleştirilemedi. Muhasebe/yönetici aşağıdan gerekçeyle serbest bırakabilir.</div> : null}
      {o.status === "draft" ? <OrderCredit order={o as any} /> : null}
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
        </section>
      ) : o.status === "draft" ? <Loading /> : null}
      {!["cancelled", "shipped"].includes(o.status) ? <EstimatePanel id={o.id} /> : null}
      {["firm", "shipped"].includes(o.status) ? <OrderDelivery order={o as any} /> : null}
      {can("sales.cancel") && ["draft", "firm"].includes(o.status) ? <CancelOrder id={o.id} /> : null}
      <Discussion entityType="sales_order" entityId={o.id} />
      <History entityType="sales_order" id={o.id} />
    </>
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

/** Tahmini termin (aralık) ve müşteriye taahhüt tarihi ayrı gösterilir; tahmin taahhüdü sessizce değiştirmez. */
function EstimatePanel({ id }: { id: string }) {
  const can = useCan();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["estimate", id], queryFn: () => get<{ estimate: any; promisedDate: string | null }>(`/api/sales-orders/${id}/estimate`) });
  const refresh = () => { qc.invalidateQueries({ queryKey: ["estimate", id] }); qc.invalidateQueries({ queryKey: ["history"] }); };
  const compute = useMutation({ mutationFn: () => post(`/api/sales-orders/${id}/estimate`), onSuccess: refresh });
  const [date, setDate] = useState("");
  const [note, setNote] = useState("");
  const [risk, setRisk] = useState(false);
  const promise = useMutation({
    mutationFn: () => post(`/api/sales-orders/${id}/promise`, { date, note: note || undefined, acceptRisk: risk }),
    onSuccess: () => { setNote(""); setRisk(false); refresh(); },
  });
  const e = q.data?.estimate;
  const risky = !!e && !!date && (e.status !== "ok" || (e.latest && date < e.latest));
  return (
    <section className="card">
      <div className="row between">
        <h2>Termin</h2>
        <button onClick={() => compute.mutate()} disabled={compute.isPending}>{e ? "Yeniden hesapla" : "Termin hesapla"}</button>
      </div>
      <ErrorNotice error={compute.error ?? q.error} />
      {!e ? <Empty>Henüz hesaplanmadı.</Empty> : (
        <>
          <div className="grid4">
            <div className="stat"><small>Tahmini termin</small><b>{e.status === "ok" ? (e.earliest === e.latest ? e.earliest : `${e.earliest} – ${e.latest}`) : "Hesaplanamadı"}</b><small>{fmtDate(e.computedAt)}</small></div>
            <div className="stat"><small>Malzeme hazır</small><b>{e.materialReadyDate ?? "—"}</b></div>
            <div className="stat"><small>Üretim / kuyruk</small><b>{e.productionDays} / {e.queueDays} gün</b><small>{e.bottleneck ? `darboğaz ${e.bottleneck}` : ""}</small></div>
            <div className="stat"><small>Müşteriye taahhüt</small><b>{q.data?.promisedDate ?? "—"}</b></div>
          </div>
          {e.reasons.length ? <div className="notice warn">{e.reasons.join(" · ")}</div> : null}
          {e.materials.length ? (
            <table>
              <thead><tr><th>Malzeme</th><th className="num">Gerekli</th><th>Kaynak</th><th>Hazır</th></tr></thead>
              <tbody>{e.materials.map((m: any) => <tr key={m.itemCode}><td className="mono">{m.itemCode}</td><td className="num">{fmt(m.requiredQty)}</td><td>{m.source}</td><td>{m.readyDate ?? "—"}</td></tr>)}</tbody>
            </table>
          ) : null}
          <details><summary className="muted">Varsayımlar</summary><ul>{e.assumptions.map((a: string) => <li key={a}>{a}</li>)}</ul></details>
        </>
      )}
      {can("sales.promise") && e ? (
        <form className="row" onSubmit={(ev) => { ev.preventDefault(); promise.mutate(); }}>
          <label className="field">Taahhüt tarihi<input type="date" required value={date} onChange={(ev) => setDate(ev.target.value)} /></label>
          {risky ? (
            <>
              <label className="row" style={{ gap: 6, alignSelf: "flex-end" }}><input type="checkbox" style={{ minHeight: 0 }} checked={risk} onChange={(ev) => setRisk(ev.target.checked)} /> Tahminden erken; riski kabul ediyorum</label>
              <label className="field" style={{ flex: 1 }}>Gerekçe<input value={note} onChange={(ev) => setNote(ev.target.value)} placeholder="Zorunlu" /></label>
            </>
          ) : null}
          <button className="primary" style={{ alignSelf: "flex-end" }} disabled={promise.isPending}>Taahhüdü kaydet</button>
        </form>
      ) : null}
      <ErrorNotice error={promise.error} />
      <p className="muted" style={{ margin: 0 }}>Müşteriye otomatik mesaj gönderilmez.</p>
    </section>
  );
}
