import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, post } from "../lib/api";
import { Empty, ErrorNotice, useCan } from "../lib/ui";

const STAGE: Record<string, string> = { incoming: "Giriş", in_process: "Ara", final: "Son ürün", packing: "Paketleme" };
type Item = { key: string; label: string; kind: "check" | "measure" | "text"; required: boolean; unit?: string; low?: number; high?: number };

/** Bağlama uyan kontrol listeleri: son kayıt + yeni kayıt formu. Uyan plan yoksa hiçbir şey göstermez. */
export function CheckForm({ contextType, contextId, title }: { contextType: "operation" | "receipt_line" | "work_order"; contextId: string; title?: string }) {
  const q = useQuery({ queryKey: ["checkStatus", contextType, contextId], queryFn: () => get<any[]>(`/api/check-status?contextType=${contextType}&contextId=${contextId}`) });
  if (!q.data?.length) return null;
  return (
    <div className="card" style={{ background: "var(--surface-2)", margin: "6px 0" }}>
      {title ? <b>{title}</b> : null}
      {q.data.map((p) => <PlanRecord key={p.planId} p={p} contextType={contextType} contextId={contextId} />)}
    </div>
  );
}

function PlanRecord({ p, contextType, contextId }: { p: any; contextType: string; contextId: string }) {
  const qc = useQueryClient();
  const [vals, setVals] = useState<Record<string, string | boolean>>({});
  const save = useMutation({
    mutationFn: () => post<any>("/api/check-records", {
      planId: p.planId, contextType, contextId,
      results: (p.items as Item[]).map((it) => {
        const v = vals[it.key];
        return { key: it.key, value: v === undefined || v === "" ? null : it.kind === "measure" ? Number(String(v).replace(",", ".")) : v };
      }),
    }),
    onSuccess: () => { setVals({}); qc.invalidateQueries({ queryKey: ["checkStatus", contextType, contextId] }); },
  });
  const last = p.last;
  return (
    <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }} style={{ marginTop: 6 }}>
      <div className="row between">
        <span><b className="mono">{p.code}</b> v{p.versionNo} · {p.name} <span className="muted">({STAGE[p.stage] ?? p.stage})</span></span>
        {last ? <span className={`badge state ${last.passed ? "ok" : "bad"}`}>{last.passed ? "geçti" : "kaldı"} · {last.recordedBy}</span> : <span className="badge state warn">kayıt yok</span>}
      </div>
      {last && !last.passed ? <div className="muted">Son kayıt: {(last.findings as string[]).join(" · ")}</div> : null}
      <div className="row" style={{ flexWrap: "wrap" }}>
        {(p.items as Item[]).map((it) => (
          <label key={it.key} className="field" style={it.kind === "text" ? { flex: 1 } : undefined}>
            {it.label}{it.required ? " *" : ""}{it.kind === "measure" ? ` (${it.low ?? "…"}–${it.high ?? "…"} ${it.unit ?? ""})` : ""}
            {it.kind === "check" ? (
              <select aria-label={`${p.code} ${it.label}`} value={vals[it.key] === undefined ? "" : vals[it.key] ? "yes" : "no"} onChange={(e) => setVals({ ...vals, [it.key]: e.target.value === "" ? "" : e.target.value === "yes" })}>
                <option value="">—</option><option value="yes">Uygun</option><option value="no">Uygun değil</option>
              </select>
            ) : (
              <input aria-label={`${p.code} ${it.label}`} inputMode={it.kind === "measure" ? "decimal" : undefined} value={String(vals[it.key] ?? "")} onChange={(e) => setVals({ ...vals, [it.key]: e.target.value })} />
            )}
          </label>
        ))}
        <button style={{ alignSelf: "flex-end" }} disabled={save.isPending}>Kontrolü kaydet</button>
      </div>
      {save.data && !save.data.passed ? <div className="notice warn">Kaldı: {save.data.findings.join(" · ")}</div> : null}
      <ErrorNotice error={save.error} />
    </form>
  );
}

