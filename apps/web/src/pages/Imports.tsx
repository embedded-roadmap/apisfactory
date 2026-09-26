import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ImportPreview } from "@apisfactory/shared";
import { get, post } from "../lib/api";
import { CsvWizard } from "../components/CsvWizard";
import { PageHeader, StateBadge, fmtDate, useCan } from "../lib/ui";

export function ImportsPage() {
  const can = useCan();
  const qc = useQueryClient();
  const jobs = useQuery({ queryKey: ["imports"], queryFn: () => get<any[]>("/api/imports") });
  return (
    <>
      <PageHeader title="İçe aktarım" sub="Açılış stoğu hareket olarak girer; aynı dosya ikinci kez işlenmez. BOM aktarımı ürün sayfasındadır." />
      {can("inventory.import") ? (
        <section className="card">
          <h2>Açılış stoğu</h2>
          <CsvWizard
            columns={["itemCode", "lotNo", "locationCode", "qty", "rev"]}
            fields={[
              { key: "itemCode", label: "Kalem kodu", required: true, guesses: ["kod", "stok kodu", "item", "code"] },
              { key: "qty", label: "Miktar", required: true, guesses: ["miktar", "qty", "adet", "quantity"] },
              { key: "lotNo", label: "Lot", required: true, guesses: ["lot", "lot no", "seri"] },
              { key: "locationCode", label: "Konum kodu", required: true, guesses: ["konum", "location", "depo"] },
              { key: "rev", label: "Revizyon (bitmiş ürün)", guesses: ["rev", "revizyon", "revision"] },
            ]}
            onPreview={(a) => post<ImportPreview>("/api/imports/stock/preview", a)}
            onCommit={async (jobId) => {
              const r = await post(`/api/imports/${jobId}/commit`, {});
              qc.invalidateQueries({ queryKey: ["imports"] });
              return r;
            }}
          />
        </section>
      ) : null}
      {can("sales.create") ? (
        <section className="card">
          <h2>Müşteriler (W39 devamı)</h2>
          <p className="muted" style={{ marginTop: 0 }}>Ana veri güncellemesidir: kod eşleşirse ad güncellenir, yoksa yeni müşteri açılır — hareket/sipariş etkilenmez.</p>
          <CsvWizard
            columns={["code", "name"]}
            fields={[
              { key: "code", label: "Müşteri kodu", required: true, guesses: ["kod", "code", "müşteri kodu"] },
              { key: "name", label: "Müşteri adı", required: true, guesses: ["ad", "isim", "name", "unvan"] },
            ]}
            onPreview={(a) => post<ImportPreview>("/api/imports/customers/preview", a)}
            onCommit={async (jobId) => {
              const r = await post(`/api/imports/${jobId}/commit`, {});
              qc.invalidateQueries({ queryKey: ["imports"] });
              return r;
            }}
          />
        </section>
      ) : null}
      {can("supplier.manage") ? (
        <section className="card">
          <h2>Tedarikçiler (W39 devamı)</h2>
          <p className="muted" style={{ marginTop: 0 }}>Ana veri güncellemesidir: kod eşleşirse ad/iletişim/teslim süresi güncellenir, yoksa yeni tedarikçi açılır.</p>
          <CsvWizard
            columns={["code", "name", "contactEmail", "leadTimeDays"]}
            fields={[
              { key: "code", label: "Tedarikçi kodu", required: true, guesses: ["kod", "code", "tedarikçi kodu"] },
              { key: "name", label: "Tedarikçi adı", required: true, guesses: ["ad", "isim", "name", "unvan"] },
              { key: "contactEmail", label: "İletişim e-posta", guesses: ["email", "e-posta", "eposta"] },
              { key: "leadTimeDays", label: "Varsayılan teslim süresi (gün)", guesses: ["teslim süresi", "lead time", "gün"] },
            ]}
            onPreview={(a) => post<ImportPreview>("/api/imports/suppliers/preview", a)}
            onCommit={async (jobId) => {
              const r = await post(`/api/imports/${jobId}/commit`, {});
              qc.invalidateQueries({ queryKey: ["imports"] });
              return r;
            }}
          />
        </section>
      ) : null}
      <section className="card">
        <h2>Geçmiş işler</h2>
        <p className="muted" style={{ marginTop: 0 }}>Uzlaşma: kaynak dosyadaki işlenebilir satır sayısı ile hedefte gerçekte oluşan kayıt sayısı karşılaştırılır (W39 devamı).</p>
        <table>
          <thead><tr><th>Tür</th><th>Dosya</th><th>Durum</th><th>Tarih</th><th>Uzlaşma</th></tr></thead>
          <tbody>
            {jobs.data?.map((j) => (
              <tr key={j.id}>
                <td>{JOB_KIND_LABEL[j.kind] ?? j.kind}</td>
                <td className="mono">{j.fileName}</td>
                <td><StateBadge value={j.status} prefix="job" /></td>
                <td className="muted">{fmtDate(j.createdAt)}</td>
                <td>
                  {j.reconciliation ? (
                    j.reconciliation.matched === null ? (
                      <span className="muted">—</span>
                    ) : (
                      <span className={`badge ${j.reconciliation.matched ? "ok" : "bad"}`}>
                        kaynak {j.reconciliation.sourceRows} / hedef {j.reconciliation.targetRows}
                        {j.reconciliation.matched ? "" : " — UYUŞMUYOR"}
                      </span>
                    )
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

const JOB_KIND_LABEL: Record<string, string> = { bom: "BOM", stock_opening: "Açılış stoğu", customers: "Müşteriler", suppliers: "Tedarikçiler" };
