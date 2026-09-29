import { useState } from "react";
import { CheckPlans } from "../components/Checklist";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, get, post } from "../lib/api";
import { QualityTabs } from "./Station";
import { ShiftSettings } from "../components/Capacity";
import { Empty, ErrorNotice, Loading, PageHeader, StateBadge, fmtDate, useCan } from "../lib/ui";

const KIND: Record<string, string> = { test_station: "Test istasyonu", measuring: "Ölçüm cihazı", fixture: "Fikstür", programmer: "Programlayıcı", oven: "Kurutma fırını" };

/** Ekipman ve kalibrasyon; iş merkezi kapasitesi ve tatiller (termin hesabının girdileri). */
export function QualityPage() {
  const can = useCan();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["equipment"], queryFn: () => get<any[]>("/api/equipment") });
  const act = useMutation({ mutationFn: (f: () => Promise<unknown>) => f(), onSuccess: () => qc.invalidateQueries({ queryKey: ["equipment"] }) });
  const [f, setF] = useState({ code: "", name: "", kind: "test_station", calibrationDue: "" });
  const [affectedOf, setAffectedOf] = useState<any | null>(null);
  return (
    <>
      <PageHeader title="Kalite & Ekipman" sub="Hizmet dışı veya kalibrasyonu geçmiş ekipmanla test kaydı alınmaz. Test planları ürün revizyonunda yönetilir." />
      <QualityTabs />
      <ErrorNotice error={act.error} />
      <section className="card">
        <h2>Ekipman</h2>
        {list.isLoading ? <Loading /> : <ErrorNotice error={list.error} />}
        {list.data?.length === 0 ? <Empty>Ekipman tanımlı değil.</Empty> : null}
        {list.data && list.data.length > 0 ? (
          <table>
            <thead><tr><th>Kod</th><th>Ad</th><th>Tür</th><th>Durum</th><th>Kalibrasyon</th><th /></tr></thead>
            <tbody>{list.data.map((e) => <EquipmentRow key={e.id} e={e} act={act.mutate} onAffected={() => setAffectedOf(e)} />)}</tbody>
          </table>
        ) : null}
        {can("equipment.manage") ? (
          <form className="row" onSubmit={(ev) => { ev.preventDefault(); act.mutate(() => post("/api/equipment", { ...f, calibrationDue: f.calibrationDue || undefined })); setF({ ...f, code: "", name: "" }); }}>
            <label className="field">Kod<input required value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} style={{ width: 110 }} /></label>
            <label className="field" style={{ flex: 1 }}>Ad<input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
            <label className="field">Tür
              <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
            </label>
            <label className="field">Kalibrasyon bitişi<input type="date" value={f.calibrationDue} onChange={(e) => setF({ ...f, calibrationDue: e.target.value })} /></label>
            <button className="primary" style={{ alignSelf: "flex-end" }}>Ekle</button>
          </form>
        ) : null}
      </section>
      {affectedOf ? <Affected e={affectedOf} onClose={() => setAffectedOf(null)} /> : null}
      <DryoutRecipes />
      <Capacity />
      <ShiftSettings />
      <CheckPlans />
    </>
  );
}

const MSL_LEVELS = ["1", "2", "2a", "3", "4", "5", "5a", "6"];

/**
 * Kurutma (bake-out) reçeteleri (W33 devamı): sıcaklık/süre üreticinin datasheet/prosedürüne göre
 * kalite tarafından sürümlü tanımlanır — JEDEC J-STD-033 tablosu burada sabit kodlanmaz. Sürümler
 * değişmez, yeni sürüm eskisini geçersiz kılmaz (cost_policies ile aynı desen).
 */