/** Kalite: kontrol planları (sürümlü; operatör limit değiştiremez). */
export function CheckPlans() {
  const can = useCan();
  const qc = useQueryClient();
  const plans = useQuery({ queryKey: ["checkPlans"], queryFn: () => get<any[]>("/api/check-plans") });
  const wcs = useQuery({ queryKey: ["workCenters"], queryFn: () => get<any[]>("/api/work-centers") });
  const empty: Item = { key: "", label: "", kind: "check", required: true };
  const [f, setF] = useState({ code: "", name: "", stage: "in_process", workCenterCode: "", note: "" });
  const [items, setItems] = useState<Item[]>([{ ...empty }]);
  const save = useMutation({
    mutationFn: () => post("/api/check-plans", {
      ...f, workCenterCode: f.workCenterCode || undefined,
      items: items.map((i) => ({ ...i, unit: i.unit || undefined, low: i.low === undefined || Number.isNaN(i.low) ? undefined : i.low, high: i.high === undefined || Number.isNaN(i.high) ? undefined : i.high })),
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["checkPlans"] }); setF({ ...f, note: "" }); },
  });
  const edit = can("quality.plan.manage");
  const upd = (i: number, v: Partial<Item>) => setItems(items.map((x, j) => (j === i ? { ...x, ...v } : x)));
  const num = (s: string) => (s === "" ? undefined : Number(s.replace(",", ".")));
  return (
    <section className="card">
      <h2>Kontrol listeleri (giriş / ara / son / paketleme)</h2>
      <p className="muted" style={{ margin: 0 }}>Plan sürümlüdür; değişiklik yeni sürüm açar ve kapanışlar güncel sürümü ister. Zorunlu madde eksik veya ölçüm sınır dışıysa kayıt "kaldı" olur; kaldı kaydı silinmez. Giriş listesi kabulü, ara/paketleme listesi o iş merkezindeki operasyonun kapanışını, son liste stoğa bırakmayı engeller.</p>
      {plans.data?.length ? (
        <table>
          <thead><tr><th>Kod</th><th>Aşama</th><th>Bağlam</th><th>Maddeler</th><th>Durum</th></tr></thead>
          <tbody>{plans.data.map((p) => (
            <tr key={p.id}>
              <td className="mono">{p.code} v{p.versionNo}<div className="muted">{p.name}</div></td>
              <td>{STAGE[p.stage]}</td>
              <td className="muted">{[p.productCode && `${p.productCode} Rev.${p.rev}`, p.workCenterCode, p.itemCode].filter(Boolean).join(" · ") || "tümü"}</td>
              <td>{(p.items as Item[]).map((i) => i.label + (i.kind === "measure" ? ` [${i.low ?? "…"}–${i.high ?? "…"}${i.unit ?? ""}]` : "")).join(" · ")}</td>
              <td>{p.active ? "aktif" : "devre dışı"}</td>
            </tr>
          ))}</tbody>
        </table>
      ) : plans.data ? <Empty>Kontrol planı yok — kapanışlar kontrol listesi istemez.</Empty> : null}
      {edit ? (
        <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
          <div className="row">
            <label className="field" style={{ width: 130 }}>Kod<input aria-label="Plan kodu" required pattern="[A-Z0-9-]{2,30}" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></label>
            <label className="field" style={{ flex: 1 }}>Ad<input aria-label="Plan adı" required minLength={3} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
            <label className="field">Aşama<select aria-label="Plan aşaması" value={f.stage} onChange={(e) => setF({ ...f, stage: e.target.value })}>{Object.entries(STAGE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            {["in_process", "packing"].includes(f.stage) ? (
              <label className="field">İş merkezi<select aria-label="Plan iş merkezi" value={f.workCenterCode} onChange={(e) => setF({ ...f, workCenterCode: e.target.value })}><option value="">Tümü</option>{wcs.data?.map((w) => <option key={w.code} value={w.code}>{w.code}</option>)}</select></label>
            ) : null}
          </div>
          {items.map((it, i) => (
            <div key={i} className="row">
              <label className="field" style={{ width: 110 }}>Anahtar<input aria-label="Madde anahtarı" required pattern="[a-z0-9_]{1,40}" value={it.key} onChange={(e) => upd(i, { key: e.target.value.toLowerCase() })} /></label>
              <label className="field" style={{ flex: 1 }}>Madde<input aria-label="Madde adı" required minLength={2} value={it.label} onChange={(e) => upd(i, { label: e.target.value })} /></label>
              <label className="field">Tür<select aria-label="Madde türü" value={it.kind} onChange={(e) => upd(i, { kind: e.target.value as Item["kind"] })}><option value="check">Uygun / değil</option><option value="measure">Ölçüm</option><option value="text">Metin</option></select></label>
              {it.kind === "measure" ? (
                <>
                  <label className="field" style={{ width: 80 }}>Alt<input aria-label="Alt sınır" inputMode="decimal" onChange={(e) => upd(i, { low: num(e.target.value) })} /></label>
                  <label className="field" style={{ width: 80 }}>Üst<input aria-label="Üst sınır" inputMode="decimal" onChange={(e) => upd(i, { high: num(e.target.value) })} /></label>
                  <label className="field" style={{ width: 70 }}>Birim<input aria-label="Birim" value={it.unit ?? ""} onChange={(e) => upd(i, { unit: e.target.value })} /></label>
                </>
              ) : null}
              <label className="row" style={{ gap: 4, alignSelf: "flex-end" }}><input type="checkbox" checked={it.required} onChange={(e) => upd(i, { required: e.target.checked })} /> zorunlu</label>
              <button type="button" className="link" style={{ alignSelf: "flex-end" }} onClick={() => setItems(items.filter((_, j) => j !== i))} disabled={items.length === 1}>sil</button>
            </div>
          ))}
          <div className="row">
            <button type="button" onClick={() => setItems([...items, { ...empty }])}>Madde ekle</button>
            <label className="field" style={{ flex: 1 }}>Gerekçe / not<input aria-label="Plan notu" required minLength={3} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
            <button className="primary" style={{ alignSelf: "flex-end" }} disabled={save.isPending}>Planı yayımla (yeni sürüm)</button>
          </div>
        </form>
      ) : null}
      <ErrorNotice error={save.error} />
    </section>
  );
}
