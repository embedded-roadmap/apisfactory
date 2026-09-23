import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ItemAvailability, StockBalance } from "@apisfactory/shared";
import { auth, get } from "../lib/api";
import { Empty, ErrorNotice, Loading, PageHeader, StateBadge, fmt, useCan } from "../lib/ui";
import { LotCosts } from "./Reports";

export function InventoryPage() {
  const can = useCan();
  const [q, setQ] = useState("");
  const [item, setItem] = useState<{ id: string; code: string } | null>(null);
  const [lot, setLot] = useState<{ id: string; no: string } | null>(null);
  const list = useQuery({ queryKey: ["balances", q], queryFn: () => get<(StockBalance & { inspectionStatus: string })[]>(`/api/stock/balances${q ? `?q=${encodeURIComponent(q)}` : ""}`) });
  const avail = useQuery({ enabled: !!item, queryKey: ["avail", item?.id], queryFn: () => get<ItemAvailability>(`/api/stock/availability/${item!.id}`) });

  async function exportCsv() {
    const { session, companyId } = auth.get();
    const res = await fetch("/api/export/stock.csv", { headers: { authorization: `Bearer ${session?.token}`, "x-company-id": companyId ?? "" } });
    if (!res.ok) return;
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "stok.csv";
    a.click();
  }

  return (
    <>
      <PageHeader
        title="Depo & Lot"
        sub="Miktar yalnızca hareketlerle değişir; kullanılabilir, kontrol bekleyen, karantina ve rezerve miktar ayrı gösterilir."
        actions={can("export.run") ? <button onClick={exportCsv}>CSV dışa aktar</button> : null}
      />
      {item ? (
        <section className="card">
          <div className="row between"><h2>{item.code} — miktar durumu</h2><button onClick={() => setItem(null)}>Kapat</button></div>
          {avail.isLoading ? <Loading /> : <ErrorNotice error={avail.error} />}
          {avail.data ? (
            <div className="grid4">
              <Stat label="Fiziksel" v={avail.data.physical} />
              <Stat label="Kullanılabilir konumda" v={avail.data.usable} />
              <Stat label="Rezerve" v={avail.data.reserved} />
              <Stat label="Serbest (ayrılmamış)" v={avail.data.available} />
              <Stat label="Giriş kontrolünde" v={avail.data.inspection} />
              <Stat label="Karantina" v={avail.data.quarantine} />
              <Stat label="İade kabul" v={avail.data.returns} />
              <Stat label="Fasonda" v={avail.data.subcontractor} />
              <Stat label="Açık alım" v={avail.data.openPurchase} />
            </div>
          ) : null}
        </section>
      ) : null}
      {lot ? (
        <section className="card">
          <div className="row between"><span /><button onClick={() => setLot(null)}>Kapat</button></div>
          <LotCosts lotId={lot.id} lotNo={lot.no} />
        </section>
      ) : null}
      <section className="card">
        <input aria-label="Ara" placeholder="Kod, MPN veya lot ara" value={q} onChange={(e) => setQ(e.target.value)} />
        {list.isLoading ? <Loading /> : <ErrorNotice error={list.error} />}
        {list.data?.length === 0 ? <Empty>Stok hareketi yok.</Empty> : null}
        {list.data && list.data.length > 0 ? (
          <table>
            <thead><tr><th>Kalem</th><th>Lot</th><th>Konum</th><th>Konum tipi</th><th>Giriş kalite</th><th className="num">Miktar</th>{can("field.cost.view") ? <th /> : null}</tr></thead>
            <tbody>
              {list.data.map((b) => (
                <tr key={b.lotId + b.locationId} className="click" onClick={() => setItem({ id: b.itemId, code: b.itemCode })}>
                  <td><span className="mono">{b.itemCode}</span><div className="muted">{b.itemName}</div></td>
                  <td className="mono">{b.lotNo}</td>
                  <td className="mono">{b.locationCode}</td>
                  <td><StateBadge value={b.locationType} prefix="loc" /></td>
                  <td>{b.inspectionStatus === "not_required" ? "—" : <StateBadge value={b.inspectionStatus} prefix="insp" />}</td>
                  <td className="num">{fmt(b.qty)}</td>
                  {can("field.cost.view") ? <td><button onClick={(e) => { e.stopPropagation(); setLot({ id: b.lotId, no: b.lotNo }); }}>Maliyet</button></td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>
    </>
  );
}

function Stat({ label, v }: { label: string; v: string }) {
  return <div className="stat"><small>{label}</small><b>{fmt(v)}</b></div>;
}
