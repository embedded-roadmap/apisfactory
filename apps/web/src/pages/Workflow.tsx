import { useState, type FormEvent } from "react";
import { Link, NavLink } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, post } from "../lib/api";
import { Empty, ErrorNotice, Loading, PageHeader, fmtDate, useCan, useMe } from "../lib/ui";

export const POLICY_KIND: Record<string, string> = {
  purchase_request: "Satın alma talebi", change_request: "Değişiklik talebi", rma_decision: "İade kararı",
  incoming_inspection: "Giriş kalite kontrolü", device_disposition: "Cihaz kalite kararı",
};
const ROLE: Record<string, string> = {
  manager: "Yönetici", rd: "Ar-Ge", production: "Üretim", technician: "Teknisyen", quality: "Kalite", warehouse: "Depo", sales: "Satış", purchasing: "Satın alma", accounting: "Muhasebe",
};
const PERM: Record<string, string> = {
  "purchase.request.approve": "Satın alma talebi onayı", "change.decide": "Değişiklik talebi kararı", "quality.incoming.decide": "Giriş kalite kararı",
  "quality.final.release": "Son kalite serbest bırakma", "rma.decide": "İade kararı", "product.approve.rd": "Devir onayı (Ar-Ge)",
  "product.approve.production": "Devir onayı (Üretim)", "product.approve.quality": "Devir onayı (Kalite)", "sales.confirm": "Sipariş kesinleştirme",
};

