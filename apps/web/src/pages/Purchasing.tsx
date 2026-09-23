import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, post, newKey } from "../lib/api";
import { Empty, ErrorNotice, Loading, PageHeader, StateBadge, fmt, useCan } from "../lib/ui";

export function PurchasingPage() {
  const can = useCan();
  const qc = useQueryClient();
  const prs = useQuery({ queryKey: ["prs"], queryFn: () => get<any[]>("/api/purchase-requests") });
  const pos = useQuery({ queryKey: ["pos"], queryFn: () => get<any[]>("/api/purchase-order-lines") });
  const [note, setNote] = useState<Record<string, string>>({});
  const decide = useMutation({
    mutationFn: (v: { id: string; decision: "approve" | "reject" }) => post(`/api/purchase-requests/${v.id}/decision`, { decision: v.decision, note: note[v.id] || undefined }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["prs"] }),
  });
  return (
    <>
      <PageHeader title="Satın alma" sub="Talep onayı tedarikçiye sipariş göndermez. Dış gönderim bağlayıcısı bu fazda bağlı değil." />
      <div className="notice info">Tedarikçi sipariş gönderimi: <span className="badge mode">BAĞLANMADI</span> — bütçe/fiyat sapma kuralları ve test bağlayıcısı W18'de.</div>
      {can("purchase.request.create") ? <NewRequest /> : null}
      <ErrorNotice error={decide.error} />
      {decide.data && (decide.data as any).onBehalfOf ? <div className="notice">Karar vekâleten kaydedildi.</div> : null}
      <section className="card">
        <h2>Satın alma talepleri</h2>
        {prs.isLoading ? <Loading /> : <ErrorNotice error={prs.error} />}
        {prs.data?.length === 0 ? <Empty /> : null}
        {prs.data && prs.data.length > 0 ? (
          <table>
            <thead><tr><th>Talep</th><th>Kalem</th><th className="num">Miktar</th><th>İhtiyaç tarihi</th><th>Kaynak / talep eden</th><th className="num">Tahmini tutar</th><th>Durum</th><th /></tr></thead>
            <tbody>
              {prs.data.map((p) => (
                <tr key={p.id}>
                  <td className="mono">{p.code}</td>
                  <td><span className="mono">{p.itemCode}</span><div className="muted">{p.manufacturer} {p.mpn}</div></td>
                  <td className="num">{fmt(p.qty)}</td><td>{p.needDate ?? "—"}</td>
                  <td className="muted">{p.sourceType === "production_need" ? "Üretim ihtiyacı" : p.sourceType === "manual" ? "Elle talep" : p.sourceType}{p.requestedBy ? ` · ${p.requestedBy}` : ""}{p.note ? <div>{p.note}</div> : null}</td>
                  <td className="num">{p.estimatedAmount ? `${fmt(p.estimatedAmount)} ${p.currency}` : p.amountSource ? <span className="muted" title={p.amountSource}>bilinmiyor</span> : "—"}</td>
                  <td><StateBadge value={p.status} /></td>
                  <td>
                    {can("purchase.request.approve") && p.status === "open" ? (
                      <div className="row">
                        <input aria-label="Not" placeholder="Not / ret gerekçesi" value={note[p.id] ?? ""} onChange={(e) => setNote({ ...note, [p.id]: e.target.value })} />
                        <button className="primary" onClick={() => decide.mutate({ id: p.id, decision: "approve" })}>Onayla</button>
                        <button className="danger" onClick={() => decide.mutate({ id: p.id, decision: "reject" })}>Reddet</button>
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>
      <section className="card">
        <h2>Açık satın alma siparişleri</h2>
        {pos.data?.length === 0 ? <Empty /> : null}
        <table>
          <tbody>
            {pos.data?.map((p) => (
              <tr key={p.id}><td className="mono">{p.poCode}</td><td>{p.supplierName}</td><td className="mono">{p.itemCode}</td><td className="num">{fmt(p.qtyOrdered)}</td><td className="num">alındı {fmt(p.qtyReceived)}</td><td>{p.confirmedDate ? `teyit ${p.confirmedDate}` : <span className="badge warn">teyitsiz</span>}</td></tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

function NewRequest() {
  const qc = useQueryClient();
  const items = useQuery({ queryKey: ["items", "all"], queryFn: () => get<any[]>("/api/items") });
  const [f, setF] = useState({ itemId: "", qty: "", needDate: "", note: "" });
  const [key, setKey] = useState(newKey());
  const create = useMutation({
    mutationFn: () => post<any>("/api/purchase-requests", { ...f, needDate: f.needDate || undefined }, { "Idempotency-Key": key }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["prs"] }); setF({ itemId: "", qty: "", needDate: "", note: "" }); setKey(newKey()); },
  });
  return (
    <section className="card">
      <h2>Yeni satın alma talebi</h2>
      <form className="row" onSubmit={(e: FormEvent) => { e.preventDefault(); create.mutate(); }}>
        <label className="field">Kalem<select aria-label="Talep kalemi" required value={f.itemId} onChange={(e) => setF({ ...f, itemId: e.target.value })}><option value="">Seçin</option>{items.data?.map((i) => <option key={i.id} value={i.id}>{i.code} — {i.name}</option>)}</select></label>
        <label className="field" style={{ width: 110 }}>Miktar<input aria-label="Talep miktarı" required inputMode="decimal" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} /></label>
        <label className="field">İhtiyaç tarihi<input type="date" value={f.needDate} onChange={(e) => setF({ ...f, needDate: e.target.value })} /></label>
        <label className="field" style={{ flex: 1 }}>Gerekçe<input aria-label="Talep gerekçesi" required minLength={3} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
        <button className="primary" style={{ alignSelf: "flex-end" }} disabled={create.isPending}>Talep aç</button>
      </form>
      <ErrorNotice error={create.error} />
      {create.data ? <div className="notice">{create.data.code} açıldı · tahmini tutar: {create.data.estimatedAmount ? `${fmt(create.data.estimatedAmount)} ${create.data.currency}` : "bilinmiyor"} ({create.data.amountSource}). Kendi talebinizi onaylayamazsınız.</div> : null}
    </section>
  );
}
