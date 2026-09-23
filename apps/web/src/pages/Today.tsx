import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { get } from "../lib/api";
import { MentionsCard } from "../components/Discussion";
import { Empty, ErrorNotice, Loading, PageHeader, fmtDate, useMe } from "../lib/ui";

const LINK: Record<string, (id: string) => string> = {
  product_revision: () => "/products",
  goods_receipt_line: () => "/receiving",
  purchase_request: () => "/purchasing",
  production_need: () => "/production",
  work_order: (id) => `/production/${id}`,
  device: () => "/production",
  task: (id) => `/planning/tasks/${id}`,
  sales_order: (id) => `/sales/${id}`,
  change_request: (id) => `/changes/${id}`,
  rma: (id) => `/returns/${id}`,
  meeting: (id) => `/planning/meetings/${id}`,
  purchase_order: (id) => `/purchasing/orders/${id}`,
  supplier_invoice: (id) => `/payables/${id}`,
  customer_invoice: (id) => `/receivables/${id}`,
  shipment: (id) => `/shipments/${id}`,
};
const PRI: Record<string, string> = { low: "Düşük", normal: "Normal", high: "Yüksek", critical: "Kritik" };

/** Kullanıcının bütün rollerinden gelen açık işler tek listede (prompt §20, §25 "Günlük işler"). */
export function TodayPage() {
  const { me } = useMe();
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: () => get<({ id: string; title: string; assigneeRole: string | null; entityType: string; entityId: string; createdAt: string } & { kind: string; priority: string; dueDate: string | null; overdue: boolean; milestone: boolean; checklistTotal: number; checklistDone: number; status: string } & Record<string, any>)[]>("/api/tasks/mine") });
  const delegated = useQuery({ queryKey: ["tasksDelegated"], queryFn: () => get<any[]>("/api/tasks/delegated") });
  const integrations = useQuery({ queryKey: ["integrations"], queryFn: () => get<{ key: string; name: string; mode: string; note: string }[]>("/api/integrations") });
  return (
    <>
      <PageHeader title={`Günaydın, ${me?.user.name.split(" ")[0] ?? ""}`} sub="Rollerinize atanmış açık işler" />
      <MentionsCard />
      <UpcomingMeetings />
      <section className="card">
        <h2>Bana atanan işler</h2>
        {tasks.isLoading ? <Loading /> : <ErrorNotice error={tasks.error} />}
        {tasks.data && tasks.data.length === 0 ? <Empty>Açık işiniz yok.</Empty> : null}
        {tasks.data && tasks.data.length > 0 ? (
          <table>
            <thead><tr><th>İş</th><th>Sorumlu</th><th>Öncelik</th><th>Bitiş</th><th>Açılış</th><th /></tr></thead>
            <tbody>
              {tasks.data.map((t) => (
                <tr key={t.id}>
                  <td>{t.milestone ? "◆ " : ""}{t.title}{t.checklistTotal ? <span className="muted"> · liste {t.checklistDone}/{t.checklistTotal}</span> : null}{t.status === "blocked" ? <span className="badge bad">engelli</span> : null}</td>
                  <td>{t.assigneeRole ? <span className="badge">{t.assigneeRole}</span> : <span className="badge">bana</span>}</td>
                  <td>{PRI[t.priority] ?? ""}</td>
                  <td>{t.dueDate ?? "—"} {t.overdue ? <span className="badge bad">gecikti</span> : null}</td>
                  <td className="muted">{fmtDate(t.createdAt)}</td>
                  <td><Link to={t.kind === "escalation" ? "/workflow/monitor" : t.kind === "manual" ? `/planning/tasks/${t.id}` : (LINK[t.entityType] ?? (() => "/"))(t.entityId)}>Aç</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>
      {delegated.data?.length ? (
        <section className="card">
          <h2>Vekâleten bekleyen işler</h2>
          <p className="muted" style={{ margin: 0 }}>Vekâlet süresince yaptığınız onaylar kimin adına yapıldığıyla birlikte kaydedilir.</p>
          <table>
            <tbody>
              {delegated.data.map((t) => (
                <tr key={t.id}>
                  <td>{t.title}</td><td><span className="badge warn">vekâleten: {t.onBehalfOfName}</span></td>
                  <td>{t.dueAt ? fmtDate(t.dueAt) : "—"} {t.overdue ? <span className="badge bad">gecikti</span> : null}</td>
                  <td><Link to={(LINK[t.entityType] ?? (() => "/"))(t.entityId)}>Aç</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
      <section className="card">
        <h2>Bağlantı durumu</h2>
        <p className="muted" style={{ margin: 0 }}>Bağlanmamış bir kaynak çalışıyormuş gibi gösterilmez.</p>
        <table>
          <tbody>
            {integrations.data?.map((i) => (
              <tr key={i.key}>
                <td>{i.name}</td>
                <td><span className={`badge mode ${i.mode === "test" ? "warn" : ""}`}>{i.mode === "not_connected" ? "BAĞLANMADI" : i.mode.toUpperCase()}</span></td>
                <td className="muted">{i.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

function UpcomingMeetings() {
  const q = useQuery({ queryKey: ["meetings", "mine-upcoming"], queryFn: () => get<any[]>("/api/meetings?scope=upcoming") });
  const mine = (q.data ?? []).filter((m) => m.isParticipant).slice(0, 5);
  if (!mine.length) return null;
  return (
    <section className="card">
      <h2>Yaklaşan toplantılarım</h2>
      <table><tbody>{mine.map((m) => (
        <tr key={m.id}><td className="mono"><Link to={`/planning/meetings/${m.id}`}>{m.code}</Link></td><td>{m.title}</td><td>{fmtDate(m.startsAt)}</td><td className="muted">{m.location ?? ""}</td></tr>
      ))}</tbody></table>
    </section>
  );
}
