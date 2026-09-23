import { useState, type FormEvent } from "react";
import { Link, NavLink } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BASE, get, post } from "../lib/api";
import { Empty, ErrorNotice, Loading, PageHeader, fmtDate, useCan } from "../lib/ui";

export function QualityTabs() {
  return (
    <div className="row tabs" role="tablist">
      <NavLink to="/quality" end>Ekipman & kapasite</NavLink>
      <NavLink to="/quality/station">Test istasyonu</NavLink>
    </div>
  );
}

const ROW_STATUS: Record<string, [string, string]> = {
  ready: ["kaydedilecek", "ok"], recorded: ["kaydedildi", "ok"], duplicate: ["zaten kayıtlı", ""], unknown_serial: ["seri bulunamadı", "bad"],
  invalid: ["okunamadı", "bad"], rejected: ["reddedildi", "bad"],
};

type Meas = { column: string; name: string; scale: string };

export function StationPage() {
  const can = useCan();
  const qc = useQueryClient();
  const conns = useQuery({ queryKey: ["stationConns"], queryFn: () => get<any[]>("/api/test-station/connectors") });
  const batches = useQuery({ queryKey: ["stationBatches"], queryFn: () => get<any[]>("/api/test-station/batches") });
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <PageHeader title="Kalite & Ekipman" sub="Test istasyonu çıktısı (CSV veya istasyon API'si) cihaz serisine eşlenir ve elle girişle aynı kurallardan geçer: firmware, ekipman kalibrasyonu, test planı limitleri. Aynı test çalışması iki kez kaydedilmez." />
      <QualityTabs />
      <div className="notice info">Adaptör <span className="badge mode warn">TEST</span> modunda: gerçek bir istasyon üreticisinin çıktısıyla doğrulanmadı. Kayıtlar kaynağıyla (istasyon CSV / API) işaretlenir.</div>
      <section className="card">
        <h2>Bağlayıcılar</h2>
        {conns.isLoading ? <Loading /> : <ErrorNotice error={conns.error} />}
        {conns.data?.length === 0 ? <Empty>Bağlayıcı yok. Önce "Test istasyonu" türünde ekipman ekleyin, sonra sütun eşlemesini tanımlayın.</Empty> : null}
        {conns.data?.length ? (
          <table>
            <thead><tr><th>Kod</th><th>Ad</th><th>Ekipman</th><th>Durum</th><th>Ölçüm eşlemesi</th><th>API belirteci</th><th>Son yükleme</th><th /></tr></thead>
            <tbody>{conns.data.map((c) => <ConnectorRow key={c.id} c={c} />)}</tbody>
          </table>
        ) : null}
        {can("equipment.manage") ? <NewConnector onDone={() => qc.invalidateQueries({ queryKey: ["stationConns"] })} /> : null}
      </section>
      {can("production.test.record") && conns.data?.some((c) => c.status === "active") ? <Upload conns={conns.data.filter((c) => c.status === "active")} onDone={(id) => { setOpen(id); qc.invalidateQueries({ queryKey: ["stationBatches"] }); }} /> : null}
      {open ? <BatchView id={open} onClose={() => setOpen(null)} /> : null}
      <section className="card">
        <h2>Yüklemeler</h2>
        {batches.data?.length === 0 ? <Empty>Henüz yükleme yok.</Empty> : null}
        {batches.data?.length ? (
          <table>
            <thead><tr><th>Zaman</th><th>Bağlayıcı</th><th>Kaynak</th><th>Dosya</th><th>Durum</th><th className="num">Satır</th><th className="num">Kaydedilen</th><th className="num">Sorunlu</th><th className="num">Tekrar</th><th /></tr></thead>
            <tbody>{batches.data.map((b) => (
              <tr key={b.id}>
                <td className="muted">{fmtDate(b.createdAt)}</td><td className="mono">{b.connectorCode}</td><td>{b.source === "api" ? "API" : "CSV"}</td><td>{b.fileName ?? "—"}</td>
                <td>{b.status === "committed" ? <span className="badge ok">kaydedildi</span> : b.status === "preview" ? <span className="badge warn">önizleme</span> : <span className="badge">iptal</span>}</td>
                <td className="num">{b.total}</td><td className="num">{b.recorded}</td><td className="num">{b.problems ? <span className="badge bad">{b.problems}</span> : 0}</td><td className="num">{b.duplicates}</td>
                <td><button onClick={() => setOpen(b.id)}>Aç</button></td>
              </tr>
            ))}</tbody>
          </table>
        ) : null}
      </section>
    </>
  );
}

