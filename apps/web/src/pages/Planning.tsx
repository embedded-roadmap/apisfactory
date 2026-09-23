import { useMemo, useRef, useState, type FormEvent, type PointerEvent as RPointerEvent, type ReactElement } from "react";
import { Link, NavLink, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, post } from "../lib/api";
import { Empty, ErrorNotice, Loading, PageHeader, StateBadge, fmtDate, useCan } from "../lib/ui";
import { History } from "./Sales";
import { Discussion } from "../components/Discussion";

export const PRIORITY: Record<string, string> = { low: "Düşük", normal: "Normal", high: "Yüksek", critical: "Kritik" };
export const TASK_STATUS: Record<string, string> = { open: "Açık", in_progress: "Sürüyor", blocked: "Engelli", done: "Tamamlandı", cancelled: "İptal" };
const BLOCK: Record<string, string> = { supplier: "Tedarikçi", customer: "Müşteri", material: "Malzeme", equipment: "Ekipman", quality: "Kalite", other: "Diğer" };
const ENTITY_LINK: Record<string, (id: string) => string> = {
  sales_order: (id) => `/sales/${id}`, work_order: (id) => `/production/${id}`, change_request: (id) => `/changes/${id}`, rma: (id) => `/returns/${id}`,
  shipment: (id) => `/shipments/${id}`, product: (id) => `/products/${id}`,
};

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return iso(x); };
const diffDays = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);
const today = () => iso(new Date());

