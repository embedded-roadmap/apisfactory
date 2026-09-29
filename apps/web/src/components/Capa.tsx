import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, post } from "../lib/api";
import { Empty, ErrorNotice, fmtDate, useCan } from "../lib/ui";

const STATUS: Record<string, [string, string]> = { open: ["açık", "warn"], action_taken: ["faaliyet girildi — kontrol bekliyor", "warn"], closed: ["kapandı (etkili)", "ok"] };

/** R18 — tekrarlayan hata düzeltici faaliyetleri (DF): liste, ayrıntı, faaliyet/doğrulama, eşik ayarı. */
export function CapaPanel() {
  const can = useCan();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["capas"], queryFn: () => get<any[]>("/api/capas") });
  const st = useQuery({ queryKey: ["capaSettings"], queryFn: () => get<any>("/api/capa-settings") });
  const [sel, setSel] = useState<string | null>(null);
  const [cfg, setCfg] = useState<{ threshold: string; windowDays: string; reason: string } | null>(null);
  const saveCfg = useMutation({
    mutationFn: () => post("/api/capa-settings", { threshold: Number(cfg!.threshold), windowDays: Number(cfg!.windowDays), reason: cfg!.reason }),
    onSuccess: () => { setCfg(null); qc.invalidateQueries({ queryKey: ["capaSettings"] }); },
  });
  return (
    <section className="card">
      <h2>Düzeltici faaliyetler (tekrarlayan hata)</h2>
      <p className="muted" style={{ margin: 0 }}>
        Kalite kararında hata kodu girilen uygunsuzluklar sayılır: aynı üründe aynı kod {st.data?.windowDays ?? "…"} gün içinde {st.data?.threshold ?? "…"} kez olunca DF otomatik açılır.
        Kök neden bir varsayımdır; etkinliği faaliyeti girenden başka biri doğrular, faaliyetten sonra tekrar varsa "etkili" kararı gerekçe ister.
        {can("quality.plan.manage") && !cfg ? <> <button type="button" className="link" onClick={() => setCfg({ threshold: String(st.data?.threshold ?? 3), windowDays: String(st.data?.windowDays ?? 30), reason: "" })}>Eşiği değiştir</button></> : null}
      </p>
      {cfg ? (
        <form className="row" onSubmit={(e: FormEvent) => { e.preventDefault(); saveCfg.mutate(); }}>
          <label className="field" style={{ width: 90 }}>Tekrar<input aria-label="DF eşiği" inputMode="numeric" value={cfg.threshold} onChange={(e) => setCfg({ ...cfg, threshold: e.target.value })} /></label>
          <label className="field" style={{ width: 90 }}>Gün<input aria-label="DF penceresi" inputMode="numeric" value={cfg.windowDays} onChange={(e) => setCfg({ ...cfg, windowDays: e.target.value })} /></label>
          <label className="field" style={{ flex: 1 }}>Gerekçe<input aria-label="Eşik gerekçesi" required minLength={3} value={cfg.reason} onChange={(e) => setCfg({ ...cfg, reason: e.target.value })} /></label>
          <button style={{ alignSelf: "flex-end" }}>Kaydet</button><button type="button" style={{ alignSelf: "flex-end" }} onClick={() => setCfg(null)}>Vazgeç</button>
        </form>
      ) : null}
      <ErrorNotice error={saveCfg.error} />
      {list.data?.length ? (
        <table>
          <thead><tr><th>DF</th><th>Ürün</th><th>Hata kodu</th><th className="num">Tekrar</th><th>Durum</th><th>Kontrol</th></tr></thead>
          <tbody>{list.data.map((c) => (
            <tr key={c.id} className="click" onClick={() => setSel(c.id === sel ? null : c.id)}>
              <td className="mono">{c.code}{c.reopenCount ? <span className="badge bad" style={{ marginLeft: 4 }}>{c.reopenCount}× yeniden</span> : null}</td>
              <td className="mono">{c.productCode}</td><td className="mono">{c.defectCode}</td><td className="num">{c.occurrences}</td>
              <td><span className={`badge state ${STATUS[c.status]![1]}`}>{STATUS[c.status]![0]}</span></td><td>{c.checkDue ?? "—"}</td>
            </tr>
          ))}</tbody>
        </table>
      ) : list.data ? <Empty>Açık düzeltici faaliyet yok.</Empty> : null}
      {sel ? <CapaDetail key={sel} id={sel} /> : null}
    </section>
  );
}