function ConnectorRow({ c }: { c: any }) {
  const can = useCan();
  const qc = useQueryClient();
  const [token, setToken] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const act = useMutation({ mutationFn: (f: () => Promise<any>) => f(), onSuccess: () => qc.invalidateQueries({ queryKey: ["stationConns"] }) });
  const example = token
    ? `curl -X POST ${BASE || location.origin}/api/station/runs \\\n  -H "x-station-token: ${token}" -H "content-type: application/json" \\\n  -d '{"runs":[{"${c.mapping.serial}":"SERİ"${c.mapping.runId ? `,"${c.mapping.runId}":"RUN-1"` : ""}${c.mapping.measurements.map((m: any) => `,"${m.column}":"0"`).join("")}}]}'`
    : "";
  return (
    <>
      <tr>
        <td className="mono">{c.code}</td><td>{c.name}</td>
        <td className="mono">{c.equipmentCode} {c.calibrationExpired ? <span className="badge bad">kalibrasyon geçmiş</span> : null}{c.equipmentStatus !== "active" ? <span className="badge bad">hizmet dışı</span> : null}</td>
        <td><span className="badge mode warn">TEST</span> {c.status === "active" ? <span className="badge ok">aktif</span> : <span className="badge">devre dışı</span>}</td>
        <td className="muted" style={{ fontSize: 13 }}>seri: <span className="mono">{c.mapping.serial}</span>{c.mapping.measurements.map((m: any) => <div key={m.column}><span className="mono">{m.column}</span> → {m.name}{m.scale !== 1 ? ` ×${m.scale}` : ""}</div>)}</td>
        <td className="mono">{c.tokenHint ?? "—"}</td>
        <td className="muted">{c.lastBatchAt ? fmtDate(c.lastBatchAt) : "—"}</td>
        <td>
          {can("equipment.manage") ? (
            <div className="stack" style={{ gap: 6 }}>
              <button onClick={() => act.mutate(async () => setToken((await post<any>(`/api/test-station/connectors/${c.id}/token`)).token))}>{c.tokenHint ? "Belirteci yenile" : "API belirteci üret"}</button>
              <div className="row">
                <input aria-label={`${c.code} gerekçe`} placeholder="Gerekçe" value={reason} onChange={(e) => setReason(e.target.value)} style={{ width: 120 }} />
                <button disabled={reason.length < 3} onClick={() => act.mutate(() => post(`/api/test-station/connectors/${c.id}`, { status: c.status === "active" ? "disabled" : "active", reason }))}>{c.status === "active" ? "Devre dışı bırak" : "Etkinleştir"}</button>
              </div>
            </div>
          ) : null}
        </td>
      </tr>
      {token ? (
        <tr><td colSpan={8}>
          <div className="notice warn">
            <b>Belirteç yalnızca şimdi gösterilir; istasyon yapılandırmasına kaydedin.</b> Eskisi geçersiz oldu.
            <pre className="mono" style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{example}</pre>
            <button onClick={() => setToken(null)}>Kaydettim, gizle</button>
          </div>
        </td></tr>
      ) : null}
      {act.error ? <tr><td colSpan={8}><ErrorNotice error={act.error} /></td></tr> : null}
    </>
  );
}

