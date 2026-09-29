import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, get, post } from "../lib/api";
import { Empty, ErrorNotice, Loading, fmt, useCan } from "../lib/ui";

export const RD_CATEGORY_LABEL: Record<string, string> = {
  prototype_material: "Prototip malzemesi",
  pcb_assembly: "PCB / dizgi",
  engineering_time: "Mühendislik zamanı",
  external_service: "Dış hizmet",
  test: "Test",
  other: "Diğer",
};
export const RD_ACTIVITY_LABEL: Record<string, string> = {
  design: "Tasarım", layout: "PCB yerleşim", firmware: "Firmware", prototype: "Prototip", test: "Test", documentation: "Dokümantasyon", other: "Diğer",
};
const CATEGORY_ORDER = ["prototype_material", "pcb_assembly", "engineering_time", "external_service", "test", "other"];

/** R05 maliyet raporu (canlı önizleme veya dondurulmuş sürüm aynı biçimde). */
export function RdCostView({ report }: { report: any }) {
  return (
    <>
      <div className="row">
        {report.status === "final"
          ? <span className="badge state ok">kesin</span>
          : <span className="badge state warn">geçici</span>}
        <span className="muted">Mühendislik: {fmt(report.engineering.hours)} saat{Number(report.engineering.unpricedHours) ? ` (${fmt(report.engineering.unpricedHours)} saat ücretsiz)` : ""}</span>
      </div>
      {report.provisionalReasons.length ? (
        <ul className="muted" style={{ margin: "6px 0" }}>
          {report.provisionalReasons.map((r: string) => <li key={r}>{r}</li>)}
        </ul>
      ) : null}
      {report.byCurrency.length === 0 ? <Empty>Henüz gider yok.</Empty> : (
        <table>
          <thead>
            <tr><th>Kategori</th>{report.byCurrency.map((c: any) => <th key={c.currency} className="num">{c.currency}</th>)}</tr>
          </thead>
          <tbody>
            {CATEGORY_ORDER.map((k) => (
              <tr key={k}>
                <td>{RD_CATEGORY_LABEL[k]}</td>
                {report.byCurrency.map((c: any) => <td key={c.currency} className="num">{fmt(c.byCategory[k])}</td>)}
              </tr>
            ))}
            <tr><td><b>Toplam</b></td>{report.byCurrency.map((c: any) => <td key={c.currency} className="num"><b>{fmt(c.total)}</b></td>)}</tr>
            <tr className="muted"><td>— faturalanan / tahakkuk / bölüştürülen</td>{report.byCurrency.map((c: any) => <td key={c.currency} className="num">{fmt(c.invoiced)} / {fmt(c.accrued)} / {fmt(c.allocated)}</td>)}</tr>
            <tr className="muted"><td>Açık sipariş taahhüdü (toplama dahil değil)</td>{report.byCurrency.map((c: any) => <td key={c.currency} className="num">{fmt(c.openCommitment)}</td>)}</tr>
          </tbody>
        </table>
      )}
      <div className="muted" style={{ marginTop: 6 }}>{report.limitations.join(" ")}</div>
    </>
  );
}