export function Tabs() {
  const can = useCan();
  return (
    <div className="row tabs" role="tablist">
      <NavLink to="/planning" end>Görevler</NavLink>
      <NavLink to="/planning/gantt">Gantt</NavLink>
      <NavLink to="/planning/meetings">Toplantılar</NavLink>
      <NavLink to="/planning/org">Organizasyon</NavLink>
      {can("team.report.view") ? <NavLink to="/planning/team">Ekip performansı</NavLink> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Görev listesi ve yeni görev
// ---------------------------------------------------------------------------------------
export function PlanningPage() {
  const can = useCan();
  const nav = useNavigate();
  const [filter, setFilter] = useState({ status: "active", assignee: "" });
  const q = useQuery({
    queryKey: ["plannedTasks", filter],
    queryFn: () => get<any[]>(`/api/tasks?kind=manual&status=${filter.status}${filter.assignee ? `&assignee=${filter.assignee}` : ""}`),
  });
  const [adding, setAdding] = useState(false);
  return (
    <>
      <PageHeader title="Görevler & plan" sub="Görevler ürün, sipariş, iş emri, değişiklik talebi veya iadeye bağlanabilir. Tarih değişikliği müşteri taahhüdünü değiştirmez." actions={can("task.manage") ? <button className="primary" onClick={() => setAdding(!adding)}>Yeni görev</button> : null} />
      <Tabs />
      {adding ? <NewTask onDone={(id) => nav(`/planning/tasks/${id}`)} /> : null}
      <section className="card">
        <div className="row">
          <label className="field">Durum
            <select value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })}>
              <option value="active">Açık / sürüyor / engelli</option><option value="done">Tamamlandı</option><option value="cancelled">İptal</option>
            </select>
          </label>
          <label className="field">Sorumlu
            <select value={filter.assignee} onChange={(e) => setFilter({ ...filter, assignee: e.target.value })}><option value="">Herkes</option><option value="me">Ben</option></select>
          </label>
        </div>
        {q.isLoading ? <Loading /> : <ErrorNotice error={q.error} />}
        {q.data?.length === 0 ? <Empty>Görev yok.</Empty> : null}
        {q.data?.length ? (
          <table>
            <thead><tr><th>Görev</th><th>Sorumlu</th><th>Öncelik</th><th>Başlangıç</th><th>Bitiş</th><th>Liste</th><th>Durum</th></tr></thead>
            <tbody>
              {q.data.map((t) => {
                const done = (t.checklist as any[]).filter((c) => c.done).length;
                return (
                  <tr key={t.id} className="click" onClick={() => nav(`/planning/tasks/${t.id}`)}>
                    <td>{t.milestone ? "◆ " : ""}{t.title}{t.departmentName ? <div className="muted">{t.departmentName}</div> : null}</td>
                    <td>{t.assigneeName ?? <span className="badge">{t.assigneeRole}</span>}</td>
                    <td>{PRIORITY[t.priority]}</td><td>{t.startDate ?? "—"}</td>
                    <td>{t.dueDate ?? "—"} {t.overdue ? <span className="badge bad">gecikti</span> : null}</td>
                    <td className="muted">{t.checklist.length ? `${done}/${t.checklist.length}` : "—"}</td>
                    <td><StateBadge value={t.status} prefix="task" />{t.blockedCategory && t.status === "blocked" ? <div className="muted">{BLOCK[t.blockedCategory]}</div> : null}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}
      </section>
    </>
  );
}

function NewTask({ onDone }: { onDone: (id: string) => void }) {
  const org = useQuery({ queryKey: ["org"], queryFn: () => get<any>("/api/org") });
  const open = useQuery({ queryKey: ["plannedTasks", "deps"], queryFn: () => get<any[]>("/api/tasks?kind=manual&status=active") });
  const [f, setF] = useState({ title: "", description: "", assigneeUserId: "", departmentId: "", priority: "normal", startDate: today(), dueDate: addDays(today(), 3), milestone: false, checklist: "", dependsOn: "" });
  const save = useMutation({
    mutationFn: () => post<any>("/api/tasks", {
      title: f.title, description: f.description || undefined, assigneeUserId: f.assigneeUserId || undefined, departmentId: f.departmentId || undefined,
      priority: f.priority, startDate: f.milestone ? f.dueDate : f.startDate || undefined, dueDate: f.dueDate || undefined, milestone: f.milestone,
      checklist: f.checklist.split("\n").map((s) => s.trim()).filter(Boolean), dependsOn: f.dependsOn ? [{ taskId: f.dependsOn, lagDays: 0 }] : [],
    }),
    onSuccess: (t) => onDone(t.id),
  });
  return (
    <section className="card">
      <h2>Yeni görev</h2>
      <form className="stack" onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <div className="row">
          <label className="field" style={{ flex: 2 }}>Başlık<input required minLength={3} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
          <label className="field">Sorumlu
            <select required value={f.assigneeUserId} onChange={(e) => setF({ ...f, assigneeUserId: e.target.value })}>
              <option value="">Seçin</option>{org.data?.users.map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </label>
          <label className="field">Departman
            <select value={f.departmentId} onChange={(e) => setF({ ...f, departmentId: e.target.value })}>
              <option value="">—</option>{org.data?.departments.filter((d: any) => d.active).map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </label>
          <label className="field">Öncelik<select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>{Object.entries(PRIORITY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        </div>
        <div className="row">
          {!f.milestone ? <label className="field">Başlangıç<input type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} /></label> : null}
          <label className="field">{f.milestone ? "Tarih" : "Bitiş"}<input type="date" required value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} /></label>
          <label className="row" style={{ gap: 6, alignSelf: "flex-end" }}><input type="checkbox" style={{ minHeight: 0 }} checked={f.milestone} onChange={(e) => setF({ ...f, milestone: e.target.checked })} /> Kilometre taşı</label>
          <label className="field" style={{ flex: 1 }}>Öncül görev
            <select value={f.dependsOn} onChange={(e) => setF({ ...f, dependsOn: e.target.value })}><option value="">—</option>{open.data?.map((t) => <option key={t.id} value={t.id}>{t.title} ({t.dueDate ?? "tarihsiz"})</option>)}</select>
          </label>
        </div>
        <label className="field">Kontrol listesi (her satır bir madde)<textarea rows={3} value={f.checklist} onChange={(e) => setF({ ...f, checklist: e.target.value })} /></label>
        <label className="field">Açıklama<textarea rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
        <div className="row"><button className="primary" disabled={save.isPending}>Kaydet</button></div>
        <ErrorNotice error={save.error} />
      </form>
    </section>
  );
}

// ---------------------------------------------------------------------------------------
// Görev ayrıntısı
// ---------------------------------------------------------------------------------------
export function TaskPage() {
  const { id } = useParams();
  const can = useCan();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["task", id], queryFn: () => get<any>(`/api/tasks/${id}`) });
  const all = useQuery({ queryKey: ["plannedTasks", "deps"], queryFn: () => get<any[]>("/api/tasks?kind=manual&status=active") });
  const refresh = () => { qc.invalidateQueries({ queryKey: ["task", id] }); qc.invalidateQueries({ queryKey: ["history"] }); qc.invalidateQueries({ queryKey: ["plannedTasks"] }); };
  const act = useMutation({ mutationFn: (f: () => Promise<any>) => f(), onSuccess: refresh });
  const [block, setBlock] = useState({ category: "supplier", reason: "" });
  const [dates, setDates] = useState<{ startDate: string; dueDate: string; reason: string } | null>(null);
  const [dep, setDep] = useState("");
  const [cancel, setCancel] = useState("");
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNotice error={q.error} />;
  const t = q.data;
  const active = ["open", "in_progress", "blocked"].includes(t.status);
  const manual = t.kind === "manual";
  const impact = (act.data as any)?.impact ?? t.impact;
  return (
    <>
      <PageHeader
        title={`${t.milestone ? "◆ " : ""}${t.title}`}
        sub={<>{t.assigneeName ?? t.assigneeRole} · {PRIORITY[t.priority]} öncelik{t.departmentName ? ` · ${t.departmentName}` : ""}{ENTITY_LINK[t.entityType] ? <> · <Link to={ENTITY_LINK[t.entityType]!(t.entityId)}>bağlı kayıt</Link></> : null} · <Link to="/planning">← Görevler</Link></>}
        actions={<StateBadge value={t.status} prefix="task" />}
      />
      <ErrorNotice error={act.error} />
      <section className="card">
        <div className="grid4">
          <div className="stat"><small>Plan</small><b style={{ fontSize: 15 }}>{t.startDate ?? "—"} → {t.dueDate ?? "—"}</b><small>{t.baselineDue ? `baz: ${t.baselineStart ?? "—"} → ${t.baselineDue}` : "baz plan yok"}</small></div>
          <div className="stat"><small>Gerçekleşen</small><b style={{ fontSize: 15 }}>{fmtDate(t.startedAt)}</b><small>{t.closedAt ? `kapanış ${fmtDate(t.closedAt)}` : ""}</small></div>
          <div className="stat"><small>Engel</small><b style={{ fontSize: 15 }}>{t.blockedCategory ? BLOCK[t.blockedCategory] : "—"}</b><small>{t.blockedReason ?? ""}{t.externalDelay ? " · dış kaynaklı" : ""}</small></div>
          <div className="stat"><small>Açan</small><b style={{ fontSize: 15 }}>{t.createdBy ?? "sistem"}</b><small>{fmtDate(t.createdAt)}</small></div>
        </div>
        {t.description ? <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{t.description}</p> : null}
        {!manual ? <div className="notice">Sistem görevi: ilgili işlem tamamlanınca kendiliğinden kapanır.</div> : null}
      </section>

      {impact && (impact.successors.length || impact.commitments.length) ? (
        <section className="card">
          <h2>Gecikme etkisi</h2>
          {impact.successors.map((s: any) => <div key={s.id} className="notice warn">Ardıl görev <Link to={`/planning/tasks/${s.id}`}>{s.title}</Link> en erken {s.requiredStart} başlayabilir (planı {s.startDate}, {s.daysLate} gün çakışma).</div>)}
          {impact.commitments.map((c: any) => <div key={c.salesOrderId} className="notice bad">Sipariş <Link to={`/sales/${c.salesOrderId}`}>{c.code}</Link> müşteri taahhüdü {c.promisedDate}; görev bitişi {c.taskDue} ({c.daysLate} gün sonra). {impact.note}</div>)}
        </section>
      ) : null}

      {t.checklist.length ? (
        <section className="card">
          <h2>Kontrol listesi</h2>
          {t.checklist.map((c: any, i: number) => (
            <label key={i} className="row" style={{ gap: 8 }}>
              <input type="checkbox" style={{ minHeight: 0 }} checked={c.done} disabled={!active || !manual} onChange={(e) => { const done = e.target.checked; act.mutate(() => post(`/api/tasks/${id}/checklist`, { index: i, done })); }} />
              <span style={c.done ? { textDecoration: "line-through", color: "var(--muted)" } : undefined}>{c.text}</span>
            </label>
          ))}
        </section>
      ) : null}

      {manual && active ? (
        <section className="card">
          <h2>İlerleme</h2>
          <div className="row">
            {t.status !== "in_progress" ? <button onClick={() => act.mutate(() => post(`/api/tasks/${id}/status`, { status: "in_progress" }))}>Başladım / devam</button> : null}
            <button className="primary" onClick={() => act.mutate(() => post(`/api/tasks/${id}/status`, { status: "done" }))}>Tamamlandı</button>
          </div>
          {t.status !== "blocked" ? (
            <form className="row" onSubmit={(e) => { e.preventDefault(); act.mutate(() => post(`/api/tasks/${id}/status`, { status: "blocked", blockedCategory: block.category, reason: block.reason })); }}>
              <label className="field">Engel<select value={block.category} onChange={(e) => setBlock({ ...block, category: e.target.value })}>{Object.entries(BLOCK).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
              <label className="field" style={{ flex: 1 }}>Açıklama<input required minLength={3} value={block.reason} onChange={(e) => setBlock({ ...block, reason: e.target.value })} /></label>
              <button style={{ alignSelf: "flex-end" }}>Engel bildir</button>
            </form>
          ) : null}
          <p className="muted" style={{ margin: 0 }}>Tedarikçi veya müşteri kaynaklı engel dış gecikme sayılır; kişinin zamanında tamamlama oranına yazılmaz.</p>
        </section>
      ) : null}

      <section className="card">
        <h2>Bağımlılıklar</h2>
        <table><tbody>
          {t.predecessors.map((p: any) => <tr key={p.id}><td>Öncül</td><td><Link to={`/planning/tasks/${p.id}`}>{p.title}</Link></td><td><StateBadge value={p.status} prefix="task" /></td><td className="muted">bitiş {p.dueDate ?? "—"}{p.lagDays ? ` +${p.lagDays} gün` : ""}</td>
            <td>{can("task.manage") && active ? <button onClick={() => act.mutate(() => post(`/api/tasks/${id}/dependencies`, { dependsOn: p.id, remove: true }))}>Kaldır</button> : null}</td></tr>)}
          {t.successors.map((s: any) => <tr key={s.id}><td>Ardıl</td><td><Link to={`/planning/tasks/${s.id}`}>{s.title}</Link></td><td><StateBadge value={s.status} prefix="task" /></td><td className="muted">başlangıç {s.startDate ?? "—"}</td><td /></tr>)}
        </tbody></table>
        {!t.predecessors.length && !t.successors.length ? <Empty>Bağımlılık yok.</Empty> : null}
        {can("task.manage") && active && manual ? (
          <div className="row">
            <select aria-label="Öncül ekle" value={dep} onChange={(e) => setDep(e.target.value)}><option value="">Öncül görev seçin</option>{all.data?.filter((x) => x.id !== t.id).map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}</select>
            <button disabled={!dep} onClick={() => act.mutate(() => post(`/api/tasks/${id}/dependencies`, { dependsOn: dep }))}>Öncül ekle</button>
          </div>
        ) : null}
      </section>

      {can("task.manage") && active && manual ? (
        <section className="card">
          <h2>Plan değişikliği</h2>
          {!dates ? <button onClick={() => setDates({ startDate: t.startDate ?? "", dueDate: t.dueDate ?? "", reason: "" })}>Tarihleri değiştir</button> : (
            <form className="row" onSubmit={(e) => { e.preventDefault(); act.mutate(() => post(`/api/tasks/${id}/update`, { startDate: dates.startDate || null, dueDate: dates.dueDate || null, reason: dates.reason || undefined })); setDates(null); }}>
              <label className="field">Başlangıç<input type="date" value={dates.startDate} onChange={(e) => setDates({ ...dates, startDate: e.target.value })} /></label>
              <label className="field">Bitiş<input type="date" value={dates.dueDate} onChange={(e) => setDates({ ...dates, dueDate: e.target.value })} /></label>
              <label className="field" style={{ flex: 1 }}>Gerekçe{t.baselineDue ? " (baz plan var: zorunlu)" : ""}<input value={dates.reason} onChange={(e) => setDates({ ...dates, reason: e.target.value })} /></label>
              <button className="primary" style={{ alignSelf: "flex-end" }}>Kaydet</button>
              <button type="button" style={{ alignSelf: "flex-end" }} onClick={() => setDates(null)}>Vazgeç</button>
            </form>
          )}
          <div className="row">
            <input aria-label="İptal gerekçesi" placeholder="İptal gerekçesi" value={cancel} onChange={(e) => setCancel(e.target.value)} style={{ flex: 1 }} />
            <button className="danger" disabled={cancel.length < 3} onClick={() => act.mutate(() => post(`/api/tasks/${id}/cancel`, { reason: cancel }))}>Görevi iptal et</button>
          </div>
        </section>
      ) : null}
      <Discussion entityType="task" entityId={t.id} />
      <History entityType="task" id={t.id} />
    </>
  );
}

// ---------------------------------------------------------------------------------------
// Gantt: görev ve iş emri verisinden; sürükleyerek tarih (yetkiyle), gecikme etkisi
// ---------------------------------------------------------------------------------------
const DAY = 30;
const ROW = 34;
const LABEL = 260;
const HEAD = 44;

export function GanttPage() {
  const can = useCan();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [from, setFrom] = useState(addDays(today(), -7));
  const [span, setSpan] = useState(42);
  const to = addDays(from, span - 1);
  const q = useQuery({ queryKey: ["gantt", from, to], queryFn: () => get<any>(`/api/gantt?from=${from}&to=${to}`) });
  const [drag, setDrag] = useState<{ id: string; mode: "move" | "end"; x0: number; dx: number } | null>(null);
  const [pending, setPending] = useState<{ id: string; title: string; startDate: string | null; dueDate: string; baseline: boolean } | null>(null);
  const [reason, setReason] = useState("");
  const save = useMutation({
    mutationFn: (p: NonNullable<typeof pending>) => post<any>(`/api/tasks/${p.id}/update`, { startDate: p.startDate, dueDate: p.dueDate, reason: reason || undefined }),
    onSuccess: () => { setPending(null); setReason(""); qc.invalidateQueries({ queryKey: ["gantt"] }); },
  });
  const svgRef = useRef<SVGSVGElement>(null);
  const g = q.data;
  const days = useMemo(() => Array.from({ length: span }, (_, i) => addDays(from, i)), [from, span]);
  const holidays = new Set<string>((g?.holidays ?? []).map((h: any) => h.day));
  const rows: any[] = g ? [...g.tasks.map((t: any) => ({ ...t, type: "task" })), ...g.workOrders.map((w: any) => ({ ...w, type: "wo", title: `${w.code} · ${w.productCode}` }))] : [];
  const rowIndex = new Map(rows.map((r, i) => [r.id, i]));
  const x = (d: string) => LABEL + diffDays(d, from) * DAY;
  const width = LABEL + span * DAY;
  const height = HEAD + Math.max(rows.length, 1) * ROW + 8;
  const conflictKey = new Set((g?.conflicts ?? []).map((c: any) => `${c.dependsOn}>${c.taskId}`));
  const editable = can("task.manage");

  function onDown(e: RPointerEvent, t: any, mode: "move" | "end") {
    if (!editable || !["open", "in_progress", "blocked"].includes(t.status)) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    setDrag({ id: t.id, mode, x0: e.clientX, dx: 0 });
  }
  function onMove(e: RPointerEvent) { if (drag) setDrag({ ...drag, dx: e.clientX - drag.x0 }); }
  function onUp(t: any) {
    if (!drag) return;
    const shift = Math.round(drag.dx / DAY);
    setDrag(null);
    if (!shift) return;
    const start = t.startDate ?? t.dueDate;
    setPending({
      id: t.id, title: t.title, baseline: !!t.baselineDue,
      startDate: drag.mode === "move" ? addDays(start, shift) : start,
      dueDate: t.milestone ? addDays(t.dueDate, shift) : drag.mode === "move" ? addDays(t.dueDate, shift) : addDays(t.dueDate, Math.max(shift, diffDays(start, t.dueDate))),
    });
  }

  return (
    <>
      <PageHeader title="Gantt" sub="Görev ve iş emri verisinden üretilir. Sürükleme yetkiye tabidir; tarih değişikliği kaydedilmeden önce onay ister, müşteri taahhüdü değişmez." />
      <Tabs />
      <section className="card">
        <div className="row">
          <button onClick={() => setFrom(addDays(from, -7))} aria-label="Bir hafta geri">←</button>
          <label className="field">Başlangıç<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <button onClick={() => setFrom(addDays(from, 7))} aria-label="Bir hafta ileri">→</button>
          <label className="field">Aralık<select value={span} onChange={(e) => setSpan(Number(e.target.value))}><option value={28}>4 hafta</option><option value={42}>6 hafta</option><option value={84}>12 hafta</option></select></label>
          {editable ? <button style={{ alignSelf: "flex-end" }} onClick={() => post("/api/tasks/baseline", { note: `Gantt'tan baz plan (${today()})` }).then(() => qc.invalidateQueries({ queryKey: ["gantt"] }))}>Baz planı dondur</button> : null}
        </div>
        <div className="legend row">
          <span><i className="lg bar" /> Görev</span><span><i className="lg base" /> Baz plan</span><span><i className="lg wo" /> İş emri</span>
          <span>◆ Kilometre taşı</span><span><i className="lg late" /> Gecikmiş / çakışma</span><span><i className="lg off" /> Hafta sonu / tatil</span>
        </div>
        {q.isLoading ? <Loading /> : <ErrorNotice error={q.error} />}
        {pending ? (
          <div className="notice warn">
            <b>{pending.title}</b>: {pending.startDate ?? "—"} → {pending.dueDate}
            <div className="row">
              <input aria-label="Gerekçe" placeholder={pending.baseline ? "Gerekçe (baz plan var: zorunlu)" : "Gerekçe"} value={reason} onChange={(e) => setReason(e.target.value)} style={{ flex: 1 }} />
              <button className="primary" onClick={() => save.mutate(pending)}>Kaydet</button>
              <button onClick={() => setPending(null)}>Vazgeç</button>
            </div>
            <ErrorNotice error={save.error} />
          </div>
        ) : null}
        {save.data?.impact && (save.data.impact.successors.length || save.data.impact.commitments.length) ? (
          <div className="notice bad">
            {save.data.impact.successors.map((s: any) => <div key={s.id}>Ardıl "{s.title}" {s.daysLate} gün çakışıyor (en erken {s.requiredStart}).</div>)}
            {save.data.impact.commitments.map((c: any) => <div key={c.salesOrderId}>Sipariş {c.code}: taahhüt {c.promisedDate}, görev bitişi {c.taskDue} ({c.daysLate} gün). {save.data.impact.note}</div>)}
          </div>
        ) : null}
        {g ? (
          <div className="gantt-wrap">
            <svg ref={svgRef} width={width} height={height} role="img" aria-label="Gantt şeması" className="gantt" onPointerMove={onMove}>
              {days.map((d, i) => {
                const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
                const off = wd === 0 || wd === 6 || holidays.has(d);
                return (
                  <g key={d}>
                    {off ? <rect x={LABEL + i * DAY} y={HEAD} width={DAY} height={height - HEAD} className="g-off"><title>{holidays.has(d) ? g.holidays.find((h: any) => h.day === d).name : "Hafta sonu"}</title></rect> : null}
                    <line x1={LABEL + i * DAY} x2={LABEL + i * DAY} y1={HEAD - 14} y2={height} className="g-grid" />
                    {d.endsWith("-01") || i === 0 ? <text x={LABEL + i * DAY + 3} y={16} className="g-month">{d.slice(5, 7)}/{d.slice(0, 4)}</text> : null}
                    <text x={LABEL + i * DAY + DAY / 2} y={HEAD - 6} textAnchor="middle" className="g-day">{Number(d.slice(8))}</text>
                  </g>
                );
              })}
              {g.today >= from && g.today <= to ? <line x1={x(g.today) + DAY / 2} x2={x(g.today) + DAY / 2} y1={HEAD - 14} y2={height} className="g-today" /> : null}
              {g.dependencies.map((d: any) => {
                const a = rows[rowIndex.get(d.dependsOn) ?? -1];
                const b = rows[rowIndex.get(d.taskId) ?? -1];
                if (!a || !b) return null;
                const ax = x(a.dueDate) + DAY;
                const ay = HEAD + rowIndex.get(a.id)! * ROW + ROW / 2;
                const bx = x(b.startDate ?? b.dueDate);
                const by = HEAD + rowIndex.get(b.id)! * ROW + ROW / 2;
                const bad = conflictKey.has(`${d.dependsOn}>${d.taskId}`);
                return <path key={d.dependsOn + d.taskId} d={`M${ax},${ay} h8 V${by} H${bx - 2}`} className={bad ? "g-dep late" : "g-dep"} markerEnd="url(#arrow)" />;
              })}
              <defs><marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L8,4 L0,8 z" className="g-arrow" /></marker></defs>
              {rows.map((r, i) => {
                const y = HEAD + i * ROW;
                const dx = drag && drag.id === r.id ? drag.dx : 0;
                const start = r.startDate ?? r.dueDate;
                const x1 = x(start) + (drag && drag.id === r.id && drag.mode === "end" ? 0 : dx);
                const x2 = x(r.dueDate) + DAY + dx;
                const late = r.type === "task" ? r.overdue : r.promisedDate && r.dueDate > r.promisedDate;
                return (
                  <g key={r.id}>
                    <text x={8} y={y + ROW / 2 + 4} className="g-label" onClick={() => nav(r.type === "task" ? `/planning/tasks/${r.id}` : `/production/${r.id}`)} style={{ cursor: "pointer" }}>
                      {(r.milestone ? "◆ " : "") + (r.title.length > 30 ? r.title.slice(0, 29) + "…" : r.title)}
                    </text>
                    {r.type === "task" && r.baselineDue ? <rect x={x(r.baselineStart ?? r.baselineDue)} y={y + ROW - 9} width={x(r.baselineDue) + DAY - x(r.baselineStart ?? r.baselineDue)} height={3} rx={1.5} className="g-base" /> : null}
                    {r.milestone ? (
                      <path d={`M${x(r.dueDate) + DAY / 2 + dx},${y + 7} l9,10 l-9,10 l-9,-10 z`} className={late ? "g-ms late" : "g-ms"} onPointerDown={(e) => onDown(e, r, "move")} onPointerUp={() => onUp(r)}>
                        <title>{`${r.title}\n${r.dueDate}${late ? " · gecikti" : ""}`}</title>
                      </path>
                    ) : (
                      <>
                        <rect x={x1} y={y + 8} width={Math.max(x2 - x1, 6)} height={ROW - 18} rx={4}
                          className={`${r.type === "wo" ? "g-wo" : "g-bar"} ${late ? "late" : ""} ${r.status === "done" || r.status === "completed" ? "done" : ""} ${editable && r.type === "task" ? "drag" : ""}`}
                          onPointerDown={(e) => r.type === "task" && onDown(e, r, "move")} onPointerUp={() => onUp(r)}>
                          <title>{`${r.title}\n${start} → ${r.dueDate}${r.type === "task" ? `\n${TASK_STATUS[r.status]}${r.assigneeName ? ` · ${r.assigneeName}` : ""}${r.slipDays ? `\nbaz plana göre ${r.slipDays > 0 ? "+" : ""}${r.slipDays} gün` : ""}` : `\n${r.status}${r.promisedDate ? ` · taahhüt ${r.promisedDate}` : ""}`}${late ? "\ngecikti" : ""}`}</title>
                        </rect>
                        {r.type === "task" && editable && ["open", "in_progress", "blocked"].includes(r.status) ? (
                          <rect x={x2 - 6} y={y + 8} width={6} height={ROW - 18} className="g-handle" onPointerDown={(e) => onDown(e, r, "end")} onPointerUp={() => onUp(r)}><title>Bitişi sürükle</title></rect>
                        ) : null}
                        {r.type === "task" && r.actualEnd ? <line x1={x(r.actualEnd) + DAY / 2} x2={x(r.actualEnd) + DAY / 2} y1={y + 5} y2={y + ROW - 5} className="g-actual" /> : null}
                      </>
                    )}
                  </g>
                );
              })}
            </svg>
          </div>
        ) : null}
        {g && rows.length === 0 ? <Empty>Bu aralıkta tarihli görev veya iş emri yok.</Empty> : null}
        {g?.conflicts.length ? <div className="notice bad">{g.conflicts.length} bağımlılık çakışması: ardıl görev öncül bitmeden başlıyor.</div> : null}
        <details><summary className="muted">Tablo görünümü</summary>
          <table><thead><tr><th>Kayıt</th><th>Başlangıç</th><th>Bitiş</th><th>Baz bitiş</th><th>Durum</th></tr></thead>
            <tbody>{rows.map((r) => <tr key={r.id}><td>{r.title}</td><td>{r.startDate ?? "—"}</td><td>{r.dueDate}</td><td>{r.baselineDue ?? "—"}</td><td>{r.type === "task" ? TASK_STATUS[r.status] : r.status}</td></tr>)}</tbody>
          </table>
        </details>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------------------
// Organizasyon şeması
// ---------------------------------------------------------------------------------------
export function OrgPage() {
  const can = useCan();
  const qc = useQueryClient();
  const [date, setDate] = useState(today());
  const q = useQuery({ queryKey: ["org", date], queryFn: () => get<any>(`/api/org?date=${date}`) });
  const act = useMutation({ mutationFn: (f: () => Promise<unknown>) => f(), onSuccess: () => qc.invalidateQueries({ queryKey: ["org"] }) });
  const [nd, setNd] = useState({ code: "", name: "", parentId: "" });
  const [nm, setNm] = useState({ departmentId: "", userId: "", isManager: false, temporary: false, validTo: "", note: "" });
  const [endId, setEndId] = useState<string | null>(null);
  const o = q.data;
  const children = (pid: string | null) => (o?.departments ?? []).filter((d: any) => (d.parentId ?? null) === pid && d.active);
  const Node = ({ d, depth }: { d: any; depth: number }): ReactElement => (
    <li>
      <div className="org-node">
        <b>{d.name}</b> <span className="muted mono">{d.code}</span>
        <div className="org-people">
          {d.members.length === 0 ? <span className="muted">üye yok</span> : null}
          {d.members.map((m: any) => (
            <span key={m.id} className={`badge ${m.isManager ? "ok" : ""}`} title={`${m.validFrom} → ${m.validTo ?? "…"}${m.note ? ` · ${m.note}` : ""}`}>
              {m.isManager ? "Yönetici: " : ""}{m.name}{m.temporary ? ` (geçici → ${m.validTo})` : ""}
              {can("org.manage") && date === today() ? (
                <button className="mini" aria-label={`${m.name} üyeliğini bitir`} onClick={() => setEndId(endId === m.id ? null : m.id)}>×</button>
              ) : null}
              {endId === m.id ? (
                <input aria-label="Bitirme gerekçesi" placeholder="Gerekçe + Enter" autoFocus style={{ width: 160, minHeight: 28 }}
                  onKeyDown={(e) => { if (e.key === "Enter") { act.mutate(() => post(`/api/department-members/${m.id}/end`, { validTo: today(), reason: (e.target as HTMLInputElement).value })); setEndId(null); } }} />
              ) : null}
            </span>
          ))}
        </div>
      </div>
      {children(d.id).length ? <ul>{children(d.id).map((c: any) => <Node key={c.id} d={c} depth={depth + 1} />)}</ul> : null}
    </li>
  );
  return (
    <>
      <PageHeader title="Organizasyon" sub="Şema raporlama ilişkisini gösterir; veri erişim yetkisi rollerden gelir. Tarih seçerek geçmiş yapıyı görebilirsiniz." />
      <Tabs />
      <section className="card">
        <div className="row"><label className="field">Tarih<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label></div>
        {q.isLoading ? <Loading /> : <ErrorNotice error={q.error ?? act.error} />}
        {o ? <ul className="org">{children(null).map((d: any) => <Node key={d.id} d={d} depth={0} />)}</ul> : null}
      </section>
      {can("org.manage") && o ? (
        <section className="card">
          <h2>Düzenle</h2>
          <form className="row" onSubmit={(e) => { e.preventDefault(); act.mutate(() => post("/api/departments", { code: nd.code, name: nd.name, parentId: nd.parentId || undefined })); setNd({ code: "", name: "", parentId: "" }); }}>
            <label className="field" style={{ width: 110 }}>Kod<input required minLength={2} value={nd.code} onChange={(e) => setNd({ ...nd, code: e.target.value.toUpperCase() })} /></label>
            <label className="field" style={{ flex: 1 }}>Departman / ekip adı<input required minLength={2} value={nd.name} onChange={(e) => setNd({ ...nd, name: e.target.value })} /></label>
            <label className="field">Üst birim<select aria-label="Üst birim" value={nd.parentId} onChange={(e) => setNd({ ...nd, parentId: e.target.value })}><option value="">— (en üst)</option>{o.departments.filter((d: any) => d.active).map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
            <button style={{ alignSelf: "flex-end" }}>Birim ekle</button>
          </form>
          <form className="row" onSubmit={(e) => { e.preventDefault(); act.mutate(() => post(`/api/departments/${nm.departmentId}/members`, { userId: nm.userId, isManager: nm.isManager, temporary: nm.temporary, validTo: nm.validTo || undefined, note: nm.note || undefined })); }}>
            <label className="field">Birim<select aria-label="Üye birimi" required value={nm.departmentId} onChange={(e) => setNm({ ...nm, departmentId: e.target.value })}><option value="">Seçin</option>{o.departments.filter((d: any) => d.active).map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
            <label className="field">Kişi<select aria-label="Üye kişi" required value={nm.userId} onChange={(e) => setNm({ ...nm, userId: e.target.value })}><option value="">Seçin</option>{o.users.map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
            <label className="row" style={{ gap: 6, alignSelf: "flex-end" }}><input type="checkbox" style={{ minHeight: 0 }} checked={nm.isManager} onChange={(e) => setNm({ ...nm, isManager: e.target.checked })} /> Yönetici</label>
            <label className="row" style={{ gap: 6, alignSelf: "flex-end" }}><input type="checkbox" style={{ minHeight: 0 }} checked={nm.temporary} onChange={(e) => setNm({ ...nm, temporary: e.target.checked })} /> Geçici</label>
            {nm.temporary ? <label className="field">Bitiş<input type="date" required value={nm.validTo} onChange={(e) => setNm({ ...nm, validTo: e.target.value })} /></label> : null}
            <label className="field" style={{ flex: 1 }}>Not<input value={nm.note} onChange={(e) => setNm({ ...nm, note: e.target.value })} /></label>
            <button className="primary" style={{ alignSelf: "flex-end" }}>Üye ekle</button>
          </form>
        </section>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------------------
// Ekip performansı
// ---------------------------------------------------------------------------------------
export function TeamReportPage() {
  const [from, setFrom] = useState(addDays(today(), -27));
  const [to, setTo] = useState(today());
  const [period, setPeriod] = useState("week");
  const q = useQuery({ queryKey: ["teamReport", from, to, period], queryFn: () => get<any>(`/api/reports/team?from=${from}&to=${to}&period=${period}`) });
  const r = q.data;
  const pct = (v: number | null) => (v === null ? "—" : `%${(v * 100).toLocaleString("tr-TR", { maximumFractionDigits: 1 })}`);
  return (
    <>
      <PageHeader title="Ekip performansı" sub="Tanımlar sayfada yazılıdır. Tek bir verimlilik puanı yoktur; dış kaynaklı gecikme kişiye yazılmaz." />
      <Tabs />
      <section className="card">
        <div className="row">
          <label className="field">Başlangıç<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="field">Bitiş<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          <label className="field">Dönem<select value={period} onChange={(e) => setPeriod(e.target.value)}><option value="week">Haftalık</option><option value="month">Aylık</option></select></label>
        </div>
        {q.isLoading ? <Loading /> : <ErrorNotice error={q.error} />}
        {r ? (
          <>
            <table>
              <thead><tr><th>Kişi</th><th>Birim</th><th className="num">Kapanan görev</th><th className="num">Zamanında</th><th className="num">İç gecikme</th><th className="num">Dış gecikme (hariç)</th><th className="num">Zamanında oranı</th><th className="num">Süresi geçmiş açık</th><th className="num">Operasyon</th><th className="num">Test kaydı</th></tr></thead>
              <tbody>{r.rows.map((x: any) => (
                <tr key={x.userId}><td>{x.name}</td><td className="muted">{x.departments ?? "—"}</td><td className="num">{x.tasksClosed}</td><td className="num">{x.onTime}</td><td className="num">{x.lateInternal}</td>
                  <td className="num">{x.lateExternal}{x.blockedExternal ? <div className="muted">{x.blockedExternal} dış engelli açık</div> : null}</td><td className="num"><b>{pct(x.onTimeRate)}</b></td>
                  <td className="num">{x.overdueOpen}</td><td className="num">{x.operationsCompleted}</td><td className="num">{x.testsRecorded}</td></tr>
              ))}</tbody>
            </table>
            <h3>{period === "week" ? "Haftalık" : "Aylık"} şirket geneli</h3>
            {r.buckets.length === 0 ? <Empty>Dönemde kapanan görev yok.</Empty> : (
              <table><thead><tr><th>Dönem başı</th><th className="num">Kapanan</th><th className="num">Zamanında</th><th className="num">İç gecikme</th><th className="num">Dış gecikme</th></tr></thead>
                <tbody>{r.buckets.map((b: any) => <tr key={b.period}><td>{b.period}</td><td className="num">{b.closed}</td><td className="num">{b.on_time}</td><td className="num">{b.late_internal}</td><td className="num">{b.late_external}</td></tr>)}</tbody></table>
            )}
            <div className="notice"><ul style={{ margin: 0 }}>{Object.entries(r.definitions).map(([k, v]) => <li key={k}>{String(v)}</li>)}{r.notes.map((n: string) => <li key={n}>{n}</li>)}</ul></div>
          </>
        ) : null}
      </section>
    </>
  );
}
