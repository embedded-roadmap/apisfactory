import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, post } from "../lib/api";
import { Empty, ErrorNotice, Loading, PageHeader, StateBadge, fmtDate, useCan } from "../lib/ui";
import { History } from "./Sales";
import { Discussion } from "../components/Discussion";

const URGENCY: Record<string, string> = { low: "Düşük", normal: "Normal", high: "Yüksek", critical: "Kritik" };
const DECISION: Record<string, string> = {
  deviation: "Sapma izni (geçici)",
  permanent_revision: "Kalıcı revizyon",
  stop_production: "Üretimi durdur",
  field_action: "Sahadaki ürün için aksiyon",
};
const WO_ACTION: Record<string, string> = { continue: "Devam", hold: "Beklet", rework_after: "Devam, sonra yeniden işle", cancel_remaining: "Kalanı iptal" };

export function ChangesPage() {
  const nav = useNavigate();
  const q = useQuery({ queryKey: ["changes"], queryFn: () => get<any[]>("/api/change-requests") });
  return (
    <>
      <PageHeader title="Değişiklik talepleri" sub="Talep BOM'u veya açık işi kendiliğinden değiştirmez; karar yetkili kişi tarafından, açık iş emirleri için ayrı ayrı verilir." />
      <section className="card">
        {q.isLoading ? <Loading /> : <ErrorNotice error={q.error} />}
        {q.data?.length === 0 ? <Empty>Talep yok. İş emri ekranından açılabilir.</Empty> : null}
        {q.data && q.data.length > 0 ? (
          <table>
            <thead><tr><th>Kod</th><th>Başlık</th><th>Ürün</th><th>İş emri</th><th>Aciliyet</th><th>Durum</th><th>Açılış</th></tr></thead>
            <tbody>
              {q.data.map((c) => (
                <tr key={c.id} className="click" onClick={() => nav(`/changes/${c.id}`)}>
                  <td className="mono">{c.code}</td><td>{c.title} {c.stopProduction ? <span className="badge bad">Üretimi durdur</span> : null}</td>
                  <td className="mono">{c.productCode} Rev.{c.rev}</td><td className="mono">{c.workOrderCode ?? "—"}</td>
                  <td>{URGENCY[c.urgency]}</td><td><StateBadge value={c.status} prefix="cr" /></td><td className="muted">{fmtDate(c.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>
    </>
  );
}

export function ChangePage() {
  const { id } = useParams();
  const can = useCan();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["change", id], queryFn: () => get<any>(`/api/change-requests/${id}`) });
  const [decisionType, setDecisionType] = useState("deviation");
  const [effectivity, setEffectivity] = useState("");
  const [note, setNote] = useState("");
  const [woActions, setWoActions] = useState<Record<string, string>>({});
  const decide = useMutation({
    mutationFn: (body: unknown) => post(`/api/change-requests/${id}/decide`, body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["change", id] }); qc.invalidateQueries({ queryKey: ["history"] }); },
  });
  const implemented = useMutation({
    mutationFn: () => post(`/api/change-requests/${id}/implemented`, { note }),
    onSuccess: () => { setNote(""); qc.invalidateQueries({ queryKey: ["change", id] }); },
  });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNotice error={q.error} />;
  const c = q.data;
  return (
    <>
      <PageHeader
        title={`${c.code} — ${c.title}`}
        sub={<>{c.productCode} Rev.{c.rev} · {c.workOrderCode ? <Link to={`/production/${c.workOrderId}`}>{c.workOrderCode}</Link> : "iş emri yok"}{c.deviceSerial ? ` · seri ${c.deviceSerial}` : ""} · açan {c.openedBy} · <Link to="/changes">← Talepler</Link></>}
        actions={<><StateBadge value={c.status} prefix="cr" />{c.stopProduction ? <span className="badge bad">Üretimi durdur</span> : null}</>}
      />
      <section className="card">
        <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{c.description}</p>
        <div className="muted">Aciliyet: {URGENCY[c.urgency]} · {fmtDate(c.createdAt)}</div>
      </section>
      {c.status !== "open" ? (
        <section className="card">
          <h2>Karar</h2>
          <div>{c.decisionType ? DECISION[c.decisionType] : "Reddedildi"} · {c.decidedBy} · {fmtDate(c.decidedAt)}</div>
          {c.effectivity ? <div>Yürürlük: {c.effectivity}</div> : null}
          <div className="muted">{c.decisionNote}</div>
          {c.openWorkOrderDecisions?.length ? <ul>{c.openWorkOrderDecisions.map((d: any) => <li key={d.workOrderId}><span className="mono">{d.code}</span>: {WO_ACTION[d.action]}</li>)}</ul> : null}
          {c.status === "approved" && can("change.decide") ? (
            <div className="row">
              <input aria-label="Uygulama notu" placeholder="Uygulama notu (ör. Rev.B yayımlandı)" value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: 1 }} />
              <button disabled={note.trim().length < 3} onClick={() => implemented.mutate()}>Uygulandı olarak kapat</button>
            </div>
          ) : null}
          <ErrorNotice error={implemented.error} />
        </section>
      ) : can("change.decide") ? (
        <section className="card">
          <h2>Karar ver</h2>
          <div className="row">
            <label className="field">Karar türü
              <select value={decisionType} onChange={(e) => setDecisionType(e.target.value)}>{Object.entries(DECISION).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
            </label>
            <label className="field" style={{ flex: 1 }}>Yürürlük (hangi seri/lot/tarihten itibaren)<input value={effectivity} onChange={(e) => setEffectivity(e.target.value)} /></label>
          </div>
          {c.openWorkOrders.length ? (
            <table>
              <thead><tr><th>Açık iş emri</th><th>Durum</th><th>Karar</th></tr></thead>
              <tbody>
                {c.openWorkOrders.map((w: any) => (
                  <tr key={w.id}>
                    <td className="mono">{w.code}</td><td><StateBadge value={w.status} prefix="wo" /></td>
                    <td>
                      <select aria-label={`${w.code} kararı`} value={woActions[w.id] ?? ""} onChange={(e) => setWoActions({ ...woActions, [w.id]: e.target.value })}>
                        <option value="">Seçin…</option>
                        {Object.entries(WO_ACTION).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="muted">Bu revizyonda açık iş emri yok.</p>}
          <label className="field">Gerekçe<textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></label>
          <div className="row">
            <button className="primary" onClick={() => decide.mutate({
              decision: "approve", decisionType, effectivity, note,
              openWorkOrders: Object.entries(woActions).filter(([, a]) => a).map(([workOrderId, action]) => ({ workOrderId, action })),
            })}>Onayla</button>
            <button className="danger" onClick={() => decide.mutate({ decision: "reject", note })}>Reddet</button>
          </div>
          <ErrorNotice error={decide.error} />
          <p className="muted" style={{ margin: 0 }}>Kalıcı revizyon kararında Ar-Ge'ye "yeni revizyon aç" görevi düşer; BOM bu ekrandan değişmez.</p>
        </section>
      ) : <div className="notice">Karar yetkiniz yok; talep Ar-Ge değerlendirmesinde.</div>}
      <Discussion entityType="change_request" entityId={c.id} />
      <History entityType="change_request" id={c.id} />
    </>
  );
}
