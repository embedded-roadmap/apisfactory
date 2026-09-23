import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { get } from "../lib/api";
import { ErrorNotice, Loading, PageHeader, fmtDate } from "../lib/ui";

/** İş olayı zaman çizelgesi. Kayıtlar değiştirilemez; düzeltme yeni olaydır (prompt §22). */
export function EventsPage() {
  const [entityType, setEntityType] = useState("");
  const q = useQuery({ queryKey: ["events", entityType], queryFn: () => get<any[]>(`/api/events?limit=200${entityType ? `&entityType=${entityType}` : ""}`) });
  return (
    <>
      <PageHeader title="İşlem geçmişi" sub="İnsan, içe aktarım, API ve otomasyon işlemleri ayrı işaretlenir." />
      <section className="card">
        <label className="field" style={{ maxWidth: 280 }}>
          Kayıt türü
          <select value={entityType} onChange={(e) => setEntityType(e.target.value)}>
            <option value="">Tümü</option>
            {["product", "product_revision", "bom_version", "item", "sales_order", "purchase_request", "goods_receipt", "lot", "import_job", "export"].map((x) => <option key={x}>{x}</option>)}
          </select>
        </label>
        {q.isLoading ? <Loading /> : <ErrorNotice error={q.error} />}
        <table>
          <thead><tr><th>Zaman</th><th>Kayıt</th><th>Olay</th><th>Aktör</th><th>Tür</th><th>Gerekçe</th></tr></thead>
          <tbody>
            {q.data?.map((e) => (
              <tr key={e.id}>
                <td className="muted">{fmtDate(e.createdAt)}</td>
                <td className="mono">{e.entityType}</td>
                <td className="mono">{e.eventType}</td>
                <td>{e.actorName ?? "—"}</td>
                <td><span className="badge">{e.actorKind}</span></td>
                <td>{e.reason ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
