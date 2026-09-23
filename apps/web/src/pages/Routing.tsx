import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, get, post } from "../lib/api";
import { Empty, ErrorNotice, Loading, PageHeader, fmtDate, useCan } from "../lib/ui";

type Op = { seq: number; name: string; workCenterId: string; setupMinutes: number | string; minutesPerUnit: number | string; isQualityGate: boolean; instructions: string | null };
const STATUS: Record<string, [string, string]> = { draft: ["taslak", "warn"], published: ["yürürlükte", "ok"], archived: ["arşiv", ""] };

/** W20 — revizyon bazında rota ve standart süre (sürümlü; iş emri açıldığı sürümü sabitler). */
export function RoutingPage() {
  const can = useCan();
  const qc = useQueryClient();
  const [sp, setSp] = useSearchParams();
  const rev = sp.get("rev") ?? "";
  const [qty, setQty] = useState("100");
  const products = useQuery({ queryKey: ["products"], queryFn: () => get<any[]>("/api/products") });
  const q = useQuery({ queryKey: ["routings", rev, qty], queryFn: () => get<any>(`/api/revisions/${rev}/routings?qty=${Number(qty) || 1}`), enabled: !!rev });
  const refresh = () => qc.invalidateQueries({ queryKey: ["routings", rev] });
  const act = useMutation({ mutationFn: (f: () => Promise<unknown>) => f(), onSuccess: refresh });
  const d = q.data;
  const draft = d?.versions.find((v: any) => v.status === "draft");
  return (
    <>
      <PageHeader
        title="Rotalar & standart süreler"
        sub="Rota revizyon bazında sürümlüdür. Yayımlanan sürüm değişmez; yeni iş emri en son yayımlanan sürümü kopyalar, açık iş emirleri kendi sürümünde kalır. Termin ve iş merkezi kuyruğu bu sürelerle hesaplanır."
        actions={<Link to="/production">← Üretim</Link>}
      />
      <section className="card">
        <div className="row">
          <label className="field" style={{ minWidth: 280 }}>Ürün revizyonu
            <select aria-label="Ürün revizyonu" value={rev} onChange={(e) => setSp(e.target.value ? { rev: e.target.value } : {})}>
              <option value="">Seçin</option>
              {products.data?.flatMap((p) => p.revisions.map((r: any) => <option key={r.id} value={r.id}>{p.code} Rev.{r.rev} ({r.status})</option>))}
            </select>
          </label>
          {d ? (
            <div style={{ alignSelf: "flex-end" }}>
              Geçerli rota: {d.active.source === "routing" ? <span className="badge ok">v{d.active.versionNo}</span> : <span className="badge warn">varsayılan şablon</span>}
            </div>
          ) : null}
        </div>
      </section>
      {!rev ? <Empty>Rota görmek için revizyon seçin.</Empty> : null}
      {q.isLoading ? <Loading /> : <ErrorNotice error={q.error ?? act.error} />}
      {d ? (
        <>
          <section className="card">
            <div className="row between">
              <h2 style={{ margin: 0 }}>Süre özeti (geçerli rota)</h2>
              <label className="row" style={{ gap: 6 }}>Adet <input aria-label="Özet adedi" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ""))} style={{ width: 90 }} /></label>
            </div>
            <table>
              <thead><tr><th>#</th><th>Operasyon</th><th>İş merkezi</th><th className="num">Dakika</th><th className="num">Gün (kapasite)</th></tr></thead>
              <tbody>{d.estimate.operations.map((o: any) => (
                <tr key={o.seq}><td>{o.seq}</td><td>{o.name}</td><td className="mono">{o.workCenter} {o.workCenter === d.estimate.bottleneck ? <span className="badge warn">en uzun</span> : null}</td><td className="num">{o.minutes}</td><td className="num">{o.days}</td></tr>
              ))}</tbody>
            </table>
            <p className="muted" style={{ margin: 0 }}>Toplam {d.estimate.totalHours} saat · sıralı en az {d.estimate.days} çalışma günü (kuyruk hariç; bir operasyon en az bir gün).</p>
          </section>

          {draft ? <DraftEditor key={draft.id} draft={draft} onChange={refresh} /> : can("capacity.manage") ? (
            <section className="card">
              <div className="row">
                <button className="primary" onClick={() => act.mutate(() => post(`/api/revisions/${rev}/routings`, {}))}>Yeni sürüm taslağı ({d.active.source === "routing" ? `v${d.active.versionNo} kopyası` : "şablondan"})</button>
                <span className="muted">Yayımlanan rota düzenlenmez; değişiklik yeni sürümle yapılır.</span>
              </div>
            </section>
          ) : null}

          <section className="card">
            <h2>Sürümler</h2>
            {d.versions.length === 0 ? <Empty>Bu revizyonun rotası yok; iş emirleri varsayılan şablonla açılır.</Empty> : null}
            {d.versions.filter((v: any) => v.status !== "draft").map((v: any) => (
              <details key={v.id} style={{ marginBottom: 8 }}>
                <summary>
                  <b>v{v.versionNo}</b> <span className={`badge ${STATUS[v.status]![1]}`}>{STATUS[v.status]![0]}</span> · {v.note ?? ""} · {v.publishedBy ?? v.createdBy} {fmtDate(v.publishedAt ?? v.createdAt)} · {v.workOrderCount} iş emri
                </summary>
                <table>
                  <tbody>{v.operations.map((o: any) => (
                    <tr key={o.seq}><td>{o.seq}</td><td>{o.name} {o.isQualityGate ? <span className="badge warn">kalite kapısı</span> : null}</td><td className="mono">{o.workCenter}</td><td className="num">hazırlık {o.setupMinutes} dk</td><td className="num">{o.minutesPerUnit} dk/adet</td><td className="muted">{o.instructions}</td></tr>
                  ))}</tbody>
                </table>
                {can("capacity.manage") && !draft ? <button onClick={() => act.mutate(() => post(`/api/revisions/${rev}/routings`, { copyFrom: v.id }))}>Bu sürümden taslak aç</button> : null}
              </details>
            ))}
          </section>

          <section className="card">
            <h2>Açık iş emirleri</h2>
            {d.openWorkOrders.length === 0 ? <Empty>Açık iş emri yok.</Empty> : (
              <table><tbody>{d.openWorkOrders.map((w: any) => <tr key={w.code}><td className="mono">{w.code}</td><td>{w.status}</td><td>rota {w.routingVersionNo ? `v${w.routingVersionNo}` : "varsayılan şablon"} (sabit)</td></tr>)}</tbody></table>
            )}
          </section>
        </>
      ) : null}
    </>
  );
}

