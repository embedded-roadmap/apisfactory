import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { Task } from "@apisfactory/shared";
import { get } from "../lib/api";
import { Empty, ErrorNotice, Loading, PageHeader, fmtDate, useMe } from "../lib/ui";

const LINK: Record<string, (id: string) => string> = {
  product_revision: () => "/products",
  goods_receipt_line: () => "/receiving",
  purchase_request: () => "/purchasing",
  production_need: () => "/sales",
};

/** Kullanıcının bütün rollerinden gelen açık işler tek listede (prompt §20, §25 "Günlük işler"). */
export function TodayPage() {
  const { me } = useMe();
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: () => get<(Task & { kind: string })[]>("/api/tasks/mine") });
  const integrations = useQuery({ queryKey: ["integrations"], queryFn: () => get<{ key: string; name: string; mode: string; note: string }[]>("/api/integrations") });
  return (
    <>
      <PageHeader title={`Günaydın, ${me?.user.name.split(" ")[0] ?? ""}`} sub="Rollerinize atanmış açık işler" />
      <section className="card">
        <h2>Bana atanan işler</h2>
        {tasks.isLoading ? <Loading /> : <ErrorNotice error={tasks.error} />}
        {tasks.data && tasks.data.length === 0 ? <Empty>Açık işiniz yok.</Empty> : null}
        {tasks.data && tasks.data.length > 0 ? (
          <table>
            <thead><tr><th>İş</th><th>Rol</th><th>Açılış</th><th /></tr></thead>
            <tbody>
              {tasks.data.map((t) => (
                <tr key={t.id}>
                  <td>{t.title}</td>
                  <td><span className="badge">{t.assigneeRole}</span></td>
                  <td className="muted">{fmtDate(t.createdAt)}</td>
                  <td><Link to={(LINK[t.entityType] ?? (() => "/"))(t.entityId)}>Aç</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>
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