/** Proje sayfası: canlı maliyet, zaman kaydı ve saat ücreti. */
export function RdProjectCost({ projectId, open }: { projectId: string; open: boolean }) {
  const can = useCan();
  const qc = useQueryClient();
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["rd-cost", projectId] });
    qc.invalidateQueries({ queryKey: ["rd-time", projectId] });
    qc.invalidateQueries({ queryKey: ["rd-rates"] });
  };
  const cost = useQuery({ queryKey: ["rd-cost", projectId], queryFn: () => get<any>(`/api/rd-projects/${projectId}/cost`) });
  const time = useQuery({ queryKey: ["rd-time", projectId], queryFn: () => get<any[]>(`/api/rd-projects/${projectId}/time-entries`) });
  const rates = useQuery({ queryKey: ["rd-rates"], queryFn: () => get<any[]>("/api/rd-labor-rates") });
  const today = new Date().toISOString().slice(0, 10);
  const [t, setT] = useState({ workDate: today, hours: "", activity: "design", note: "" });
  const log = useMutation({
    mutationFn: () => post(`/api/rd-projects/${projectId}/time-entries`, { ...t, note: t.note || undefined }),
    onSuccess: () => { refresh(); setT({ ...t, hours: "", note: "" }); },
  });
  const [reversing, setReversing] = useState<{ id: string; reason: string } | null>(null);
  const reverse = useMutation({
    mutationFn: (v: { id: string; reason: string }) => post(`/api/rd-time-entries/${v.id}/reverse`, { reason: v.reason }),
    onSuccess: () => { refresh(); setReversing(null); },
  });
  const [r, setR] = useState({ ratePerHour: "", currency: "TRY", effectiveFrom: today, note: "" });
  const addRate = useMutation({
    mutationFn: () => post("/api/rd-labor-rates", r),
    onSuccess: () => { refresh(); setR({ ...r, ratePerHour: "", note: "" }); },
  });

  return (
    <>
      <section className="card">
        <h2>Ar-Ge maliyeti (anlık)</h2>
        <div className="muted">Devir onayında bu hesap revizyona sürüm olarak dondurulur. Faturası gelmemiş teslimat ve ücretsiz saat raporu geçici yapar.</div>
        {cost.isLoading ? <Loading /> : <ErrorNotice error={cost.error} />}
        {cost.data ? <RdCostView report={cost.data} /> : null}
      </section>

      <section className="card">
        <h2>Mühendislik zamanı</h2>
        <div className="muted">Kayıt silinmez; hatalı kayıt gerekçeyle ters çevrilir, doğrusu yeniden girilir.</div>
        {open && can("rd.project.manage") ? (
          <form className="row" style={{ marginTop: 8 }} onSubmit={(e: FormEvent) => { e.preventDefault(); log.mutate(); }}>
            <label className="field">Tarih<input type="date" aria-label="Çalışma tarihi" required max={today} value={t.workDate} onChange={(e) => setT({ ...t, workDate: e.target.value })} /></label>
            <label className="field" style={{ width: 90 }}>Saat<input aria-label="Saat" required inputMode="decimal" value={t.hours} onChange={(e) => setT({ ...t, hours: e.target.value })} /></label>
            <label className="field">Faaliyet
              <select aria-label="Faaliyet" value={t.activity} onChange={(e) => setT({ ...t, activity: e.target.value })}>
                {Object.entries(RD_ACTIVITY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <label className="field" style={{ flex: 1 }}>Not<input value={t.note} onChange={(e) => setT({ ...t, note: e.target.value })} /></label>
            <button className="primary" style={{ alignSelf: "flex-end" }} disabled={log.isPending}>Kaydet</button>
          </form>
        ) : null}
        <ErrorNotice error={log.error ?? reverse.error} />
        {time.data && time.data.length > 0 ? (
          <table>
            <thead><tr><th>Tarih</th><th>Kişi</th><th>Faaliyet</th><th className="num">Saat</th><th>Not / gerekçe</th><th></th></tr></thead>
            <tbody>
              {time.data.map((e) => (
                <tr key={e.id} className={e.reversed || e.reversesEntryId ? "muted" : undefined}>
                  <td>{e.workDate?.slice(0, 10)}</td>
                  <td>{e.userName}</td>
                  <td>{RD_ACTIVITY_LABEL[e.activity] ?? e.activity}</td>
                  <td className="num">{fmt(e.hours)}</td>
                  <td>{e.reversesEntryId ? `Ters kayıt: ${e.reason}` : e.note ?? "—"}{e.reversed ? " (ters çevrildi)" : ""}</td>
                  <td>
                    {open && can("rd.project.manage") && !e.reversed && !e.reversesEntryId ? (
                      reversing && reversing.id === e.id ? (
                        <form className="row" onSubmit={(ev: FormEvent) => { ev.preventDefault(); reverse.mutate({ id: e.id, reason: reversing.reason }); }}>
                          <input aria-label="Ters çevirme gerekçesi" required minLength={3} placeholder="Gerekçe" value={reversing.reason} onChange={(ev) => setReversing({ id: e.id, reason: ev.target.value })} />
                          <button disabled={reverse.isPending}>Onayla</button>
                          <button type="button" onClick={() => setReversing(null)}>Vazgeç</button>
                        </form>
                      ) : <button onClick={() => setReversing({ id: e.id, reason: "" })}>Ters çevir</button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : time.data ? <Empty>Zaman kaydı yok.</Empty> : null}
      </section>

      <section className="card">
        <h2>Ar-Ge saat ücreti</h2>
        <div className="muted">Sürümlüdür: her zaman kaydı çalışma tarihinde geçerli ücretle fiyatlanır; yeni ücret geçmiş kayıtları değiştirmez.</div>
        {rates.data && rates.data.length > 0 ? (
          <table>
            <thead><tr><th>Geçerlilik</th><th className="num">Saat ücreti</th><th>Not</th><th>Kim</th></tr></thead>
            <tbody>
              {rates.data.map((x) => (
                <tr key={x.versionNo}><td>{x.effectiveFrom?.slice(0, 10)}</td><td className="num">{fmt(x.ratePerHour)} {x.currency}</td><td>{x.note}</td><td className="muted">{x.createdBy}</td></tr>
              ))}
            </tbody>
          </table>
        ) : rates.data ? <Empty>Ücret tanımlı değil — zaman kayıtları fiyatlanamaz.</Empty> : null}
        {can("cost.manage") ? (
          <form className="row" style={{ marginTop: 8 }} onSubmit={(e: FormEvent) => { e.preventDefault(); addRate.mutate(); }}>
            <label className="field" style={{ width: 120 }}>Saat ücreti<input aria-label="Saat ücreti" required inputMode="decimal" value={r.ratePerHour} onChange={(e) => setR({ ...r, ratePerHour: e.target.value })} /></label>
            <label className="field" style={{ width: 90 }}>Para birimi<input aria-label="Ücret para birimi" required maxLength={3} value={r.currency} onChange={(e) => setR({ ...r, currency: e.target.value.toUpperCase() })} /></label>
            <label className="field">Geçerli başlangıç<input type="date" aria-label="Geçerli başlangıç" required value={r.effectiveFrom} onChange={(e) => setR({ ...r, effectiveFrom: e.target.value })} /></label>
            <label className="field" style={{ flex: 1 }}>Not<input aria-label="Ücret notu" required minLength={3} value={r.note} onChange={(e) => setR({ ...r, note: e.target.value })} /></label>
            <button className="primary" style={{ alignSelf: "flex-end" }} disabled={addRate.isPending}>Yeni ücret</button>
          </form>
        ) : null}
        <ErrorNotice error={addRate.error} />
      </section>
    </>
  );
}

/** Revizyon kartı: Ar-Ge projesi bağı ve devir maliyet raporu sürümleri. */
export function RevisionRdCost({ rev, onDone }: { rev: { id: string; status: string; rdProjectId?: string | null }; onDone: () => void }) {
  const can = useCan();
  const qc = useQueryClient();
  const released = rev.status === "released";
  const projects = useQuery({ queryKey: ["rd-projects"], queryFn: () => get<any[]>("/api/rd-projects"), enabled: can("rd.project.view") });
  const reports = useQuery({ queryKey: ["rd-cost-reports", rev.id], queryFn: () => get<any[]>(`/api/revisions/${rev.id}/rd-cost-reports`), enabled: released && can("rd.project.view") });
  const [link, setLink] = useState<{ projectId: string; reason: string } | null>(null);
  const save = useMutation({
    mutationFn: (v: { projectId: string; reason: string }) => api("PUT", `/api/revisions/${rev.id}/rd-project`, { projectId: v.projectId || null, reason: v.reason }),
    onSuccess: () => { setLink(null); onDone(); },
  });
  const [reason, setReason] = useState("");
  const recalc = useMutation({
    mutationFn: () => post(`/api/revisions/${rev.id}/rd-cost-reports/recalculate`, { reason }),
    onSuccess: () => { setReason(""); qc.invalidateQueries({ queryKey: ["rd-cost-reports", rev.id] }); },
  });
  const [shown, setShown] = useState<number | null>(null);
  if (!can("rd.project.view")) return null;
  const project = projects.data?.find((p) => p.id === rev.rdProjectId);
  const latest = reports.data?.[0];
  const current = reports.data?.find((r) => r.versionNo === shown) ?? latest;

  return (
    <div style={{ marginTop: 8 }}>
      <div className="row">
        <b>Ar-Ge projesi:</b>
        <span>{project ? `${project.code} — ${project.name}` : rev.rdProjectId ? "…" : "bağlı değil"}</span>
        {!released && can("rd.project.manage") && !link ? <button onClick={() => setLink({ projectId: rev.rdProjectId ?? "", reason: "" })}>Değiştir</button> : null}
      </div>
      {link ? (
        <form className="row" onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(link); }}>
          <select aria-label="Ar-Ge projesi" value={link.projectId} onChange={(e) => setLink({ ...link, projectId: e.target.value })}>
            <option value="">— bağlı değil —</option>
            {(projects.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}
          </select>
          <input aria-label="Bağlama gerekçesi" required minLength={3} placeholder="Gerekçe" value={link.reason} onChange={(e) => setLink({ ...link, reason: e.target.value })} />
          <button className="primary" disabled={save.isPending}>Kaydet</button>
          <button type="button" onClick={() => setLink(null)}>Vazgeç</button>
        </form>
      ) : null}
      <ErrorNotice error={save.error} />
      {!released && rev.rdProjectId ? <div className="muted">Devir onayında projenin Ar-Ge maliyeti bu revizyona dondurulur.</div> : null}
      {released ? (
        reports.isLoading ? <Loading /> : reports.data && reports.data.length > 0 ? (
          <div className="card" style={{ marginTop: 6 }}>
            <div className="row between">
              <h3>Devir Ar-Ge maliyeti</h3>
              <select aria-label="Rapor sürümü" value={current?.versionNo} onChange={(e) => setShown(Number(e.target.value))}>
                {reports.data.map((x) => <option key={x.versionNo} value={x.versionNo}>Sürüm {x.versionNo} · {x.trigger === "handover" ? "devir" : "düzeltme"} · {new Date(x.createdAt).toLocaleDateString("tr-TR")}</option>)}
              </select>
            </div>
            {current?.reason ? <div className="muted">Gerekçe: {current.reason} ({current.createdBy})</div> : null}
            {current ? <RdCostView report={current.report} /> : null}
            {can("cost.manage") ? (
              <form className="row" style={{ marginTop: 8 }} onSubmit={(e: FormEvent) => { e.preventDefault(); recalc.mutate(); }}>
                <input aria-label="Yeniden hesaplama gerekçesi" style={{ flex: 1 }} required minLength={3} placeholder="Gerekçe (ör. gelen fatura)" value={reason} onChange={(e) => setReason(e.target.value)} />
                <button disabled={recalc.isPending}>Yeni sürüm hesapla</button>
              </form>
            ) : null}
            <ErrorNotice error={recalc.error} />
          </div>
        ) : <div className="muted">Bu revizyon için Ar-Ge maliyet raporu yok (devir anında projeye bağlı değildi).</div>
      ) : null}
    </div>
  );
}
