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
      ) : null}
      <section className="card">
        <h2>Geçmiş işler</h2>
        <table>
          <tbody>
            {jobs.data?.map((j) => (
              <tr key={j.id}><td>{j.kind === "bom" ? "BOM" : "Açılış stoğu"}</td><td className="mono">{j.fileName}</td><td><StateBadge value={j.status} prefix="job" /></td><td className="muted">{fmtDate(j.createdAt)}</td></tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