function DryoutRecipes() {
  const can = useCan();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["dryoutRecipes"], queryFn: () => get<any[]>("/api/dryout-recipes") });
  const [f, setF] = useState({ mslLevel: "", temperatureC: "", durationHours: "", source: "", note: "" });
  const add = useMutation({
    mutationFn: () => post("/api/dryout-recipes", { mslLevel: f.mslLevel || null, temperatureC: Number(f.temperatureC), durationHours: Number(f.durationHours), source: f.source, note: f.note || undefined }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["dryoutRecipes"] }); setF({ ...f, temperatureC: "", durationHours: "", source: "", note: "" }); },
  });
  return (
    <section className="card">
      <h2>Kurutma (bake-out) reçeteleri</h2>
      <p className="muted" style={{ margin: 0 }}>Standart bir JEDEC tablosu burada uygulanmaz (cihaz kalınlığı ve üreticiye göre değişir) — her reçete üreticinin datasheet/prosedürüne dayanmalı ve kaynağı belirtilmelidir.</p>
      <ErrorNotice error={add.error} />
      {q.data?.length === 0 ? <Empty>Tanımlı reçete yok.</Empty> : null}
      {q.data?.length ? (
        <table>
          <thead><tr><th>Sürüm</th><th>MSL</th><th>Kalem</th><th className="num">Sıcaklık</th><th className="num">Süre</th><th>Kaynak</th><th>Not</th></tr></thead>
          <tbody>{q.data.map((r: any) => <tr key={r.id}><td>v{r.versionNo}</td><td>{r.mslLevel ?? "genel"}</td><td className="mono">{r.itemCode ?? "genel"}</td><td className="num">{r.temperatureC}°C</td><td className="num">{r.durationHours} sa</td><td className="muted">{r.source}</td><td className="muted">{r.note ?? ""}</td></tr>)}</tbody>
        </table>
      ) : null}
      {can("item.storage.manage") ? (
        <form className="row" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
          <label className="field">MSL<select value={f.mslLevel} onChange={(e) => setF({ ...f, mslLevel: e.target.value })}><option value="">Genel</option>{MSL_LEVELS.map((m) => <option key={m} value={m}>{m}</option>)}</select></label>
          <label className="field" style={{ width: 100 }}>Sıcaklık (°C)<input required inputMode="decimal" value={f.temperatureC} onChange={(e) => setF({ ...f, temperatureC: e.target.value })} /></label>
          <label className="field" style={{ width: 100 }}>Süre (sa)<input required inputMode="decimal" value={f.durationHours} onChange={(e) => setF({ ...f, durationHours: e.target.value })} /></label>
          <label className="field" style={{ flex: 1 }}>Kaynak (datasheet/prosedür)<input required minLength={3} value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} /></label>
          <label className="field" style={{ flex: 1 }}>Not<input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
          <button className="primary" style={{ alignSelf: "flex-end" }} disabled={add.isPending}>Yeni sürüm</button>
        </form>
      ) : null}
    </section>
  );
}

function EquipmentRow({ e, act, onAffected }: { e: any; act: (f: () => Promise<unknown>) => void; onAffected: () => void }) {
  const can = useCan();
  const [mode, setMode] = useState<"" | "cal" | "status">("");
  const [cal, setCal] = useState({ calibratedOn: new Date().toISOString().slice(0, 10), validUntil: "", certificate: "" });
  const [reason, setReason] = useState("");
  return (
    <>
      <tr>
        <td className="mono">{e.code}</td><td>{e.name}</td><td>{KIND[e.kind]}</td>
        <td><StateBadge value={e.status} prefix="eq" /></td>
        <td>{e.calibrationDue ?? "—"} {e.calibrationExpired ? <span className="badge bad">Süresi doldu</span> : null}</td>
        <td className="row" style={{ justifyContent: "flex-end" }}>
          <button onClick={onAffected}>Etkilenen testler</button>
          {can("equipment.manage") ? <button onClick={() => setMode(mode === "cal" ? "" : "cal")}>Kalibrasyon gir</button> : null}
          {can("equipment.manage") ? <button onClick={() => setMode(mode === "status" ? "" : "status")}>{e.status === "active" ? "Hizmet dışı" : "Aktif et"}</button> : null}
        </td>
      </tr>
      {mode === "cal" ? (
        <tr><td colSpan={6}>
          <form className="row" onSubmit={(ev) => { ev.preventDefault(); act(() => post(`/api/equipment/${e.id}/calibration`, { ...cal, certificate: cal.certificate || undefined })); setMode(""); }}>
            <label className="field">Kalibrasyon tarihi<input type="date" required value={cal.calibratedOn} onChange={(ev) => setCal({ ...cal, calibratedOn: ev.target.value })} /></label>
            <label className="field">Geçerlilik sonu<input type="date" required value={cal.validUntil} onChange={(ev) => setCal({ ...cal, validUntil: ev.target.value })} /></label>
            <label className="field">Sertifika no<input value={cal.certificate} onChange={(ev) => setCal({ ...cal, certificate: ev.target.value })} /></label>
            <button className="primary" style={{ alignSelf: "flex-end" }}>Kaydet</button>
          </form>
        </td></tr>
      ) : null}
      {mode === "status" ? (
        <tr><td colSpan={6}>
          <form className="row" onSubmit={(ev) => { ev.preventDefault(); act(() => post(`/api/equipment/${e.id}/status`, { status: e.status === "active" ? "out_of_service" : "active", reason })); setMode(""); setReason(""); }}>
            <label className="field" style={{ flex: 1 }}>Gerekçe<input required minLength={3} value={reason} onChange={(ev) => setReason(ev.target.value)} /></label>
            <button className="primary" style={{ alignSelf: "flex-end" }}>Onayla</button>
          </form>
        </td></tr>
      ) : null}
    </>
  );
}

