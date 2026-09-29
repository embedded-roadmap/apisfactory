import { useState } from "react";
import { ScenarioFollowUps } from "../components/ScenarioFollowUps";
import { useMutation, useQuery } from "@tanstack/react-query";
import { get, post } from "../lib/api";
import { Empty, ErrorNotice, Loading, PageHeader, fmtDate, useCan } from "../lib/ui";
import { ItemPicker } from "./Alternates";

/** W35 — senaryo, maliyet/termin kıyası: gerçek operasyonu değiştirmeyen "ne olurdu" hesabı. */
export function ScenariosPage() {
  const can = useCan();
  const [revision, setRevision] = useState<{ id: string; label: string } | null>(null);
  const products = useQuery({ queryKey: ["productsForScenario"], queryFn: () => get<any[]>("/api/products") });
  const [name, setName] = useState("");
  const [qty, setQty] = useState("");
  const [critical, setCritical] = useState<any | null>(null);
  const [delayDays, setDelayDays] = useState("");
  const [primary, setPrimary] = useState<any | null>(null);
  const [alternate, setAlternate] = useState<any | null>(null);
  const [subcontract, setSubcontract] = useState(false);
  const [extraShift, setExtraShift] = useState("");
  const [result, setResult] = useState<any | null>(null);
  const [sel, setSel] = useState<string | null>(null);

  const list = useQuery({ queryKey: ["scenarios", revision?.id], queryFn: () => get<any[]>(`/api/scenarios?productRevisionId=${revision!.id}`), enabled: !!revision });

  const run = useMutation({
    mutationFn: () =>
      post("/api/scenarios", {
        name,
        productRevisionId: revision!.id,
        qty,
        overrides: {
          ...(critical && delayDays ? { criticalItemId: critical.id, delayDays: Number(delayDays) } : {}),
          ...(primary && alternate ? { alternateFor: { itemId: primary.id, alternateItemId: alternate.id } } : {}),
          ...(subcontract ? { subcontract: true } : {}),
          ...(extraShift ? { extraShiftMinutes: Number(extraShift) } : {}),
        },
      }),
    onSuccess: (r: any) => { setResult(r); list.refetch(); },
  });

  return (
    <>
      <PageHeader title="Senaryo karşılaştırma" sub="Baz planın kopyası üzerinde ne-olurdu hesabı; gerçek rezervasyon, sipariş veya iş emri oluşturmaz." />
      <section className="card">
        <label className="field">Ürün / revizyon
          <select
            value={revision?.id ?? ""}
            onChange={(e) => {
              const [pid, rid] = e.target.value.split("::");
              const p = products.data?.find((x) => x.id === pid);
              const r = p?.revisions.find((x: any) => x.id === rid);
              setRevision(r ? { id: r.id, label: `${p.code} Rev.${r.rev}` } : null);
              setResult(null);
            }}
          >
            <option value="">Seçin…</option>
            {products.data?.map((p) => p.revisions.map((r: any) => (
              <option key={r.id} value={`${p.id}::${r.id}`}>{p.code} Rev.{r.rev}</option>
            )))}
          </select>
        </label>
      </section>
      {revision && can("report.view") ? (
        <form className="card" onSubmit={(e) => { e.preventDefault(); run.mutate(); }}>
          <h2>Yeni senaryo — {revision.label}</h2>
          <ErrorNotice error={run.error} />
          <div className="grid4">
            <label className="field">Senaryo adı<input required value={name} onChange={(e) => setName(e.target.value)} placeholder="ör. 500 yerine 1000 adet" /></label>
            <label className="field">Üretim adedi<input required inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} /></label>
          </div>
          <h3>Kritik parça gecikmesi (isteğe bağlı)</h3>
          <div className="grid4">
            <ItemPicker label="Kritik parça" value={critical} onChange={setCritical} />
            <label className="field">Gecikme (gün)<input inputMode="numeric" value={delayDays} onChange={(e) => setDelayDays(e.target.value)} /></label>
          </div>
          <h3>Onaylı alternatif kullanımı (isteğe bağlı)</h3>
          <div className="grid4">
            <ItemPicker label="Asıl parça" value={primary} onChange={setPrimary} />
            <ItemPicker label="Onaylı alternatif" value={alternate} onChange={setAlternate} />
          </div>
          <h3>Kapasite (isteğe bağlı)</h3>
          <div className="grid4">
            <label className="field"><input type="checkbox" checked={subcontract} onChange={(e) => setSubcontract(e.target.checked)} /> İç üretim yerine fason (iç kapasite kullanılmaz)</label>
            <label className="field">Ek vardiya (dakika/gün)<input inputMode="numeric" value={extraShift} onChange={(e) => setExtraShift(e.target.value)} /></label>
          </div>
          <div><button className="primary" disabled={run.isPending}>Senaryoyu hesapla</button></div>
        </form>
      ) : null}
      {result ? <ScenarioResult r={result} /> : null}
      {result && !sel ? <ScenarioFollowUps id={result.id} /> : null}
      {revision ? (
        <section className="card">
          <h2>Kayıtlı senaryolar</h2>
          {list.isLoading ? <Loading /> : <ErrorNotice error={list.error} />}
          {list.data?.length === 0 ? <Empty>Bu revizyon için senaryo yok.</Empty> : null}
          {list.data && list.data.length > 0 ? (
            <table>
              <thead><tr><th>Ad</th><th className="num">Adet</th><th>Baz termin</th><th>Senaryo termin</th><th className="num">Δ gün</th><th className="num">Δ maliyet</th><th>Oluşturuldu</th></tr></thead>
              <tbody>
                {list.data.map((s) => (
                  <tr key={s.id} className="click" onClick={() => setSel(s.id)}>
                    <td>{s.name}</td>
                    <td className="num">{s.qty}</td>
                    <td className="muted">{s.baselineLatest ?? "—"}</td>
                    <td className="muted">{s.scenarioLatest ?? "—"}</td>
                    <td className="num">{s.delta.latestDays ?? "—"}</td>
                    <td className="num">{s.delta.materialCost ?? "—"}</td>
                    <td className="muted">{fmtDate(s.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </section>
      ) : null}
      {sel ? <ScenarioFollowUps key={sel} id={sel} /> : null}
    </>
  );
}

function ScenarioResult({ r }: { r: any }) {
  const b = r.result.baseline, s = r.result.scenario, d = r.result.delta;
  return (
    <section className="card">
      <h2>{r.name} — sonuç</h2>
      <div className="grid4">
        <div className="stat"><small>Baz termin (geç)</small><b>{b.latest ?? "—"}</b></div>
        <div className="stat"><small>Senaryo termin (geç)</small><b>{s.latest ?? "—"}</b></div>
        <div className="stat"><small>Termin farkı</small><b style={{ color: d.latestDays && d.latestDays > 0 ? "var(--bad, #b91c1c)" : undefined }}>{d.latestDays === null ? "—" : `${d.latestDays > 0 ? "+" : ""}${d.latestDays} gün`}</b></div>
        <div className="stat"><small>Referans malzeme maliyet farkı</small><b>{d.materialCost ?? "hesaplanamadı"} {s.costCurrency ?? ""}</b></div>
      </div>
      <table>
        <thead><tr><th>Malzeme</th><th className="num">İhtiyaç</th><th>Kaynak</th><th>Hazır olma</th><th className="num">Birim maliyet</th></tr></thead>
        <tbody>{s.materials.map((m: any, i: number) => (
          <tr key={i}><td className="mono">{m.itemCode}</td><td className="num">{m.requiredQty}</td><td className="muted">{m.source}</td><td className="muted">{m.readyDate ?? "hesaplanamadı"}</td><td className="num">{m.unitCost ?? "—"}</td></tr>
        ))}</tbody>
      </table>
      <h3>Varsayımlar</h3>
      <ul>{s.assumptions.map((a: string, i: number) => <li key={i} className="muted">{a}</li>)}</ul>
      {s.reasons.length ? <><h3>Hesaplanamayan noktalar</h3><ul>{s.reasons.map((x: string, i: number) => <li key={i} className="muted">{x}</li>)}</ul></> : null}
    </section>
  );
}
