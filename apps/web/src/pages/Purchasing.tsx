import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { PurchasingTabs } from "./Procurement";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, post, newKey } from "../lib/api";
import { Empty, ErrorNotice, Loading, PageHeader, StateBadge, fmt, useCan, useMe } from "../lib/ui";

export function PurchasingPage() {
  const can = useCan();
  const nav = useNavigate();
  const qc = useQueryClient();
  const rfq = useMutation({ mutationFn: (purchaseRequestId: string) => post<any>("/api/rfqs", { purchaseRequestId }), onSuccess: (r) => nav(`/purchasing/rfqs/${r.id}`) });
  const prs = useQuery({ queryKey: ["prs"], queryFn: () => get<any[]>("/api/purchase-requests") });
  // Kendi talebinde onay düğmesi yalnız politika izin veriyorsa gösterilir (bot testi: düğme görünüp hep hata veriyordu).
  const myId = useMe().me?.user.id;
  const policies = useQuery({ queryKey: ["workflowPolicies"], queryFn: () => get<any>("/api/workflow/policies") });
  const selfAllowed = !!policies.data?.current?.find((c: any) => c.kind === "purchase_request")?.policy?.allowSelfApproval;
  const [note, setNote] = useState<Record<string, string>>({});
  const decide = useMutation({
    mutationFn: (v: { id: string; decision: "approve" | "reject" }) => post(`/api/purchase-requests/${v.id}/decision`, { decision: v.decision, note: note[v.id] || undefined }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["prs"] }),
  });
  return (
    <>
      <PageHeader title="Satın alma" sub="Talep onayı tedarikçiye sipariş göndermez. Dış gönderim bağlayıcısı bu fazda bağlı değil." />
      <PurchasingTabs />
      <div className="notice info">Tedarikçi sipariş gönderimi: <span className="badge mode warn">TEST</span> — sipariş ve hatırlatmalar çıkış kutusuna yazılır, tedarikçiye gerçek gönderim yok.</div>
      <ErrorNotice error={rfq.error} />
      {can("purchase.request.create") ? <NewRequest /> : null}
      <ErrorNotice error={decide.error} />
      {decide.data && (decide.data as any).onBehalfOf ? <div className="notice">Karar vekâleten kaydedildi.</div> : null}
      <section className="card">
        <h2>Satın alma talepleri</h2>
        {prs.isLoading ? <Loading /> : <ErrorNotice error={prs.error} />}
        {prs.data?.length === 0 ? <Empty /> : null}
        {prs.data && prs.data.length > 0 ? (
          <table>
            <thead><tr><th>Talep</th><th>Kalem</th><th className="num">Miktar</th><th>İhtiyaç tarihi</th><th>Kaynak / talep eden</th><th>Proje / maliyet merkezi</th><th className="num">Tahmini tutar</th><th>Durum</th><th /></tr></thead>
            <tbody>
              {prs.data.map((p) => (
                <tr key={p.id}>
                  <td className="mono">{p.code}</td>
                  <td><span className="mono">{p.itemCode}</span><div className="muted">{p.manufacturer} {p.mpn}</div></td>
                  <td className="num">{fmt(p.qty)}</td><td>{p.needDate ?? "—"}</td>
                  <td className="muted">{p.sourceType === "production_need" ? "Üretim ihtiyacı" : p.sourceType === "manual" ? "Elle talep" : p.sourceType}{p.requestedBy ? ` · ${p.requestedBy}` : ""}{p.note ? <div>{p.note}</div> : null}</td>
                  <td className="muted">{p.projectCode ? <span className="mono">{p.projectCode}</span> : "—"}{p.costCenter ? <div>{p.costCenter}</div> : null}</td>
                  <td className="num">{p.estimatedAmount ? `${fmt(p.estimatedAmount)} ${p.currency}` : p.amountSource ? <span className="muted" title={p.amountSource}>bilinmiyor</span> : "—"}</td>
                  <td><StateBadge value={p.status} /></td>
                  <td>
                    {can("purchase.request.approve") && p.status === "open" && p.requestedById === myId && !selfAllowed ? (
                      <span className="muted">Kendi talebiniz — başka bir yetkili onaylar</span>
                    ) : can("purchase.request.approve") && p.status === "open" ? (
                      <div className="row">
                        <input aria-label="Not" placeholder="Not / ret gerekçesi" value={note[p.id] ?? ""} onChange={(e) => setNote({ ...note, [p.id]: e.target.value })} />
                        <button className="primary" onClick={() => decide.mutate({ id: p.id, decision: "approve" })}>Onayla</button>
                        <button className="danger" onClick={() => decide.mutate({ id: p.id, decision: "reject" })}>Reddet</button>
                      </div>
                    ) : null}
                    {can("purchase.order.manage") && p.status === "approved" ? <button onClick={() => rfq.mutate(p.id)}>Teklif iste</button> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>
    </>
  );
}

function NewRequest() {
  const can = useCan();
  const qc = useQueryClient();
  const items = useQuery({ queryKey: ["items", "all"], queryFn: () => get<any[]>("/api/items") });
  const projects = useQuery({ queryKey: ["rd-projects", "open"], queryFn: () => get<any[]>("/api/rd-projects?status=open"), enabled: can("rd.project.view") });
  const [f, setF] = useState({ itemId: "", qty: "", needDate: "", note: "", projectId: "", costCenter: "" });
  const [key, setKey] = useState(newKey());
  const create = useMutation({
    mutationFn: () => post<any>("/api/purchase-requests", { ...f, needDate: f.needDate || undefined, projectId: f.projectId || undefined, costCenter: f.costCenter || undefined }, { "Idempotency-Key": key }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["prs"] }); setF({ itemId: "", qty: "", needDate: "", note: "", projectId: "", costCenter: "" }); setKey(newKey()); },
  });
  return (
    <section className="card">
      <h2>Yeni satın alma talebi</h2>
      <form className="row" onSubmit={(e: FormEvent) => { e.preventDefault(); create.mutate(); }}>
        <label className="field">Kalem<select aria-label="Talep kalemi" required value={f.itemId} onChange={(e) => setF({ ...f, itemId: e.target.value })}><option value="">Seçin</option>{/* Mamul (kendi ürettiğimiz ürün) satın alma talebine konmaz — bot testi bulgusu */}
              {items.data?.filter((i) => i.kind !== "product").map((i) => <option key={i.id} value={i.id}>{i.code} — {i.name}</option>)}</select></label>
        <label className="field" style={{ width: 110 }}>Miktar<input aria-label="Talep miktarı" required inputMode="decimal" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} /></label>
        <label className="field">İhtiyaç tarihi<input type="date" value={f.needDate} onChange={(e) => setF({ ...f, needDate: e.target.value })} /></label>
        {can("rd.project.view") ? (
          <label className="field">Ar-Ge projesi (opsiyonel)<select aria-label="Proje" value={f.projectId} onChange={(e) => setF({ ...f, projectId: e.target.value })}><option value="">Yok</option>{projects.data?.map((p) => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}</select></label>
        ) : null}
        <label className="field">Maliyet merkezi<input aria-label="Maliyet merkezi" placeholder={f.projectId ? "projeden alınır" : ""} value={f.costCenter} onChange={(e) => setF({ ...f, costCenter: e.target.value })} /></label>
        <label className="field" style={{ flex: 1 }}>Gerekçe<input aria-label="Talep gerekçesi" required minLength={3} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
        <button className="primary" style={{ alignSelf: "flex-end" }} disabled={create.isPending}>Talep aç</button>
      </form>
      {f.projectId ? <div className="muted">Proje bağlıyken önce mevcut serbest stoktan karşılama değerlendirilir; yalnızca kalan miktar satın almaya aktarılır.</div> : null}
      <ErrorNotice error={create.error} />
      {create.data && create.data.covered ? (
        <div className="notice">Talep edilen {fmt(create.data.requestedQty)} adedin tamamı mevcut stoktan karşılandı — satın alma talebi açılmadı.</div>
      ) : create.data ? (
        <div className="notice">
          {create.data.code} açıldı{create.data.coveredQty && Number(create.data.coveredQty) > 0 ? ` (${fmt(create.data.coveredQty)} adet stoktan karşılandı, ${fmt(create.data.forwardedQty)} adet satın almaya yönlendirildi)` : ""}
          · tahmini tutar: {create.data.estimatedAmount ? `${fmt(create.data.estimatedAmount)} ${create.data.currency}` : "bilinmiyor"} ({create.data.amountSource}). Kendi talebinizi onaylayamazsınız.
        </div>
      ) : null}
    </section>
  );
}
