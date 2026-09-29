import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, post } from "../lib/api";
import { Empty, ErrorNotice, Loading, useCan } from "../lib/ui";

const WD = ["", "Pzt", "Sal", "Çar", "Per", "Cum", "Cmt", "Paz"];
const isoWd = (s: string) => ((new Date(`${s}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
const today = () => new Date().toISOString().slice(0, 10);

/** Vardiya şablonları, iş merkezi atamaları ve kapasite istisnaları (R29). */
export function ShiftSettings() {
  const can = useCan();
  const qc = useQueryClient();
  const edit = can("capacity.manage");
  const patterns = useQuery({ queryKey: ["shiftPatterns"], queryFn: () => get<any[]>("/api/shift-patterns") });
  const assigns = useQuery({ queryKey: ["wcShifts"], queryFn: () => get<any[]>("/api/work-center-shifts") });
  const exceptions = useQuery({ queryKey: ["capExceptions"], queryFn: () => get<any[]>(`/api/capacity-exceptions`) });
  const wcs = useQuery({ queryKey: ["workCenters"], queryFn: () => get<any[]>("/api/work-centers") });
  const refresh = () => ["shiftPatterns", "wcShifts", "capExceptions", "capacityLoad"].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  const act = useMutation({ mutationFn: (f: () => Promise<unknown>) => f(), onSuccess: refresh });

  const [p, setP] = useState({ code: "", name: "", startTime: "08:00", endTime: "16:30", breakMinutes: "30", weekdays: [1, 2, 3, 4, 5] as number[] });
  const [a, setA] = useState({ workCenterCode: "", shiftPatternId: "", stations: "1", validFrom: today(), reason: "" });
  const [e, setE] = useState({ workCenterCode: "", day: today(), minutesDelta: "", reason: "" });
  const [endingId, setEndingId] = useState<string | null>(null);

  return (
    <section className="card">
      <h2>Vardiya ve kapasite takvimi</h2>
      <p className="muted" style={{ margin: 0 }}>
        Vardiya atanmış iş merkezinin günlük kapasitesi = o güne düşen vardiyaların net süresi × istasyon sayısı. Vardiya atanmamış merkezde yukarıdaki günlük dakika (hafta içi) kullanılır.
        Tatil 0; istisna eklenir/düşülür. Termin, senaryo ve kaynak yükü bu takvimle hesaplanır.
      </p>
      <ErrorNotice error={act.error} />

      <h3>Vardiya şablonları</h3>
      {patterns.data?.length ? (
        <table>
          <thead><tr><th>Kod</th><th>Ad</th><th>Saat</th><th className="num">Mola</th><th className="num">Net dk</th><th>Günler</th></tr></thead>
          <tbody>{patterns.data.map((s) => <tr key={s.id}><td className="mono">{s.code}</td><td>{s.name}</td><td>{s.startTime}–{s.endTime}</td><td className="num">{s.breakMinutes}</td><td className="num">{s.netMinutes}</td><td>{s.weekdays.map((d: number) => WD[d]).join(" ")}</td></tr>)}</tbody>
        </table>
      ) : patterns.data ? <Empty>Vardiya tanımı yok.</Empty> : null}
      {edit ? (
        <form className="row" onSubmit={(ev: FormEvent) => { ev.preventDefault(); act.mutate(() => post("/api/shift-patterns", { ...p, breakMinutes: Number(p.breakMinutes) })); }}>
          <label className="field" style={{ width: 100 }}>Kod<input aria-label="Vardiya kodu" required pattern="[A-Z0-9-]{1,20}" value={p.code} onChange={(x) => setP({ ...p, code: x.target.value.toUpperCase() })} /></label>
          <label className="field">Ad<input aria-label="Vardiya adı" required minLength={2} value={p.name} onChange={(x) => setP({ ...p, name: x.target.value })} /></label>
          <label className="field">Başlangıç<input type="time" aria-label="Başlangıç saati" required value={p.startTime} onChange={(x) => setP({ ...p, startTime: x.target.value })} /></label>
          <label className="field">Bitiş<input type="time" aria-label="Bitiş saati" required value={p.endTime} onChange={(x) => setP({ ...p, endTime: x.target.value })} /></label>
          <label className="field" style={{ width: 80 }}>Mola dk<input aria-label="Mola dakikası" inputMode="numeric" value={p.breakMinutes} onChange={(x) => setP({ ...p, breakMinutes: x.target.value })} /></label>
          <fieldset className="row" style={{ border: 0, padding: 0, margin: 0, alignSelf: "flex-end" }}>
            {[1, 2, 3, 4, 5, 6, 7].map((d) => (
              <label key={d} style={{ display: "flex", gap: 2, alignItems: "center" }}>
                <input type="checkbox" checked={p.weekdays.includes(d)} onChange={(x) => setP({ ...p, weekdays: x.target.checked ? [...p.weekdays, d] : p.weekdays.filter((y) => y !== d) })} />{WD[d]}
              </label>
            ))}
          </fieldset>
          <button className="primary" style={{ alignSelf: "flex-end" }} disabled={!p.weekdays.length}>Şablon ekle</button>
        </form>
      ) : null}

      <h3>İş merkezi atamaları</h3>
      {assigns.data?.length ? (
        <table>
          <thead><tr><th>İş merkezi</th><th>Vardiya</th><th className="num">İstasyon</th><th>Geçerlilik</th><th>Gerekçe</th><th /></tr></thead>
          <tbody>
            {assigns.data.map((x) => (
              <tr key={x.id}>
                <td className="mono">{x.workCenterCode}</td><td>{x.shiftCode} · {x.shiftName}</td><td className="num">{x.stations}</td>
                <td>{x.validFrom} → {x.validTo ?? "açık"}</td><td className="muted">{x.reason}</td>
                <td>
                  {edit && !x.validTo ? (
                    endingId === x.id ? (
                      <EndForm
                        onSave={(v) => { act.mutate(() => post(`/api/work-center-shifts/${x.id}/end`, v)); setEndingId(null); }}
                        onCancel={() => setEndingId(null)}
                      />
                    ) : <button onClick={() => setEndingId(x.id)}>Sonlandır</button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : assigns.data ? <Empty>Atama yok — tüm merkezler varsayılan günlük dakikayla hesaplanır.</Empty> : null}
      {edit ? (
        <form className="row" onSubmit={(ev: FormEvent) => { ev.preventDefault(); act.mutate(() => post("/api/work-center-shifts", { ...a, stations: Number(a.stations) })); setA({ ...a, reason: "" }); }}>
          <label className="field">İş merkezi
            <select aria-label="Atanacak iş merkezi" required value={a.workCenterCode} onChange={(x) => setA({ ...a, workCenterCode: x.target.value })}>
              <option value="" disabled>Seç</option>{wcs.data?.map((w) => <option key={w.code} value={w.code}>{w.code} · {w.name}</option>)}
            </select>
          </label>
          <label className="field">Vardiya
            <select aria-label="Atanacak vardiya" required value={a.shiftPatternId} onChange={(x) => setA({ ...a, shiftPatternId: x.target.value })}>
              <option value="" disabled>Seç</option>{patterns.data?.map((s) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}
            </select>
          </label>
          <label className="field" style={{ width: 80 }}>İstasyon<input aria-label="İstasyon sayısı" inputMode="numeric" value={a.stations} onChange={(x) => setA({ ...a, stations: x.target.value })} /></label>
          <label className="field">Başlangıç<input type="date" aria-label="Atama başlangıç" required value={a.validFrom} onChange={(x) => setA({ ...a, validFrom: x.target.value })} /></label>
          <label className="field" style={{ flex: 1 }}>Gerekçe<input aria-label="Atama gerekçesi" required minLength={3} value={a.reason} onChange={(x) => setA({ ...a, reason: x.target.value })} /></label>
          <button className="primary" style={{ alignSelf: "flex-end" }}>Ata</button>
        </form>
      ) : null}

      <h3>Kapasite istisnaları</h3>
      {exceptions.data?.length ? (
        <table>
          <thead><tr><th>Gün</th><th>İş merkezi</th><th className="num">Dakika</th><th>Gerekçe</th><th>Kaydeden</th></tr></thead>
          <tbody>{exceptions.data.map((x) => <tr key={x.id}><td>{x.day}</td><td className="mono">{x.workCenterCode ?? "tümü"}</td><td className="num">{x.minutesDelta > 0 ? `+${x.minutesDelta}` : x.minutesDelta}</td><td>{x.reason}</td><td className="muted">{x.createdBy}</td></tr>)}</tbody>
        </table>
      ) : exceptions.data ? <Empty>Son 30 günden beri istisna yok.</Empty> : null}
      {edit ? (
        <form className="row" onSubmit={(ev: FormEvent) => { ev.preventDefault(); act.mutate(() => post("/api/capacity-exceptions", { workCenterCode: e.workCenterCode || undefined, day: e.day, minutesDelta: Number(e.minutesDelta), reason: e.reason })); setE({ ...e, minutesDelta: "", reason: "" }); }}>
          <label className="field">Gün<input type="date" aria-label="İstisna günü" required value={e.day} onChange={(x) => setE({ ...e, day: x.target.value })} /></label>
          <label className="field">İş merkezi
            <select aria-label="İstisna iş merkezi" value={e.workCenterCode} onChange={(x) => setE({ ...e, workCenterCode: x.target.value })}>
              <option value="">Tümü</option>{wcs.data?.map((w) => <option key={w.code} value={w.code}>{w.code}</option>)}
            </select>
          </label>
          <label className="field" style={{ width: 110 }}>Dakika (±)<input aria-label="İstisna dakikası" required inputMode="numeric" placeholder="-240 / +120" value={e.minutesDelta} onChange={(x) => setE({ ...e, minutesDelta: x.target.value })} /></label>
          <label className="field" style={{ flex: 1 }}>Gerekçe<input aria-label="İstisna gerekçesi" required minLength={3} placeholder="Bakım, fazla mesai…" value={e.reason} onChange={(x) => setE({ ...e, reason: x.target.value })} /></label>
          <button style={{ alignSelf: "flex-end" }}>İstisna ekle</button>
        </form>
      ) : null}
    </section>
  );
}

/** Atamayı sonlandırma: bitiş tarihi ve gerekçe (atama silinmez). */
function EndForm({ onSave, onCancel }: { onSave: (v: { validTo: string; reason: string }) => void; onCancel: () => void }) {
  const [v, setV] = useState({ validTo: today(), reason: "" });
  return (
    <form className="row" onSubmit={(ev: FormEvent) => { ev.preventDefault(); onSave(v); }}>
      <input type="date" aria-label="Atama bitiş" required value={v.validTo} onChange={(y) => setV({ ...v, validTo: y.target.value })} />
      <input aria-label="Sonlandırma gerekçesi" required minLength={3} placeholder="Gerekçe" value={v.reason} onChange={(y) => setV({ ...v, reason: y.target.value })} />
      <button>Sonlandır</button><button type="button" onClick={onCancel}>Vazgeç</button>
    </form>
  );
}

/** Kaynak yükü: iş merkezi × gün; hücre = yüklenen / kullanılabilir dakika (R29, Gantt'ın altında). */
export function CapacityLoad({ from, to }: { from: string; to: string }) {
  const q = useQuery({ queryKey: ["capacityLoad", from, to], queryFn: () => get<any>(`/api/capacity/load?from=${from}&to=${to}`) });
  const d = q.data;
  const tone = (load: number, avail: number) => {
    if (avail <= 0) return load > 0 ? "var(--bad-soft)" : "var(--surface-2)";
    const r = load / avail;
    return r >= 1 ? "var(--bad-soft)" : r >= 0.8 ? "var(--warn-soft)" : r > 0 ? "var(--ok-soft)" : undefined;
  };
  return (
    <section className="card">
      <h2>Kaynak yükü (iş merkezi kapasitesi)</h2>
      {q.isLoading ? <Loading /> : <ErrorNotice error={q.error} />}
      {d ? (
        <>
          <div style={{ overflowX: "auto" }}>
            <table style={{ fontSize: 12 }}>
              <thead>
                <tr>
                  <th>Merkez</th><th className="num">Kullanım</th><th className="num">Aşım dk</th>
                  {d.workCenters[0]?.days.map((x: any) => <th key={x.day} className="num" style={{ minWidth: 44 }}>{x.day.slice(8)}<div className="muted">{WD[isoWd(x.day)]}</div></th>)}
                </tr>
              </thead>
              <tbody>
                {d.workCenters.map((w: any) => (
                  <tr key={w.code}>
                    <td><span className="mono">{w.code}</span>{w.source === "shifts" ? <span className="badge" style={{ marginLeft: 4 }}>vardiya</span> : null}</td>
                    <td className="num">{w.utilization === null ? "—" : `%${Math.round(w.utilization * 100)}`}</td>
                    <td className="num">{w.overflowMinutes ? <b>{w.overflowMinutes}</b> : 0}{w.lateOperations ? <div className="muted">{w.lateOperations} geç</div> : null}</td>
                    {w.days.map((x: any) => (
                      <td key={x.day} className="num" style={{ background: tone(x.load, x.available) }} title={x.items.map((i: any) => `${i.woCode} ${i.op}: ${i.minutes} dk`).join("\n") || undefined}>
                        {x.available || x.load ? <>{x.load}<div className="muted">/{x.available}</div></> : <span className="muted">—</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="muted" style={{ margin: 0 }}>{d.notes.map((n: string) => <li key={n}>{n}</li>)}</ul>
        </>
      ) : null}
    </section>
  );
}
