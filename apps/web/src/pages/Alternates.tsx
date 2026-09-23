import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, post } from "../lib/api";
import { Empty, ErrorNotice, Loading, PageHeader, fmtDate, useCan } from "../lib/ui";

const STATUS: Record<string, [string, string]> = {
  proposed: ["Onay bekliyor", "warn"],
  approved: ["Onaylı", "ok"],
  rejected: ["Reddedildi", "bad"],
  revoked: ["Geri alındı", "bad"],
};
const AREA: Record<string, string> = { rd: "Ar-Ge", production: "Üretim" };
const yn = (v: boolean | null) => (v === true ? "✓" : v === false ? "✗" : "?");

/** W29 — onaylı alternatif parça: öneri (kural tabanlı aday), Ar-Ge + üretim onayı, geri alma. */
export function AlternatesPage() {
  const can = useCan();
  const qc = useQueryClient();
  const [status, setStatus] = useState("");
  const q = useQuery({ queryKey: ["alternates", status], queryFn: () => get<any[]>(`/api/alternates${status ? `?status=${status}` : ""}`) });
  const canPropose = can("product.create") || can("supplier.manage");
  return (
    <>
      <PageHeader title="Alternatif parçalar" sub="Onaylı alternatif, iş emrinde birincil parça yerine çıkılabilir ve tedarik görünümünde önerilir. Ar-Ge ve üretim ayrı onaylar; öneren onaylayamaz." />
      <p style={{ marginTop: 0 }}><Link to="/products">← Ürünler</Link></p>
      {canPropose ? <ProposeForm onDone={() => qc.invalidateQueries({ queryKey: ["alternates"] })} /> : null}
      <section className="card">
        <div className="row between">
          <h2 style={{ margin: 0 }}>Kayıtlar</h2>
          <label className="row" style={{ gap: 6 }}>Durum
            <select aria-label="Durum filtresi" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Tümü</option>
              {Object.entries(STATUS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
        </div>
        {q.isLoading ? <Loading /> : <ErrorNotice error={q.error} />}
        {q.data && !q.data.length ? <Empty>Alternatif kaydı yok.</Empty> : null}
        {q.data?.map((a) => <AlternateCard key={a.id} a={a} onDone={() => qc.invalidateQueries({ queryKey: ["alternates"] })} />)}
      </section>
    </>
  );
}

function AlternateCard({ a, onDone }: { a: any; onDone: () => void }) {
  const can = useCan();
  const [note, setNote] = useState("");
  const [revoke, setRevoke] = useState("");
  const act = useMutation({ mutationFn: (fn: () => Promise<unknown>) => fn(), onSuccess: () => { setNote(""); setRevoke(""); onDone(); } });
  const [label, cls] = STATUS[a.status] ?? [a.status, ""];
  const evidenceOk = a.pinCompatible && a.footprintSame && a.electricalEquivalent;
  const canRevoke = a.status === "approved" && (can("product.approve.rd") || can("product.approve.production") || can("product.approve.quality"));
  return (
    <div className="card" style={{ margin: "12px 0", background: "var(--bg)" }} data-testid="alternate">
      <div className="row between">
        <div>
          <b className="mono">{a.itemCode}</b> <span className="muted">{a.itemMpn}</span> → <b className="mono">{a.alternateCode}</b> <span className="muted">{a.alternateManufacturer} {a.alternateMpn}</span>
          <div className="muted">{a.productCode ? `Yalnız ${a.productCode}` : "Tüm ürünler"} · {a.origin === "rule_candidate" ? "kural tabanlı adaydan" : "elle"} · {a.proposedBy}, {fmtDate(a.proposedAt)}</div>
        </div>
        <span className={`badge ${cls}`}>{label}</span>
      </div>
      <p style={{ margin: "8px 0" }}>{a.reason}</p>
      <div className="row" style={{ gap: 16 }}>
        <span>Pin uyumu {yn(a.pinCompatible)}</span><span>Footprint {yn(a.footprintSame)}</span><span>Elektriksel eşdeğer {yn(a.electricalEquivalent)}</span>
        <span className="muted">Serbest stok {a.alternateFreeStock ?? "—"} · kullanılan çıkış {a.usedIssues}</span>
      </div>
      {a.evidence ? <p className="muted" style={{ margin: "4px 0" }}>Kanıt: {a.evidence}</p> : null}
      {a.approvals.length ? (
        <ul style={{ margin: "8px 0" }}>{a.approvals.map((p: any) => <li key={p.area}>{AREA[p.area]}: <b>{p.decision === "approve" ? "onay" : "ret"}</b> — {p.by}, {fmtDate(p.at)}{p.note ? ` · ${p.note}` : ""}</li>)}</ul>
      ) : null}
      {a.status === "revoked" ? <div className="notice bad">Geri alındı: {a.revokeReason} — yeni çıkış yapılamaz; geçmiş çıkışlar kayıtta kalır.</div> : null}
      <ErrorNotice error={act.error} />
      {a.status === "proposed" && a.missingApprovals.some((x: string) => can(`product.approve.${x}` as any)) ? (
        <div className="row" style={{ alignItems: "flex-end" }}>
          <label className="field" style={{ flex: 1 }}>Karar notu {evidenceOk ? "" : "(kanıt eksik — onay için teknik gerekçe ≥ 20 karakter)"}
            <input aria-label="Karar notu" value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          {a.missingApprovals.filter((x: string) => can(`product.approve.${x}` as any)).map((x: string) => (
            <span key={x} className="row" style={{ gap: 6 }}>
              <button className="primary" disabled={act.isPending} onClick={() => { const n = note; act.mutate(() => post(`/api/alternates/${a.id}/decision`, { area: x, decision: "approve", note: n || undefined })); }}>{AREA[x]} onayı</button>
              <button disabled={act.isPending} onClick={() => { const n = note; act.mutate(() => post(`/api/alternates/${a.id}/decision`, { area: x, decision: "reject", note: n || undefined })); }}>{AREA[x]} reddi</button>
            </span>
          ))}
        </div>
      ) : a.status === "proposed" ? <p className="muted" style={{ margin: 0 }}>Bekleyen onay: {a.missingApprovals.map((x: string) => AREA[x]).join(", ")}</p> : null}
      {canRevoke ? (
        <div className="row" style={{ alignItems: "flex-end" }}>
          <label className="field" style={{ flex: 1 }}>Geri alma gerekçesi<input aria-label="Geri alma gerekçesi" value={revoke} onChange={(e) => setRevoke(e.target.value)} /></label>
          <button className="danger" disabled={act.isPending || revoke.trim().length < 5} onClick={() => { const r = revoke; act.mutate(() => post(`/api/alternates/${a.id}/revoke`, { reason: r })); }}>Geri al</button>
        </div>
      ) : null}
    </div>
  );
}

function ItemPicker({ label, value, onChange }: { label: string; value: any | null; onChange: (i: any | null) => void }) {
  const [text, setText] = useState("");
  const q = useQuery({ queryKey: ["items", text], queryFn: () => get<any[]>(`/api/items?q=${encodeURIComponent(text)}`), enabled: text.length >= 2 && !value });
  if (value) return <div className="field">{label}<div><b className="mono">{value.code}</b> {value.name} <button type="button" className="link" onClick={() => onChange(null)}>değiştir</button></div></div>;
  return (
    <label className="field">{label}
      <input aria-label={label} placeholder="Kod, ad veya MPN" value={text} onChange={(e) => setText(e.target.value)} />
      {q.data?.length ? (
        <div style={{ maxHeight: 180, overflow: "auto" }}>{q.data.slice(0, 20).map((i) => (
          <button type="button" key={i.id} className="link" style={{ display: "block", textAlign: "left" }} onClick={() => onChange(i)}><span className="mono">{i.code}</span> · {i.name}</button>
        ))}</div>
      ) : null}
    </label>
  );
}

function ProposeForm({ onDone }: { onDone: () => void }) {
  const [item, setItem] = useState<any | null>(null);
  const [alt, setAlt] = useState<any | null>(null);
  const [origin, setOrigin] = useState<"manual" | "rule_candidate">("manual");
  const [f, setF] = useState({ reason: "", evidence: "", pin: false, footprint: false, electrical: false });
  const cand = useQuery({ queryKey: ["altCandidates", item?.id], queryFn: () => get<any>(`/api/items/${item.id}/alternate-candidates`), enabled: !!item });
  const save = useMutation({
    mutationFn: () => post("/api/alternates", {
      itemId: item.id, alternateItemId: alt.id, origin, reason: f.reason, evidence: f.evidence || undefined,
      pinCompatible: f.pin, footprintSame: f.footprint, electricalEquivalent: f.electrical,
    }),
    onSuccess: () => { setAlt(null); setF({ reason: "", evidence: "", pin: false, footprint: false, electrical: false }); onDone(); },
  });
  return (
    <section className="card">
      <h2>Alternatif öner</h2>
      <div className="row" style={{ alignItems: "flex-start" }}>
        <ItemPicker label="Birincil parça" value={item} onChange={(i) => { setItem(i); setAlt(null); }} />
        <ItemPicker label="Alternatif parça" value={alt} onChange={(i) => { setAlt(i); setOrigin("manual"); }} />
      </div>
      {item && !alt ? (
        <div>
          {cand.isLoading ? <Loading /> : <ErrorNotice error={cand.error} />}
          {cand.data ? (
            <>
              <p className="muted" style={{ margin: "4px 0" }}>{cand.data.method}</p>
              {cand.data.candidates.length ? (
                <table>
                  <thead><tr><th>Aday</th><th>Eşleşen</th><th className="num">Puan</th><th className="num">Serbest stok</th><th></th></tr></thead>
                  <tbody>{cand.data.candidates.map((c: any) => (
                    <tr key={c.itemId}>
                      <td><span className="mono">{c.code}</span> · {c.name}<div className="muted">{c.manufacturer} {c.mpn}{c.lifecycle && c.lifecycle !== "active" ? ` · ${c.lifecycle}` : ""}</div></td>
                      <td>{c.matched.join(", ")}</td><td className="num">{c.score}</td><td className="num">{c.freeStock}</td>
                      <td><button type="button" onClick={() => { setAlt({ id: c.itemId, code: c.code, name: c.name }); setOrigin("rule_candidate"); }}>Aday olarak seç</button></td>
                    </tr>
                  ))}</tbody>
                </table>
              ) : <p className="muted">Kural tabanlı aday bulunamadı; alternatifi elle seçin.</p>}
            </>
          ) : null}
        </div>
      ) : null}
      {item && alt ? (
        <>
          <label className="field">Gerekçe (≥ 10 karakter)<input aria-label="Gerekçe" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="örn. birincil parça EOL / temin 16 hafta" /></label>
          <div className="row">
            <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={f.pin} onChange={(e) => setF({ ...f, pin: e.target.checked })} /> Pin uyumlu</label>
            <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={f.footprint} onChange={(e) => setF({ ...f, footprint: e.target.checked })} /> Aynı footprint</label>
            <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={f.electrical} onChange={(e) => setF({ ...f, electrical: e.target.checked })} /> Elektriksel eşdeğer</label>
          </div>
          <label className="field">Kanıt / not<textarea aria-label="Kanıt" value={f.evidence} onChange={(e) => setF({ ...f, evidence: e.target.value })} placeholder="datasheet karşılaştırması, test sonucu…" /></label>
          <ErrorNotice error={save.error} />
          <button className="primary" disabled={save.isPending || f.reason.trim().length < 10} onClick={() => save.mutate()}>Öneriyi gönder (Ar-Ge + üretim onayına)</button>
        </>
      ) : null}
    </section>
  );
}
