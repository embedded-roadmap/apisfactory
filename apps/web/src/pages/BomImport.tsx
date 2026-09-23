import { Link, useParams } from "react-router-dom";
import type { ImportPreview, Item } from "@apisfactory/shared";
import { get, post } from "../lib/api";
import { CsvWizard } from "../components/CsvWizard";
import { PageHeader } from "../lib/ui";

export function BomImportPage() {
  const { id } = useParams();
  return (
    <>
      <PageHeader title="BOM içe aktar" sub={<Link to={`/products/${id}`}>← Ürüne dön</Link>} />
      <CsvWizard
        columns={["refdes", "manufacturer", "mpn", "qty", "dnp"]}
        fields={[
          { key: "mpn", label: "Tam MPN", required: true, guesses: ["mpn", "manufacturer part number", "manufacturer_part_number", "part number", "mfr part"] },
          { key: "manufacturer", label: "Üretici", guesses: ["manufacturer", "mfr", "üretici", "manufacturer 1"] },
          { key: "qty", label: "Miktar", required: true, guesses: ["quantity", "qty", "miktar", "adet"] },
          { key: "refdes", label: "Referans", guesses: ["designator", "reference", "refdes", "references", "referans"] },
          { key: "description", label: "Açıklama", guesses: ["description", "value", "açıklama", "comment"] },
          { key: "dnp", label: "DNP", guesses: ["dnp", "do not place", "dni"] },
          { key: "internalCode", label: "İç kod", guesses: ["internal code", "iç kod", "stok kodu"] },
        ]}
        onPreview={(a) => post<ImportPreview>("/api/imports/bom/preview", { productId: id, ...a })}
        onCommit={(jobId, resolutions) => post(`/api/imports/${jobId}/commit`, { resolutions })}
        resolveOptions={async (row) => {
          const items = await get<Item[]>(`/api/items?q=${encodeURIComponent(row.values.mpn ?? "")}&kind=component`);
          return items.map((i) => ({ id: i.id, label: `${i.code} · ${i.manufacturer ?? "?"} ${i.mpn ?? ""}` }));
        }}
      />
    </>
  );
}