function NewConnector({ onDone }: { onDone: () => void }) {
  const eq = useQuery({ queryKey: ["equipment"], queryFn: () => get<any[]>("/api/equipment") });
  const [f, setF] = useState({ code: "", name: "", equipmentId: "", serial: "SerialNo", runId: "RunID", timestamp: "Time", result: "Result", firmware: "FW", decimal: ".", serialStrip: "", utcOffset: "+03:00" });
  const [meas, setMeas] = useState<Meas[]>([{ column: "", name: "", scale: "1" }]);
  const [show, setShow] = useState(false);
  const save = useMutation({
    mutationFn: () => post("/api/test-station/connectors", {
      code: f.code, name: f.name, equipmentId: f.equipmentId,
      mapping: {
        serial: f.serial, runId: f.runId || undefined, timestamp: f.timestamp || undefined, result: f.result || undefined, firmware: f.firmware || undefined,
        decimal: f.decimal, serialStrip: f.serialStrip || undefined, utcOffset: f.utcOffset,
        measurements: meas.filter((m) => m.column && m.name).map((m) => ({ column: m.column, name: m.name, scale: Number(m.scale.replace(",", ".")) || 1 })),
      },
    }),
    onSuccess: () => { onDone(); setShow(false); },
  });
  if (!show) return <div><button onClick={() => setShow(true)}>Yeni bağlayıcı</button></div>;
  const stations = eq.data?.filter((e) => e.kind === "test_station") ?? [];
  return (
    <form className="stack" onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
      <h3 style={{ margin: 0 }}>Yeni bağlayıcı</h3>
      <div className="row">
        <label className="field" style={{ width: 120 }}>Kod<input aria-label="Bağlayıcı kodu" required value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></label>
        <label className="field" style={{ flex: 1 }}>Ad<input aria-label="Bağlayıcı adı" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label className="field">Ekipman (test istasyonu)
          <select aria-label="İstasyon ekipmanı" required value={f.equipmentId} onChange={(e) => setF({ ...f, equipmentId: e.target.value })}>
            <option value="">Seçin</option>{stations.map((e) => <option key={e.id} value={e.id}>{e.code} — {e.name}</option>)}
          </select>
        </label>
      </div>
      <b>Sütun eşlemesi (dosyadaki başlık adları)</b>
      <div className="row" style={{ flexWrap: "wrap" }}>
        {([["serial", "Seri *"], ["runId", "Çalışma kimliği"], ["timestamp", "Zaman"], ["result", "Sonuç"], ["firmware", "Firmware"]] as const).map(([k, l]) => (
          <label key={k} className="field" style={{ width: 150 }}>{l}<input aria-label={`Sütun: ${l}`} required={k === "serial"} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></label>
        ))}
        <label className="field" style={{ width: 120 }}>Ondalık<select aria-label="Ondalık ayırıcı" value={f.decimal} onChange={(e) => setF({ ...f, decimal: e.target.value })}><option value=".">nokta (3.30)</option><option value=",">virgül (3,30)</option></select></label>
        <label className="field" style={{ width: 110 }}>Saat farkı<input aria-label="UTC farkı" pattern="[+-][0-9]{2}:[0-9]{2}" value={f.utcOffset} onChange={(e) => setF({ ...f, utcOffset: e.target.value })} /></label>
        <label className="field" style={{ width: 130 }}>Seri öneki (sil)<input value={f.serialStrip} onChange={(e) => setF({ ...f, serialStrip: e.target.value })} placeholder="ör. SN:" /></label>
      </div>
      <b>Ölçümler → test planı limit adı</b>
      {meas.map((m, i) => {
        const set = (p: Partial<Meas>) => setMeas(meas.map((x, j) => (j === i ? { ...x, ...p } : x)));
        return (
          <div key={i} className="row">
            <input aria-label="Ölçüm sütunu" placeholder="Dosyadaki sütun (ör. V3V3_mV)" value={m.column} onChange={(e) => set({ column: e.target.value })} />
            <input aria-label="Limit adı" placeholder="Plandaki limit adı (ör. V3V3)" value={m.name} onChange={(e) => set({ name: e.target.value })} />
            <label className="row" style={{ gap: 6 }}>× <input aria-label="Ölçek" value={m.scale} onChange={(e) => set({ scale: e.target.value })} style={{ width: 80 }} /></label>
            <button type="button" onClick={() => setMeas(meas.filter((_, j) => j !== i))}>Sil</button>
          </div>
        );
      })}
      <div><button type="button" onClick={() => setMeas([...meas, { column: "", name: "", scale: "1" }])}>Ölçüm ekle</button></div>
      <p className="muted" style={{ margin: 0 }}>Ölçek birim dönüşümü içindir (mV → V için 0.001). Karar her zaman iş emrinin sabitlediği test planından verilir; istasyonun kendi limitleri dikkate alınmaz. Çalışma kimliği yoksa satır içeriğinden türetilir.</p>
      <div className="row"><button className="primary" disabled={save.isPending}>Bağlayıcıyı kaydet</button><button type="button" onClick={() => setShow(false)}>Vazgeç</button></div>
      <ErrorNotice error={save.error} />
    </form>
  );
}

