import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, post } from "../lib/api";
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
      <ErrorNotice error={decide.error} />
      <section className="card">
        <h2>Satın alma talepleri</h2>
        {prs.isLoading ? <Loading /> : <ErrorNotice error={prs.error} />}
        {prs.data?.length === 0 ? <Empty /> : null}
        {prs.data && prs.data.length > 0 ? (
          <table>
            <thead><tr><th>Talep</th><th>Kalem</th><th className="num">Miktar</th><th>İhtiyaç tarihi</th><th>Kaynak</th><th>Durum</th><th /></tr></thead>
            <tbody>
              {prs.data.map((p) => (
                <tr key={p.id}>
                  <td className="mono">{p.code}</td>
                  <td><span className="mono">{p.itemCode}</span><div className="muted">{p.manufacturer} {p.mpn}</div></td>
                  <td className="num">{fmt(p.qty)}</td><td>{p.needDate ?? "—"}</td>
                  <td className="muted">{p.sourceType === "production_need" ? "Üretim ihtiyacı" : p.sourceType}</td>
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