function CapaDetail({ id }: { id: string }) {
  const can = useCan();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["capa", id], queryFn: () => get<any>(`/api/capas/${id}`) });
  const refresh = () => { qc.invalidateQueries({ queryKey: ["capa", id] }); qc.invalidateQueries({ queryKey: ["capas"] }); };
  const [a, setA] = useState({ rootCause: "", action: "", checkAfterDays: "14" });
  const action = useMutation({ mutationFn: () => post(`/api/capas/${id}/action`, { ...a, checkAfterDays: Number(a.checkAfterDays) }), onSuccess: refresh });
  const [note, setNote] = useState("");
  const verify = useMutation({ mutationFn: (effective: boolean) => post(`/api/capas/${id}/verify`, { effective, note: note || undefined }), onSuccess: () => { setNote(""); refresh(); } });
  const c = q.data;
  if (!c) return null;
  const edit = can("quality.plan.manage");
  return (
    <div className="card" style={{ background: "var(--surface-2)" }}>
      <b>{c.code} · {c.productCode} — {c.defectCode}</b>
      <div className="muted">Açılış: {fmtDate(c.createdAt)} · tetikleyen {c.trigger.count} kayıt / {c.trigger.windowDays} gün (eşik {c.trigger.threshold})</div>
      <table>
        <thead><tr><th>Tarih</th><th>Seri</th><th>İş emri</th><th>Karar</th></tr></thead>
        <tbody>{c.occurrences.map((o: any) => <tr key={o.id}><td>{fmtDate(o.createdAt)}</td><td className="mono">{o.serial}</td><td className="mono">{o.workOrderCode}</td><td>{o.decision ?? "—"}</td></tr>)}</tbody>
      </table>
      {c.rootCause ? <div><b>Kök neden (varsayım):</b> {c.rootCause}<br /><b>Faaliyet:</b> {c.action} <span className="muted">({c.actionBy}, {fmtDate(c.actionAt)}; kontrol {c.checkDue}; faaliyetten sonra {c.recurrencesSinceAction} tekrar)</span></div> : null}
      {c.verificationNote ? <div className="muted">Son doğrulama notu: {c.verificationNote}{c.verifiedBy ? ` — ${c.verifiedBy}` : ""}</div> : null}
      {edit && c.status === "open" ? (
        <form onSubmit={(e: FormEvent) => { e.preventDefault(); action.mutate(); }}>
          <label className="field">Kök neden (varsayım)<textarea aria-label="Kök neden" required minLength={10} value={a.rootCause} onChange={(e) => setA({ ...a, rootCause: e.target.value })} /></label>
          <label className="field">Düzeltici faaliyet<textarea aria-label="Düzeltici faaliyet" required minLength={10} value={a.action} onChange={(e) => setA({ ...a, action: e.target.value })} /></label>
          <div className="row">
            <label className="field" style={{ width: 160 }}>Etkinlik kontrolü (gün sonra)<input aria-label="Kontrol günü" inputMode="numeric" value={a.checkAfterDays} onChange={(e) => setA({ ...a, checkAfterDays: e.target.value })} /></label>
            <button className="primary" style={{ alignSelf: "flex-end" }} disabled={action.isPending}>Faaliyeti kaydet</button>
          </div>
        </form>
      ) : null}
      {edit && c.status === "action_taken" ? (
        <div className="row">
          <input aria-label="Doğrulama notu" style={{ flex: 1 }} placeholder={c.recurrencesSinceAction ? "Faaliyetten sonra tekrar var — 'etkili' için gerekçe (≥ 20 karakter)" : "Doğrulama notu"} value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="primary" disabled={verify.isPending} onClick={() => verify.mutate(true)}>Etkili — kapat</button>
          <button className="danger" disabled={verify.isPending} onClick={() => verify.mutate(false)}>Etkisiz — yeniden aç</button>
        </div>
      ) : null}
      <ErrorNotice error={action.error ?? verify.error} />
    </div>
  );
}
