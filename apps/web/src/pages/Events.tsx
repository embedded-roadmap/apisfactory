import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { get } from "../lib/api";
import { Empty, ErrorNotice, Loading, PageHeader, fmtDate, useCan } from "../lib/ui";

/** İş olayı zaman çizelgesi. Kayıtlar değiştirilemez; düzeltme yeni olaydır (prompt §22). */
export function EventsPage() {
  const can = useCan();
  const [entityType, setEntityType] = useState("");
  const q = useQuery({ queryKey: ["events", entityType], queryFn: () => get<any[]>(`/api/events?limit=200${entityType ? `&entityType=${entityType}` : ""}`) });
  return (
    <>
      <PageHeader title="İşlem geçmişi" sub="İnsan, içe aktarım, API ve otomasyon işlemleri ayrı işaretlenir."
        actions={can("audit.view") ? <Link className="btn" to="/events/connectors">Bağlayıcı panosu</Link> : null} />
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

const CATEGORY: Record<string, string> = { distributor: "Distribütör", einvoice: "E-belge", cargo: "Kargo" };

/** W38 — bağlayıcı operasyon panosu: kota, önbellek isabeti, hata sayısı, son etkinlik. Yeni veri kaynağı yok; mevcut çağrı/gönderim kayıtlarının özeti. */
export function ConnectorsStatusPage() {
  const q = useQuery({ queryKey: ["connectorsStatus"], queryFn: () => get<any>("/api/connectors/status") });
  const s = q.data;
  return (
    <>
      <PageHeader title="Bağlayıcı panosu" sub={<>Gerçek dış API bağlantısı olan bağlayıcı yok; pano yalnız TEST/fiyat dosyası modundaki kota, önbellek isabeti ve etkinliği gösterir. <Link to="/events">← İşlem geçmişi</Link></>} />
      {q.isLoading ? <Loading /> : <ErrorNotice error={q.error} />}
      {s ? (
        <>
          <section className="card">
            <div className="grid4">
              <div className="stat"><small>Bağlı</small><b style={{ fontSize: 20 }}>{s.summary.connected}/{s.summary.total}</b></div>
              <div className="stat"><small>Son 7 gün hata</small><b style={{ fontSize: 20 }}>{s.summary.errorsWeek}</b></div>
              <div className="stat"><small>Bugün kota dolan</small><b style={{ fontSize: 20 }}>{s.summary.quotaHitsToday}</b></div>
            </div>
          </section>
          {(["distributor", "einvoice", "cargo"] as const).map((cat) => (
            <section className="card" key={cat}>
              <h2>{CATEGORY[cat]}</h2>
              {!s.rows.filter((r: any) => r.category === cat).length ? <Empty>Bağlayıcı yok.</Empty> : (
                <table>
                  <thead><tr><th>Sağlayıcı</th><th>Mod</th><th className="num">Bugün</th>{cat === "distributor" ? <><th className="num">Kota</th><th className="num">Önbellek isabeti</th></> : null}<th className="num">Toplam</th><th className="num">7g hata</th><th>Son etkinlik</th></tr></thead>
                  <tbody>{s.rows.filter((r: any) => r.category === cat).map((r: any) => (
                    <tr key={r.id}>
                      <td>{r.name}</td>
                      <td><span className={`badge ${r.mode === "not_connected" ? "" : "warn"}`}>{r.mode === "not_connected" ? "BAĞLANMADI" : r.mode === "test" ? "TEST" : "FİYAT DOSYASI"}</span></td>
                      <td className="num">{r.activityToday}</td>
                      {cat === "distributor" ? (
                        <>
                          <td className="num">{r.activityToday}/{r.quota} {r.quotaPct !== null ? <span className={r.quotaPct >= 90 ? "badge bad" : "muted"}>%{r.quotaPct}</span> : null}</td>
                          <td className="num">{r.cacheHitPct !== null ? `%${r.cacheHitPct}` : "—"}</td>
                        </>
                      ) : null}
                      <td className="num">{r.activityTotal}</td>
                      <td className="num">{r.errorsWeek > 0 ? <span className="badge bad">{r.errorsWeek}</span> : 0}</td>
                      <td className="muted">{r.lastActivityAt ? fmtDate(r.lastActivityAt) : "—"}</td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
            </section>
          ))}
        </>
      ) : null}
    </>
  );
}