function Affected({ e, onClose }: { e: any; onClose: () => void }) {
  const [from, setFrom] = useState("");
  const q = useQuery({ queryKey: ["affected", e.id, from], queryFn: () => get<any[]>(`/api/equipment/${e.id}/affected-tests${from ? `?from=${from}` : ""}`) });
  return (
    <section className="card">
      <div className="row between">
        <h2>{e.code} ile yapılan testler</h2>
        <div className="row">
          <label className="field">Başlangıç<input type="date" value={from} onChange={(ev) => setFrom(ev.target.value)} /></label>
          <button onClick={onClose}>Kapat</button>
        </div>
      </div>
      {q.isLoading ? <Loading /> : <ErrorNotice error={q.error} />}
      {q.data?.length === 0 ? <Empty>Bu ekipmanla test kaydı yok.</Empty> : null}
      {q.data && q.data.length > 0 ? (
        <table>
          <thead><tr><th>Seri</th><th>İş emri</th><th>Test</th><th>Sonuç</th><th>Cihaz durumu</th><th>Zaman</th></tr></thead>
          <tbody>{q.data.map((r) => <tr key={r.serial + r.runNo}><td className="mono">{r.serial}</td><td className="mono">{r.workOrderCode}</td><td>#{r.runNo}</td><td>{r.result === "pass" ? "geçti" : "kaldı"}</td><td><StateBadge value={r.deviceStatus} prefix="dev" /></td><td className="muted">{fmtDate(r.testedAt)}</td></tr>)}</tbody>
        </table>
      ) : null}
    </section>
  );
}

function Capacity() {
  const can = useCan();
  const qc = useQueryClient();
  const wcs = useQuery({ queryKey: ["workCenters"], queryFn: () => get<any[]>("/api/work-centers") });
  const hol = useQuery({ queryKey: ["holidays"], queryFn: () => get<any[]>("/api/holidays") });
  const act = useMutation({ mutationFn: (f: () => Promise<unknown>) => f(), onSuccess: () => { qc.invalidateQueries({ queryKey: ["workCenters"] }); qc.invalidateQueries({ queryKey: ["holidays"] }); } });
  const [h, setH] = useState({ day: "", name: "" });
  const edit = can("capacity.manage");
  return (
    <section className="card">
      <h2>Kapasite ve takvim (termin girdileri)</h2>
      <ErrorNotice error={act.error} />
      <table>
        <thead><tr><th>İş merkezi</th><th className="num">Günlük dk</th><th className="num">Hazırlık dk</th><th className="num">Birim dk</th><th /></tr></thead>
        <tbody>{wcs.data?.map((w) => <WcRow key={w.code} w={w} edit={edit} act={act.mutate} />)}</tbody>
      </table>
      <h3>Tatiller</h3>
      {hol.data?.length === 0 ? <Empty>Tanımlı tatil yok (hafta sonları her zaman çalışılmaz).</Empty> : null}
      <div className="row">{hol.data?.map((x) => <span key={x.day} className="badge">{x.day} · {x.name}</span>)}</div>
      {edit ? (
        <form className="row" onSubmit={(e) => { e.preventDefault(); act.mutate(() => post("/api/holidays", h)); setH({ day: "", name: "" }); }}>
          <label className="field">Gün<input type="date" required value={h.day} onChange={(e) => setH({ ...h, day: e.target.value })} /></label>
          <label className="field">Ad<input required minLength={2} value={h.name} onChange={(e) => setH({ ...h, name: e.target.value })} /></label>
          <button style={{ alignSelf: "flex-end" }}>Tatil ekle</button>
        </form>
      ) : null}
    </section>
  );
}

function WcRow({ w, edit, act }: { w: any; edit: boolean; act: (f: () => Promise<unknown>) => void }) {
  const [v, setV] = useState({ dailyMinutes: String(w.dailyMinutes), setupMinutes: String(w.setupMinutes), minutesPerUnit: String(w.minutesPerUnit) });
  const changed = v.dailyMinutes !== String(w.dailyMinutes) || v.setupMinutes !== String(w.setupMinutes) || v.minutesPerUnit !== String(w.minutesPerUnit);
  const cell = (k: keyof typeof v) => (edit ? <input aria-label={`${w.code} ${k}`} inputMode="decimal" value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} style={{ width: 90, textAlign: "right" }} /> : v[k]);
  return (
    <tr>
      <td><span className="mono">{w.code}</span> {w.name}</td>
      <td className="num">{cell("dailyMinutes")}</td><td className="num">{cell("setupMinutes")}</td><td className="num">{cell("minutesPerUnit")}</td>
      <td>{edit && changed ? <button className="primary" onClick={() => act(() => api("PUT", `/api/work-centers/${w.code}`, { dailyMinutes: Number(v.dailyMinutes), setupMinutes: Number(v.setupMinutes), minutesPerUnit: Number(v.minutesPerUnit) }))}>Kaydet</button> : null}</td>
    </tr>
  );
}
