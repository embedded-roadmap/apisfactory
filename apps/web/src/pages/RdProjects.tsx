import { useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, post } from "../lib/api";
import { Empty, ErrorNotice, Loading, PageHeader, StateBadge, fmt, useCan } from "../lib/ui";
import { RD_CATEGORY_LABEL, RdProjectCost } from "../components/RdCost";

export function RdProjectsPage() {
  const can = useCan();
  const nav = useNavigate();
  const qc = useQueryClient();
  const projects = useQuery({ queryKey: ["rd-projects"], queryFn: () => get<any[]>("/api/rd-projects") });
  const [f, setF] = useState({ name: "", costCenter: "", budgetAmount: "", currency: "TRY", note: "" });
  const create = useMutation({
    mutationFn: () => post<any>("/api/rd-projects", { ...f, budgetAmount: f.budgetAmount || undefined, currency: f.budgetAmount ? f.currency : undefined }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ["rd-projects"] }); nav(`/rd-projects/${r.id}`); },
  });
  return (
    <>
      <PageHeader title="Ar-Ge projeleri" sub="Malzeme talebi bir projeye bağlanınca maliyet merkezi projeden miras alınır ve muhasebe giderin hangi projeye ait olduğunu görür (R04)." />
      {can("rd.project.manage") ? (
        <section className="card">
          <h2>Yeni proje</h2>
          <form className="row" onSubmit={(e: FormEvent) => { e.preventDefault(); create.mutate(); }}>
            <label className="field" style={{ flex: 1 }}>Ad<input aria-label="Proje adı" required minLength={2} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
            <label className="field">Maliyet merkezi<input aria-label="Maliyet merkezi" value={f.costCenter} onChange={(e) => setF({ ...f, costCenter: e.target.value })} /></label>
            <label className="field" style={{ width: 130 }}>Bütçe<input aria-label="Bütçe" inputMode="decimal" placeholder="boş = yok" value={f.budgetAmount} onChange={(e) => setF({ ...f, budgetAmount: e.target.value })} /></label>
            {f.budgetAmount ? (
              <label className="field" style={{ width: 90 }}>Para birimi<input aria-label="Para birimi" maxLength={3} value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} /></label>
            ) : null}
            <label className="field" style={{ flex: 1 }}>Not<input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
            <button className="primary" style={{ alignSelf: "flex-end" }} disabled={create.isPending}>Proje aç</button>
          </form>
          <ErrorNotice error={create.error} />
        </section>
      ) : null}
      <section className="card">
        <h2>Projeler</h2>
        {projects.isLoading ? <Loading /> : <ErrorNotice error={projects.error} />}
        {projects.data?.length === 0 ? <Empty /> : null}
        {projects.data && projects.data.length > 0 ? (
          <table>
            <thead><tr><th>Proje</th><th>Ad</th><th>Maliyet merkezi</th><th className="num">Bütçe</th><th>Sahip</th><th>Durum</th></tr></thead>
            <tbody>
              {projects.data.map((p) => (
                <tr key={p.id} className="click" onClick={() => nav(`/rd-projects/${p.id}`)}>
                  <td className="mono">{p.code}</td>
                  <td>{p.name}</td>
                  <td className="muted">{p.costCenter ?? "—"}</td>
                  <td className="num">{p.budgetAmount ? `${fmt(p.budgetAmount)} ${p.currency}` : "—"}</td>
                  <td className="muted">{p.ownerName ?? "—"}</td>
                  <td><StateBadge value={p.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>
    </>
  );
}

export function RdProjectPage() {
  const { id } = useParams();
  const can = useCan();
  const qc = useQueryClient();
  const p = useQuery({ queryKey: ["rd-project", id], queryFn: () => get<any>(`/api/rd-projects/${id}`) });
  const [closeReason, setCloseReason] = useState("");
  const close = useMutation({
    mutationFn: () => post(`/api/rd-projects/${id}/close`, { reason: closeReason }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["rd-project", id] }); setCloseReason(""); },
  });
  const [alloc, setAlloc] = useState({ amount: "", currency: "TRY", description: "", sourceRef: "", reason: "", category: "other" });
  const addAlloc = useMutation({
    mutationFn: () => post(`/api/rd-projects/${id}/cost-allocations`, { ...alloc, sourceRef: alloc.sourceRef || undefined }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["rd-project", id] }); qc.invalidateQueries({ queryKey: ["rd-cost", id] }); setAlloc({ amount: "", currency: "TRY", description: "", sourceRef: "", reason: "", category: "other" }); },
  });
  if (p.isLoading) return <Loading />;
  if (p.error) return <ErrorNotice error={p.error} />;
  const d = p.data;
  return (
    <>
      <PageHeader title={`${d.code} — ${d.name}`} sub={d.note ?? undefined} />
      <div className="row">
        <div className="card" style={{ flex: 1 }}>
          <h2>Proje bilgisi</h2>
          <div>Maliyet merkezi: <b>{d.costCenter ?? "—"}</b></div>
          <div>Durum: <StateBadge value={d.status} /></div>
          <div>Sahip: {d.ownerName ?? "—"}</div>
          {d.budgetStatus ? (
            <div style={{ marginTop: 8 }}>
              Bütçe: {fmt(d.budgetStatus.budgetAmount)} {d.budgetStatus.currency} · Harcanan: {fmt(d.budgetStatus.spent)} {d.budgetStatus.currency} · Kalan: <b>{fmt(d.budgetStatus.remaining)} {d.budgetStatus.currency}</b>
              {Number(d.budgetStatus.remaining) < 0 ? <span className="badge state warn" style={{ marginLeft: 8 }}>bütçe aşıldı</span> : null}
            </div>
          ) : <div className="muted">Bütçe tanımlı değil.</div>}
          {d.status === "open" && can("rd.project.manage") ? (
            <form className="row" style={{ marginTop: 12 }} onSubmit={(e: FormEvent) => { e.preventDefault(); close.mutate(); }}>
              <label className="field" style={{ flex: 1 }}>Kapatma gerekçesi<input required minLength={3} value={closeReason} onChange={(e) => setCloseReason(e.target.value)} /></label>
              <button className="danger" style={{ alignSelf: "flex-end" }} disabled={close.isPending}>Projeyi kapat</button>
            </form>
          ) : null}
          {d.status === "closed" ? <div className="notice">Kapatıldı: {d.closedReason}</div> : null}
          <ErrorNotice error={close.error} />
        </div>
        <div className="card" style={{ flex: 1 }}>
          <h2>Harcama (para birimine göre)</h2>
          {d.spendByCurrency.length === 0 ? <Empty /> : (
            <table>
              <thead><tr><th>Para birimi</th><th className="num">Sipariş edilen</th><th className="num">Teslim alınan</th><th className="num">Bölüştürülen ortak gider</th><th className="num">Toplam</th></tr></thead>
              <tbody>
                {d.spendByCurrency.map((s: any) => (
                  <tr key={s.currency}>
                    <td className="mono">{s.currency}</td>
                    <td className="num">{fmt(s.orderedAmount)}</td>
                    <td className="num">{fmt(s.receivedAmount)}</td>
                    <td className="num">{fmt(s.allocatedAmount)}</td>
                    <td className="num"><b>{fmt(s.total)}</b></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="muted" style={{ marginTop: 6 }}>Yalnızca bu projeye bağlı satın alma siparişleri ve elle bölüştürülen ortak giderler. Bütçe takibi içindir; fatura, tahakkuk ve mühendislik zamanını içeren Ar-Ge maliyeti aşağıda.</div>
        </div>
      </div>

      <section className="card">
        <h2>Bu projeye bağlı satın alma talepleri</h2>
        {d.purchaseRequests.length === 0 ? <Empty /> : (
          <table>
            <thead><tr><th>Talep</th><th>Kalem</th><th className="num">Miktar</th><th>Maliyet merkezi</th><th>İhtiyaç tarihi</th><th className="num">Tahmini tutar</th><th>Durum</th></tr></thead>
            <tbody>
              {d.purchaseRequests.map((r: any) => (
                <tr key={r.id}>
                  <td className="mono">{r.code}</td>
                  <td className="mono">{r.itemCode}</td>
                  <td className="num">{fmt(r.qty)}</td>
                  <td className="muted">{r.costCenter ?? "—"}</td>
                  <td>{r.needDate ?? "—"}</td>
                  <td className="num">{r.estimatedAmount ? `${fmt(r.estimatedAmount)} ${r.currency}` : "—"}</td>
                  <td><StateBadge value={r.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>Ortak gider paylaştırma</h2>
        <div className="muted">Paylaşılan bir gideri (ör. ortak sarf, kargo) otomatik bölüştürmeyiz — muhasebe gerekçeyle elle, kalıcı bir kayıt olarak ekler.</div>
        {d.allocations.length > 0 ? (
          <table>
            <thead><tr><th>Tutar</th><th>Kategori</th><th>Açıklama</th><th>Kaynak</th><th>Gerekçe</th><th>Kim / ne zaman</th></tr></thead>
            <tbody>
              {d.allocations.map((a: any) => (
                <tr key={a.id}>
                  <td className="num">{fmt(a.amount)} {a.currency}</td>
                  <td>{RD_CATEGORY_LABEL[a.category] ?? a.category}</td>
                  <td>{a.description}</td>
                  <td className="muted">{a.sourceRef ?? "—"}</td>
                  <td className="muted">{a.reason}</td>
                  <td className="muted">{a.allocatedBy} · {new Date(a.allocatedAt).toLocaleString("tr-TR")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <Empty />}
        {d.status === "open" && can("cost.manage") ? (
          <form className="row" style={{ marginTop: 8 }} onSubmit={(e: FormEvent) => { e.preventDefault(); addAlloc.mutate(); }}>
            <label className="field" style={{ width: 110 }}>Tutar<input aria-label="Tutar" required inputMode="decimal" value={alloc.amount} onChange={(e) => setAlloc({ ...alloc, amount: e.target.value })} /></label>
            <label className="field" style={{ width: 90 }}>Para birimi<input aria-label="Para birimi" required maxLength={3} value={alloc.currency} onChange={(e) => setAlloc({ ...alloc, currency: e.target.value.toUpperCase() })} /></label>
            <label className="field">Kategori
              <select aria-label="Kategori" value={alloc.category} onChange={(e) => setAlloc({ ...alloc, category: e.target.value })}>
                {Object.entries(RD_CATEGORY_LABEL).filter(([k]) => k !== "engineering_time").map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <label className="field" style={{ flex: 1 }}>Açıklama<input aria-label="Açıklama" required minLength={3} value={alloc.description} onChange={(e) => setAlloc({ ...alloc, description: e.target.value })} /></label>
            <label className="field">Kaynak (ör. fatura no)<input value={alloc.sourceRef} onChange={(e) => setAlloc({ ...alloc, sourceRef: e.target.value })} /></label>
            <label className="field" style={{ flex: 1 }}>Gerekçe<input aria-label="Gerekçe" required minLength={3} value={alloc.reason} onChange={(e) => setAlloc({ ...alloc, reason: e.target.value })} /></label>
            <button className="primary" style={{ alignSelf: "flex-end" }} disabled={addAlloc.isPending}>Ekle</button>
          </form>
        ) : null}
        <ErrorNotice error={addAlloc.error} />
      </section>

      <RdProjectCost projectId={id!} open={d.status === "open"} />
    </>
  );
}