function Upload({ conns, onDone }: { conns: any[]; onDone: (id: string) => void }) {
  const [connId, setConnId] = useState(conns[0]?.id ?? "");
  const [file, setFile] = useState<{ name: string; content: string } | null>(null);
  const prev = useMutation({ mutationFn: () => post<any>(`/api/test-station/connectors/${connId}/preview`, { fileName: file!.name, content: file!.content }), onSuccess: (b) => onDone(b.id) });
  return (
    <section className="card">
      <h2>İstasyon çıktısı yükle (CSV)</h2>
      <form className="row" onSubmit={(e) => { e.preventDefault(); prev.mutate(); }}>
        <label className="field">Bağlayıcı<select aria-label="Yükleme bağlayıcısı" value={connId} onChange={(e) => setConnId(e.target.value)}>{conns.map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}</select></label>
        <label className="field">Dosya<input aria-label="İstasyon dosyası" type="file" accept=".csv,.txt,.tsv" onChange={async (e) => { const f = e.target.files?.[0]; setFile(f ? { name: f.name, content: await f.text() } : null); }} /></label>
        <button className="primary" style={{ alignSelf: "flex-end" }} disabled={!file || prev.isPending}>Önizle</button>
      </form>
      <ErrorNotice error={prev.error} />
      {prev.data?.duplicateFile ? <div className="notice">Bu dosya daha önce yüklenmiş; mevcut yükleme açıldı.</div> : null}
    </section>
  );
}

function BatchView({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["stationBatch", id], queryFn: () => get<any>(`/api/test-station/batches/${id}`) });
  const act = useMutation({
    mutationFn: (f: () => Promise<unknown>) => f(),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["stationBatch", id] }); qc.invalidateQueries({ queryKey: ["stationBatches"] }); },
  });
  const b = q.data;
  if (!b) return <section className="card">{q.isLoading ? <Loading /> : <ErrorNotice error={q.error} />}</section>;
  return (
    <section className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>{b.connectorCode} · {b.fileName ?? (b.source === "api" ? "API gönderimi" : "")} · {b.status === "preview" ? "önizleme" : b.status === "committed" ? "kaydedildi" : "iptal"}</h2>
        <button onClick={onClose}>Kapat</button>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        {Object.entries(b.summary).map(([k, v]) => `${ROW_STATUS[k]?.[0] ?? k}: ${v}`).join(" · ")}
        {b.committedBy ? ` · onaylayan ${b.committedBy} ${fmtDate(b.committedAt)}` : ""}
      </p>
      {b.status === "preview" ? (
        <div className="row">
          <button className="primary" disabled={act.isPending || !b.summary.ready} onClick={() => act.mutate(() => post(`/api/test-station/batches/${id}/commit`))}>Onayla ve kaydet ({b.summary.ready ?? 0} satır)</button>
          <button onClick={() => act.mutate(() => post(`/api/test-station/batches/${id}/cancel`))}>İptal</button>
          <span className="muted">Sorunlu satırlar kaydedilmez; onayda tüm satırlar güncel durumla yeniden değerlendirilir.</span>
        </div>
      ) : null}
      <ErrorNotice error={act.error} />
      <table>
        <thead><tr><th>Satır</th><th>Seri</th><th>Çalışma</th><th>Zaman</th><th>Ölçümler</th><th>Sonuç</th><th>Durum</th><th>Açıklama</th></tr></thead>
        <tbody>{b.rows.map((r: any) => {
          const [label, tone] = ROW_STATUS[r.status] ?? [r.status, ""];
          return (
            <tr key={r.rowNo}>
              <td className="num">{r.rowNo}</td>
              <td className="mono">{r.serial && r.status !== "unknown_serial" && r.status !== "invalid" ? <Link to={`/devices/${r.serial}`}>{r.serial}</Link> : r.serial ?? "—"}</td>
              <td className="mono" style={{ fontSize: 12 }}>{r.externalRunId}</td>
              <td className="muted">{r.measuredAt ? fmtDate(r.measuredAt) : "—"}</td>
              <td className="mono" style={{ fontSize: 12 }}>{(r.measurements ?? []).map((m: any) => `${m.name}=${m.value}`).join(" ")}</td>
              <td>{r.result === "pass" ? <span className="badge ok">geçti</span> : r.result === "fail" ? <span className="badge bad">kaldı</span> : "—"}</td>
              <td><span className={`badge ${tone}`}>{label}</span></td>
              <td>{r.message}{r.code && !["invalid", "unknown_serial", "duplicate"].includes(r.code) ? <span className="mono muted"> ({r.code})</span> : null}</td>
            </tr>
          );
        })}</tbody>
      </table>
    </section>
  );
}