function DraftEditor({ draft, onChange }: { draft: any; onChange: () => void }) {
  const can = useCan();
  const wcs = useQuery({ queryKey: ["workCenters"], queryFn: () => get<any[]>("/api/work-centers") });
  const [ops, setOps] = useState<Op[]>(draft.operations);
  const [errors, setErrors] = useState<string[]>(draft.errors);
  const [dirty, setDirty] = useState(false);
  const [note, setNote] = useState("");
  useEffect(() => { setErrors(draft.errors); }, [draft]);
  const payload = () => ops.map((o, k) => ({ ...o, seq: (k + 1) * 10, setupMinutes: Number(String(o.setupMinutes).replace(",", ".")) || 0, minutesPerUnit: Number(String(o.minutesPerUnit).replace(",", ".")) || 0, instructions: o.instructions || null }));
  const save = useMutation({ mutationFn: () => api<any>("PUT", `/api/routings/${draft.id}`, { operations: payload() }), onSuccess: (r) => { setErrors(r.errors); setDirty(false); onChange(); } });
  const act = useMutation({ mutationFn: (f: () => Promise<unknown>) => f(), onSuccess: onChange });
  const set = (i: number, p: Partial<Op>) => { setOps(ops.map((o, j) => (j === i ? { ...o, ...p } : o))); setDirty(true); };
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= ops.length) return;
    const next = [...ops];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setOps(next.map((o, k) => ({ ...o, seq: (k + 1) * 10 })));
    setDirty(true);
  };
  const edit = can("capacity.manage");
  return (
    <section className="card">
      <h2>Taslak v{draft.versionNo}</h2>
      <table>
        <thead><tr><th>Sıra</th><th>Operasyon</th><th>İş merkezi</th><th className="num">Hazırlık (dk)</th><th className="num">Birim (dk/adet)</th><th>Kalite kapısı</th><th>Talimat</th><th /></tr></thead>
        <tbody>{ops.map((o, i) => (
          <tr key={i}>
            <td className="num">{o.seq}</td>
            <td><input aria-label={`Operasyon ${i + 1} adı`} disabled={!edit} value={o.name} onChange={(e) => set(i, { name: e.target.value })} /></td>
            <td><select aria-label={`Operasyon ${i + 1} iş merkezi`} disabled={!edit} value={o.workCenterId} onChange={(e) => set(i, { workCenterId: e.target.value })}>{wcs.data?.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}</select></td>
            <td><input aria-label={`Operasyon ${i + 1} hazırlık`} disabled={!edit} inputMode="decimal" value={o.setupMinutes} onChange={(e) => set(i, { setupMinutes: e.target.value })} style={{ width: 80 }} /></td>
            <td><input aria-label={`Operasyon ${i + 1} birim süre`} disabled={!edit} inputMode="decimal" value={o.minutesPerUnit} onChange={(e) => set(i, { minutesPerUnit: e.target.value })} style={{ width: 80 }} /></td>
            <td><input type="radio" name="gate" aria-label={`Operasyon ${i + 1} kalite kapısı`} disabled={!edit} style={{ minHeight: 0 }} checked={o.isQualityGate} onChange={() => { setOps(ops.map((x, j) => ({ ...x, isQualityGate: j === i }))); setDirty(true); }} /></td>
            <td><input aria-label={`Operasyon ${i + 1} talimat`} disabled={!edit} value={o.instructions ?? ""} onChange={(e) => set(i, { instructions: e.target.value })} placeholder="İsteğe bağlı" /></td>
            <td>{edit ? <div className="row" style={{ flexWrap: "nowrap", gap: 4 }}><button type="button" aria-label="Yukarı" onClick={() => move(i, -1)}>↑</button><button type="button" aria-label="Aşağı" onClick={() => move(i, 1)}>↓</button><button type="button" onClick={() => { setOps(ops.filter((_, j) => j !== i)); setDirty(true); }}>Sil</button></div> : null}</td>
          </tr>
        ))}</tbody>
      </table>
      {edit ? (
        <div className="row">
          <button type="button" onClick={() => { setOps([...ops, { seq: (ops.length + 1) * 10, name: "", workCenterId: wcs.data?.[0]?.id ?? "", setupMinutes: 0, minutesPerUnit: 0, isQualityGate: false, instructions: null }]); setDirty(true); }}>Operasyon ekle</button>
          <button className="primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>Taslağı kaydet</button>
          <button className="danger" onClick={() => act.mutate(() => post(`/api/routings/${draft.id}/discard`))}>Taslaktan vazgeç</button>
        </div>
      ) : null}
      <ErrorNotice error={save.error ?? act.error} />
      {errors.length ? <div className="notice warn" role="status"><b>Yayımlanamaz:</b><ul>{errors.map((e) => <li key={e}>{e}</li>)}</ul></div> : null}
      {edit ? (
        <div className="row">
          <input aria-label="Yayım gerekçesi" placeholder="Değişiklik gerekçesi (zorunlu)" value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: 1 }} />
          <button className="primary" disabled={dirty || errors.length > 0 || note.length < 3 || act.isPending} onClick={() => act.mutate(() => post(`/api/routings/${draft.id}/publish`, { note }))}>Yayımla</button>
          {dirty ? <span className="muted">Önce taslağı kaydedin.</span> : null}
        </div>
      ) : null}
    </section>
  );
}