function Tabs() {
  const can = useCan();
  return (
    <div className="row tabs" role="tablist">
      <NavLink to="/workflow" end>Onay politikaları</NavLink>
      <NavLink to="/workflow/delegations">Vekâlet</NavLink>
      {can("workflow.manage") ? <NavLink to="/workflow/monitor">İzleme & müdahale</NavLink> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------
export function WorkflowPage() {
  const can = useCan();
  const q = useQuery({ queryKey: ["policies"], queryFn: () => get<any>("/api/workflow/policies") });
  const [edit, setEdit] = useState<string | null>(null);
  return (
    <>
      <PageHeader title="Akış & onay" sub="Kendi talebini onaylama, rol bazlı parasal limit, süre ve üst sorumluya yükseltme. Politika değişikliği yeni sürümdür; teknik sistem yöneticisi iş onayı almaz." />
      <Tabs />
      {q.isLoading ? <Loading /> : <ErrorNotice error={q.error} />}
      {q.data ? (
        <section className="card">
          <table>
            <thead><tr><th>Tür</th><th>Sürüm</th><th>Kendi talebini onaylama</th><th>Süre</th><th>Yükseltme</th><th>Limitler</th><th /></tr></thead>
            <tbody>
              {q.data.current.map(({ kind, policy: p }: any) => (
                <tr key={kind}>
                  <td>{POLICY_KIND[kind]}</td>
                  <td>{p ? `v${p.versionNo}` : <span className="muted">varsayılan</span>}</td>
                  <td>{p?.allowSelfApproval ? <span className="badge warn">Açık</span> : "Kapalı"}</td>
                  <td>{p?.timeoutHours ? `${p.timeoutHours} saat` : "—"}</td>
                  <td>{p?.escalateToRole ? ROLE[p.escalateToRole] : "—"}</td>
                  <td className="muted">{p?.limits?.length ? p.limits.map((l: any) => `${ROLE[l.roleCode] ?? l.roleCode}: ${l.maxAmount === null ? "sınırsız" : `${Number(l.maxAmount).toLocaleString("tr-TR")} ${l.currency}`}`).join(" · ") : "limit yok"}</td>
                  <td>{can("workflow.manage") ? <button onClick={() => setEdit(edit === kind ? null : kind)}>Yeni sürüm</button> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted" style={{ margin: 0 }}>{q.data.defaults}</p>
        </section>
      ) : null}
      {edit && q.data ? <PolicyEditor kind={edit} current={q.data.current.find((c: any) => c.kind === edit)?.policy} onDone={() => setEdit(null)} /> : null}
      <HandoverPolicyCard />
      {can("workflow.manage") ? <DryRun /> : null}
      {q.data?.history.length ? (
        <section className="card">
          <h2>Sürüm geçmişi</h2>
          <table><tbody>{q.data.history.map((h: any) => <tr key={h.kind + h.versionNo}><td>{POLICY_KIND[h.kind]}</td><td>v{h.versionNo}</td><td>{h.note}</td><td className="muted">{h.createdBy} · {fmtDate(h.createdAt)}</td></tr>)}</tbody></table>
        </section>
      ) : null}
    </>
  );
}

function PolicyEditor({ kind, current, onDone }: { kind: string; current: any; onDone: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    allowSelfApproval: current?.allowSelfApproval ?? false, timeoutHours: current?.timeoutHours ? String(current.timeoutHours) : "",
    escalateToRole: current?.escalateToRole ?? "", note: "",
  });
  const [limits, setLimits] = useState<{ roleCode: string; maxAmount: string; unlimited: boolean; currency: string }[]>(
    (current?.limits ?? []).map((l: any) => ({ roleCode: l.roleCode, maxAmount: l.maxAmount ?? "", unlimited: l.maxAmount === null, currency: l.currency })),
  );
  const save = useMutation({
    mutationFn: () => post("/api/workflow/policies", {
      kind, allowSelfApproval: f.allowSelfApproval, timeoutHours: f.timeoutHours ? Number(f.timeoutHours) : null, escalateToRole: f.escalateToRole || null, note: f.note,
      limits: limits.map((l) => ({ roleCode: l.roleCode, maxAmount: l.unlimited ? null : l.maxAmount, currency: l.currency })),
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["policies"] }); onDone(); },
  });
  return (
    <section className="card">
      <h2>{POLICY_KIND[kind]} — yeni sürüm</h2>
      <form className="stack" onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <div className="row">
          <label className="row" style={{ gap: 6, alignSelf: "flex-end" }}><input type="checkbox" style={{ minHeight: 0 }} checked={f.allowSelfApproval} onChange={(e) => setF({ ...f, allowSelfApproval: e.target.checked })} /> Kişi kendi talebini onaylayabilir</label>
          <label className="field" style={{ width: 140 }}>Süre (saat)<input inputMode="numeric" value={f.timeoutHours} onChange={(e) => setF({ ...f, timeoutHours: e.target.value })} /></label>
          <label className="field">Süre aşımında yükselt
            <select aria-label="Yükseltilecek rol" value={f.escalateToRole} onChange={(e) => setF({ ...f, escalateToRole: e.target.value })}><option value="">—</option>{Object.entries(ROLE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          </label>
        </div>
        {kind === "purchase_request" ? (
          <>
            <b>Rol limitleri (tahmini tutar)</b>
            {limits.map((l, i) => {
              const set = (p: Partial<typeof l>) => setLimits(limits.map((x, j) => (j === i ? { ...x, ...p } : x)));
              return (
                <div key={i} className="row">
                  <select aria-label="Limit rolü" value={l.roleCode} onChange={(e) => set({ roleCode: e.target.value })}>{Object.entries(ROLE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                  <input aria-label="Azami tutar" inputMode="decimal" disabled={l.unlimited} value={l.maxAmount} onChange={(e) => set({ maxAmount: e.target.value })} style={{ width: 140 }} />
                  <input aria-label="Para birimi" value={l.currency} onChange={(e) => set({ currency: e.target.value.toUpperCase() })} style={{ width: 70 }} />
                  <label className="row" style={{ gap: 6 }}><input type="checkbox" style={{ minHeight: 0 }} checked={l.unlimited} onChange={(e) => set({ unlimited: e.target.checked })} /> Sınırsız</label>
                  <button type="button" onClick={() => setLimits(limits.filter((_, j) => j !== i))}>Sil</button>
                </div>
              );
            })}
            <div><button type="button" onClick={() => setLimits([...limits, { roleCode: "purchasing", maxAmount: "", unlimited: false, currency: "TRY" }])}>Limit ekle</button></div>
            <p className="muted" style={{ margin: 0 }}>Limit tanımlıysa limiti olmayan rol onaylayamaz; tutarı bilinmeyen talebi yalnızca sınırsız rol onaylar. Limit aşımında üst role görev açılır.</p>
          </>
        ) : null}
        <label className="field">Gerekçe / not<input required minLength={3} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
        <div className="row"><button className="primary" disabled={save.isPending}>Sürümü yayımla</button><button type="button" onClick={onDone}>Vazgeç</button></div>
        <ErrorNotice error={save.error} />
      </form>
    </section>
  );
}

const REQ_LABEL: Record<string, string> = { test_plan: "Test planı", firmware: "Firmware", firmware_sha: "Firmware SHA-256", routing: "Rota" };

/** Devir politikası (şirket ayarı): devre gönderme ve son onayda zorunlu paket. */
function HandoverPolicyCard() {
  const can = useCan();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["handoverPolicy"], queryFn: () => get<any>("/api/handover/policy") });
  const [f, setF] = useState<{ requireTestPlan: boolean; requireFirmware: boolean; requireFirmwareSha: boolean; requireRouting: boolean; note: string } | null>(null);
  const save = useMutation({ mutationFn: () => post<any>("/api/handover/policy", f), onSuccess: () => { setF(null); qc.invalidateQueries({ queryKey: ["handoverPolicy"] }); } });
  const c = q.data?.current;
  const flags = (p: any) => [p.requireTestPlan && "test planı", p.requireFirmware && "firmware", p.requireFirmwareSha && "SHA-256", p.requireRouting && "rota"].filter(Boolean).join(", ") || "yalnız BOM";
  return (
    <section className="card">
      <div className="row between">
        <h2 style={{ margin: 0 }}>Devir politikası</h2>
        {can("workflow.manage") && c && !f ? <button onClick={() => setF({ requireTestPlan: c.requireTestPlan, requireFirmware: c.requireFirmware, requireFirmwareSha: c.requireFirmwareSha, requireRouting: c.requireRouting, note: "" })}>Yeni sürüm</button> : null}
      </div>
      <ErrorNotice error={q.error} />
      {c ? <p style={{ margin: 0 }}>{c.versionNo ? <><b>v{c.versionNo}</b> · zorunlu: {flags(c)}</> : <span className="muted">{q.data.defaults}</span>} <span className="muted">· Yayımlanmış BOM her zaman zorunlu. Kontrol devre göndermede ve son devir onayında yapılır.</span></p> : null}
      {f ? (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <div className="row" style={{ flexWrap: "wrap" }}>
            {([["requireTestPlan", "Yayımlanmış test planı"], ["requireFirmware", "Firmware sürümü"], ["requireFirmwareSha", "Firmware SHA-256"], ["requireRouting", "Yayımlanmış rota"]] as const).map(([k, l]) => (
              <label key={k} className="row" style={{ gap: 6 }}><input type="checkbox" style={{ minHeight: 0 }} checked={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.checked, ...(k === "requireFirmware" && !e.target.checked ? { requireFirmwareSha: false } : {}) })} disabled={k === "requireFirmwareSha" && !f.requireFirmware} /> {l}</label>
            ))}
          </div>
          <label className="field">Gerekçe<input aria-label="Devir politikası gerekçesi" required minLength={3} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
          <div className="row"><button className="primary" disabled={save.isPending}>Yayımla</button><button type="button" onClick={() => setF(null)}>Vazgeç</button></div>
          <ErrorNotice error={save.error} />
        </form>
      ) : null}
      {save.data?.affectedInReview?.length ? (
        <div className="notice warn">Devir incelemesindeki {save.data.affectedInReview.length} revizyon yeni politikayı karşılamıyor; son onayda durdurulacak: {save.data.affectedInReview.map((x: any) => `${x.product} (${x.missing.map((m: string) => REQ_LABEL[m] ?? m).join(", ")})`).join("; ")}</div>
      ) : null}
      {q.data?.history.length ? (
        <details><summary>Sürüm geçmişi ({q.data.history.length})</summary>
          <table><tbody>{q.data.history.map((h: any) => <tr key={h.versionNo}><td>v{h.versionNo}</td><td>{flags(h)}</td><td>{h.note}</td><td className="muted">{h.createdBy} · {fmtDate(h.createdAt)}</td></tr>)}</tbody></table>
        </details>
      ) : null}
      {q.data?.waivers.length ? (
        <details><summary>Muafiyetler ({q.data.waivers.length})</summary>
          <table><tbody>{q.data.waivers.map((x: any) => <tr key={x.revisionId + x.requirement}><td className="mono">{x.productCode} Rev.{x.rev}</td><td>{REQ_LABEL[x.requirement]}</td><td>{x.reason}</td><td className="muted">{x.grantedBy} · {fmtDate(x.createdAt)}</td></tr>)}</tbody></table>
        </details>
      ) : null}
    </section>
  );
}

function DryRun() {
  const org = useQuery({ queryKey: ["org"], queryFn: () => get<any>("/api/org") });
  const [f, setF] = useState({ kind: "purchase_request", approverUserId: "", requesterUserId: "", amount: "", currency: "TRY" });
  const run = useMutation({ mutationFn: () => post<any>("/api/workflow/policies/dry-run", { ...f, requesterUserId: f.requesterUserId || undefined, amount: f.amount || undefined }) });
  const r = run.data;
  return (
    <section className="card">
      <h2>Kuru çalıştırma</h2>
      <form className="row" onSubmit={(e) => { e.preventDefault(); run.mutate(); }}>
        <label className="field">Tür<select aria-label="Denenecek tür" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{Object.entries(POLICY_KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label className="field">Onaycı<select aria-label="Onaycı" required value={f.approverUserId} onChange={(e) => setF({ ...f, approverUserId: e.target.value })}><option value="">Seçin</option>{org.data?.users.map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
        <label className="field">Talep eden<select aria-label="Talep eden" value={f.requesterUserId} onChange={(e) => setF({ ...f, requesterUserId: e.target.value })}><option value="">—</option>{org.data?.users.map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
        <label className="field" style={{ width: 120 }}>Tutar<input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></label>
        <button style={{ alignSelf: "flex-end" }}>Dene</button>
      </form>
      <ErrorNotice error={run.error} />
      {r ? (
        <div className={`notice ${r.allowed ? "" : "warn"}`}>
          <b>{r.allowed ? "Onaylayabilir" : "Onaylayamaz"}</b>{r.message ? ` — ${r.message}` : ""} · roller: {r.approverRoles.join(", ") || "—"} · politika {r.policyVersion ? `v${r.policyVersion}` : "varsayılan"}
          {r.escalateToRoles?.length ? ` · yükseltilecek: ${r.escalateToRoles.map((x: string) => ROLE[x] ?? x).join(", ")}` : ""} · kayıt yazılmadı
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------------------
export function DelegationsPage() {
  const can = useCan();
  const { me } = useMe();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["delegations"], queryFn: () => get<any>("/api/delegations") });
  const org = useQuery({ queryKey: ["org"], queryFn: () => get<any>("/api/org") });
  const act = useMutation({ mutationFn: (f: () => Promise<unknown>) => f(), onSuccess: () => qc.invalidateQueries({ queryKey: ["delegations"] }) });
  const inDays = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 16);
  const [f, setF] = useState({ delegatorUserId: "", delegateUserId: "", permissions: [] as string[], validFrom: inDays(0), validTo: inDays(7), reason: "" });
  const [revoke, setRevoke] = useState<Record<string, string>>({});
  const d = q.data;
  const options: string[] = f.delegatorUserId ? d?.delegable ?? [] : d?.mine ?? [];
  return (
    <>
      <PageHeader title="Vekâlet" sub="Süreli ve kapsamlı. Yalnızca vekâlet verenin sahip olduğu onay izinleri devredilir; vekâleten yapılan her işlem kimin adına yapıldığını kaydeder." />
      <Tabs />
      <section className="card">
        <h2>Yeni vekâlet</h2>
        <form className="stack" onSubmit={(e: FormEvent) => {
          e.preventDefault();
          act.mutate(() => post("/api/delegations", { ...f, delegatorUserId: f.delegatorUserId || undefined, validFrom: new Date(f.validFrom).toISOString(), validTo: new Date(f.validTo).toISOString() }));
        }}>
          <div className="row">
            {can("delegation.manage") ? (
              <label className="field">Vekâlet veren
                <select aria-label="Vekâlet veren" value={f.delegatorUserId} onChange={(e) => setF({ ...f, delegatorUserId: e.target.value, permissions: [] })}>
                  <option value="">Ben ({me?.user.name})</option>{org.data?.users.filter((u: any) => u.id !== me?.user.id).map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </label>
            ) : null}
            <label className="field">Vekil
              <select aria-label="Vekil" required value={f.delegateUserId} onChange={(e) => setF({ ...f, delegateUserId: e.target.value })}>
                <option value="">Seçin</option>{org.data?.users.filter((u: any) => u.id !== (f.delegatorUserId || me?.user.id)).map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </label>
            <label className="field">Başlangıç<input type="datetime-local" value={f.validFrom} onChange={(e) => setF({ ...f, validFrom: e.target.value })} /></label>
            <label className="field">Bitiş (en çok 90 gün)<input type="datetime-local" required value={f.validTo} onChange={(e) => setF({ ...f, validTo: e.target.value })} /></label>
          </div>
          <div className="row" style={{ flexWrap: "wrap" }}>
            {options.length === 0 ? <span className="muted">Devredilebilir onay izniniz yok.</span> : null}
            {options.map((p) => (
              <label key={p} className="row" style={{ gap: 6 }}>
                <input type="checkbox" style={{ minHeight: 0 }} checked={f.permissions.includes(p)} onChange={(e) => setF({ ...f, permissions: e.target.checked ? [...f.permissions, p] : f.permissions.filter((x) => x !== p) })} /> {PERM[p] ?? p}
              </label>
            ))}
          </div>
          <label className="field">Gerekçe<input required minLength={3} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="ör. Yıllık izin" /></label>
          <div className="row"><button className="primary" disabled={!f.permissions.length || act.isPending}>Vekâlet ver</button></div>
          <ErrorNotice error={act.error} />
        </form>
      </section>
      <section className="card">
        <h2>Vekâletler</h2>
        {q.isLoading ? <Loading /> : null}
        {d?.rows.length === 0 ? <Empty>Vekâlet kaydı yok.</Empty> : null}
        {d?.rows.length ? (
          <table>
            <thead><tr><th>Veren</th><th>Vekil</th><th>İzinler</th><th>Süre</th><th>Gerekçe</th><th>Durum</th><th /></tr></thead>
            <tbody>
              {d.rows.map((x: any) => (
                <tr key={x.id}>
                  <td>{x.delegatorName}</td><td>{x.delegateName}</td><td className="muted">{x.permissions.map((p: string) => PERM[p] ?? p).join(", ")}</td>
                  <td className="muted">{fmtDate(x.validFrom)} → {fmtDate(x.validTo)}</td><td>{x.reason}</td>
                  <td>{x.revokedAt ? <span className="badge">İptal</span> : x.active ? <span className="badge ok">Aktif</span> : <span className="badge">Aktif değil</span>}</td>
                  <td>{!x.revokedAt ? (
                    <div className="row">
                      <input aria-label="İptal gerekçesi" placeholder="Gerekçe" value={revoke[x.id] ?? ""} onChange={(e) => setRevoke({ ...revoke, [x.id]: e.target.value })} style={{ width: 140 }} />
                      <button disabled={(revoke[x.id] ?? "").length < 3} onClick={() => act.mutate(() => post(`/api/delegations/${x.id}/revoke`, { reason: revoke[x.id] }))}>İptal et</button>
                    </div>
                  ) : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------------------
export function WorkflowMonitorPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["wfOverview"], queryFn: () => get<any>("/api/workflow/overview") });
  const ob = useQuery({ queryKey: ["outbox"], queryFn: () => get<any[]>("/api/workflow/outbox") });
  const refresh = () => { qc.invalidateQueries({ queryKey: ["wfOverview"] }); qc.invalidateQueries({ queryKey: ["outbox"] }); };
  const act = useMutation({ mutationFn: (f: () => Promise<any>) => f(), onSuccess: refresh });
  const [note, setNote] = useState<Record<string, string>>({});
  const [role, setRole] = useState<Record<string, string>>({});
  const o = q.data;
  return (
    <>
      <PageHeader title="İzleme & müdahale" sub="Süresi geçen onaylar üst sorumluya bir kez yükseltilir (arka plan her dakika tarar). Aktarma ve kuyruk uzlaştırması gerekçeli ve kayıtlıdır." actions={<button onClick={() => act.mutate(() => post("/api/workflow/escalations/run"))}>Şimdi tara</button>} />
      <Tabs />
      <ErrorNotice error={act.error ?? q.error} />
      {act.data && "escalated" in act.data ? <div className="notice">{act.data.escalated} görev yükseltildi.</div> : null}
      <section className="card">
        <h2>Süresi geçen onaylar</h2>
        {o?.overdue.length === 0 ? <Empty>Süresi geçen onay yok.</Empty> : null}
        {o?.overdue.length ? (
          <table>
            <thead><tr><th>İş</th><th>Rol</th><th>Süre</th><th>Yükseltme</th><th>Aktar</th></tr></thead>
            <tbody>{o.overdue.map((t: any) => (
              <tr key={t.id}>
                <td>{t.title}</td><td><span className="badge">{ROLE[t.assigneeRole] ?? t.assigneeRole}</span></td><td className="muted">{fmtDate(t.dueAt)}</td>
                <td>{t.escalatedAt ? <span className="badge warn">yükseltildi {fmtDate(t.escalatedAt)}</span> : "—"}</td>
                <td>
                  <div className="row">
                    <select aria-label="Yeni rol" value={role[t.id] ?? ""} onChange={(e) => setRole({ ...role, [t.id]: e.target.value })}><option value="">Rol</option>{Object.entries(ROLE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                    <input aria-label="Aktarma gerekçesi" placeholder="Gerekçe" value={note[t.id] ?? ""} onChange={(e) => setNote({ ...note, [t.id]: e.target.value })} style={{ width: 140 }} />
                    <button disabled={!role[t.id] || (note[t.id] ?? "").length < 3} onClick={() => act.mutate(() => post(`/api/tasks/${t.id}/reassign`, { assigneeRole: role[t.id], reason: note[t.id] }))}>Aktar</button>
                  </div>
                </td>
              </tr>
            ))}</tbody>
          </table>
        ) : null}
      </section>
      <section className="card">
        <h2>Açık yükseltmeler</h2>
        {o?.escalations.length === 0 ? <Empty>Yok.</Empty> : null}
        <table><tbody>{o?.escalations.map((t: any) => <tr key={t.id}><td>{t.title}</td><td><span className="badge">{ROLE[t.assigneeRole] ?? t.assigneeRole}</span></td><td className="muted">{fmtDate(t.createdAt)}</td></tr>)}</tbody></table>
      </section>
      <section className="card">
        <h2>Çıkış kutusu (dış işlemler)</h2>
        <p className="muted" style={{ margin: 0 }}>Durum özeti: {o ? Object.entries(o.outbox).map(([k, v]) => `${k} ${v}`).join(" · ") || "boş" : "—"}. Sonucu bilinmeyen işlem tekrar gönderilmez; karşı sistemle uzlaştırılıp sonucu elle girilir.</p>
        {ob.data?.length ? (
          <table>
            <thead><tr><th>#</th><th>Konu</th><th>Durum</th><th className="num">Deneme</th><th>Hata / not</th><th /></tr></thead>
            <tbody>{ob.data.filter((x) => x.status !== "done" || x.resolutionNote).slice(0, 50).map((x) => (
              <tr key={x.id}>
                <td className="mono">{x.id}</td><td className="mono">{x.topic}</td><td><span className={`badge ${x.status === "failed" || x.status === "unknown" ? "bad" : ""}`}>{x.status}</span></td>
                <td className="num">{x.attempts}</td><td className="muted">{x.lastError ?? x.resolutionNote ?? ""}</td>
                <td>{["failed", "unknown"].includes(x.status) ? (
                  <div className="row">
                    <input aria-label="Not" placeholder="Not" value={note[x.id] ?? ""} onChange={(e) => setNote({ ...note, [x.id]: e.target.value })} style={{ width: 150 }} />
                    {x.status === "failed" ? <button disabled={(note[x.id] ?? "").length < 3} onClick={() => act.mutate(() => post(`/api/workflow/outbox/${x.id}/retry`, { reason: note[x.id] }))}>Tekrar dene</button> : null}
                    <button disabled={(note[x.id] ?? "").length < 3} onClick={() => act.mutate(() => post(`/api/workflow/outbox/${x.id}/resolve`, { outcome: "done", note: note[x.id] }))}>Gerçekleşti</button>
                    <button disabled={(note[x.id] ?? "").length < 3} onClick={() => act.mutate(() => post(`/api/workflow/outbox/${x.id}/resolve`, { outcome: "failed", note: note[x.id] }))}>Gerçekleşmedi</button>
                  </div>
                ) : null}</td>
              </tr>
            ))}</tbody>
          </table>
        ) : <Empty>Bekleyen veya sorunlu kayıt yok.</Empty>}
      </section>
      <p className="muted"><Link to="/events">İşlem geçmişi</Link> vekâleten yapılan işlemleri ve yükseltmeleri gösterir.</p>
    </>
  );
}
