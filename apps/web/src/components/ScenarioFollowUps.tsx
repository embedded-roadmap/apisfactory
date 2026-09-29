import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, post } from "../lib/api";
import { Empty, ErrorNotice, StateBadge, useCan } from "../lib/ui";

const ROLES: [string, string][] = [["production", "Üretim"], ["rd", "Ar-Ge"], ["purchasing", "Satın alma"], ["quality", "Kalite"], ["sales", "Satış"], ["manager", "Yönetici"]];

/** R42 — senaryodan görev veya değişiklik talebi; bağlı kayıtlar senaryoda izlenir. */
export function ScenarioFollowUps({ id }: { id: string }) {
  const can = useCan();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["scenario", id], queryFn: () => get<any>(`/api/scenarios/${id}`) });
  const refresh = () => qc.invalidateQueries({ queryKey: ["scenario", id] });
  const [t, setT] = useState({ title: "", assigneeRole: "production", dueDate: "" });
  const task = useMutation({
    mutationFn: () => post("/api/tasks", { title: t.title, assigneeRole: t.assigneeRole, dueDate: t.dueDate || undefined, entityType: "scenario", entityId: id }),
    onSuccess: () => { setT({ ...t, title: "", dueDate: "" }); refresh(); },
  });
  const [c, setC] = useState({ title: "", description: "", urgency: "normal" });
  const cr = useMutation({
    mutationFn: () => post("/api/change-requests", { scenarioId: id, title: c.title, description: c.description, urgency: c.urgency }),
    onSuccess: () => { setC({ title: "", description: "", urgency: "normal" }); refresh(); },
  });
  const f = q.data?.followUps;
  return (
    <section className="card">
      <h2>{q.data?.name ?? "Senaryo"} — takip</h2>
      <p className="muted" style={{ margin: 0 }}>Senaryo gerçek kayıt oluşturmaz; sonucuna göre bir görev veya revizyon için değişiklik talebi açabilirsiniz. Açılan kayıtlar burada izlenir.</p>
      {f ? (
        f.tasks.length || f.changeRequests.length ? (
          <ul>
            {f.tasks.map((x: any) => <li key={x.id}><Link to={`/planning/tasks/${x.id}`}>Görev: {x.title}</Link> <StateBadge value={x.status} /> <span className="muted">{x.assigneeRole ?? ""} {x.dueDate ?? ""}</span></li>)}
            {f.changeRequests.map((x: any) => <li key={x.id}><Link to={`/changes/${x.id}`}>{x.code}: {x.title}</Link> <StateBadge value={x.status} /></li>)}
          </ul>
        ) : <Empty>Henüz takip kaydı yok.</Empty>
      ) : null}
      {can("task.manage") ? (
        <form className="row" onSubmit={(e: FormEvent) => { e.preventDefault(); task.mutate(); }}>
          <label className="field" style={{ flex: 1 }}>Görev<input aria-label="Senaryo görevi" required minLength={3} value={t.title} onChange={(e) => setT({ ...t, title: e.target.value })} /></label>
          <label className="field">Sorumlu<select aria-label="Görev sorumlusu" value={t.assigneeRole} onChange={(e) => setT({ ...t, assigneeRole: e.target.value })}>{ROLES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="field">Bitiş<input type="date" aria-label="Görev bitiş" value={t.dueDate} onChange={(e) => setT({ ...t, dueDate: e.target.value })} /></label>
          <button style={{ alignSelf: "flex-end" }} disabled={task.isPending}>Görev aç</button>
        </form>
      ) : null}
      <ErrorNotice error={task.error} />
      {can("change.create") ? (
        <form className="row" onSubmit={(e: FormEvent) => { e.preventDefault(); cr.mutate(); }}>
          <label className="field">Değişiklik talebi<input aria-label="Talep başlığı" required minLength={3} value={c.title} onChange={(e) => setC({ ...c, title: e.target.value })} /></label>
          <label className="field" style={{ flex: 1 }}>Açıklama<input aria-label="Talep açıklaması" required minLength={10} value={c.description} onChange={(e) => setC({ ...c, description: e.target.value })} /></label>
          <label className="field">Aciliyet<select aria-label="Talep aciliyeti" value={c.urgency} onChange={(e) => setC({ ...c, urgency: e.target.value })}><option value="low">Düşük</option><option value="normal">Normal</option><option value="high">Yüksek</option><option value="critical">Kritik</option></select></label>
          <button style={{ alignSelf: "flex-end" }} disabled={cr.isPending}>Talep aç</button>
        </form>
      ) : null}
      <ErrorNotice error={cr.error} />
    </section>
  );
}
