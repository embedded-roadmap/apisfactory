import { Fragment, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ItemAvailability, StockBalance } from "@apisfactory/shared";
import { auth, get, post } from "../lib/api";
import { Empty, ErrorNotice, Loading, PageHeader, StateBadge, fmt, fmtDate, useCan } from "../lib/ui";
import { LotCosts } from "./Reports";

const MSL_LEVELS = ["1", "2", "2a", "3", "4", "5", "5a", "6"];
const SHELF_STATUS: Record<string, string> = { expired: "SÜRESİ GEÇTİ", expiring_soon: "YAKINDA DOLUYOR", ok: "İYİ", unknown: "—" };

/** W33 — MSL, raf ömrü, ambalaj ve koşul: kalem saklama kuralları isteğe bağlıdır, AI süre uydurmaz. */
function StorageSection({ itemId, itemCode }: { itemId: string; itemCode: string }) {
  const can = useCan();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["itemLots", itemId], queryFn: () => get<{ item: any; lots: any[] }>(`/api/items/${itemId}/lots`) });
  const [form, setForm] = useState<{ mslLevel: string; floorLifeHours: string; shelfLifeDays: string; storageCondition: string; issuePolicy: string } | null>(null);
  const [expiryFor, setExpiryFor] = useState<{ id: string; mfgDate: string; expiresAt: string } | null>(null);

  const saveStorage = useMutation({
    mutationFn: () =>
      post(`/api/items/${itemId}/storage`, {
        mslLevel: form!.mslLevel || null,
        floorLifeHours: form!.floorLifeHours ? Number(form!.floorLifeHours) : null,
        shelfLifeDays: form!.shelfLifeDays ? Number(form!.shelfLifeDays) : null,
        storageCondition: form!.storageCondition || null,
        issuePolicy: form!.issuePolicy,
      }),
    onSuccess: () => { setForm(null); qc.invalidateQueries({ queryKey: ["itemLots", itemId] }); },
  });
  const saveExpiry = useMutation({
    mutationFn: () => post(`/api/lots/${expiryFor!.id}/expiry`, { mfgDate: expiryFor!.mfgDate || null, expiresAt: expiryFor!.expiresAt || null }),
    onSuccess: () => { setExpiryFor(null); qc.invalidateQueries({ queryKey: ["itemLots", itemId] }); },
  });
  const openLot = useMutation({
    mutationFn: (id: string) => post(`/api/lots/${id}/open`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["itemLots", itemId] }),
  });
  const [dryoutFor, setDryoutFor] = useState<string | null>(null);

  const item = q.data?.item;
  return (
    <section className="card">
      <div className="row between"><h2>{itemCode} — saklama & lot ömrü</h2></div>
      {q.isLoading ? <Loading /> : <ErrorNotice error={q.error} />}
      {item ? (
        form ? (
          <div className="grid4">
            <label className="field">MSL
              <select value={form.mslLevel} onChange={(e) => setForm({ ...form, mslLevel: e.target.value })}>
                <option value="">Yok</option>
                {MSL_LEVELS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
            <label className="field">Kullanım süresi (paket açık, saat)
              <input value={form.floorLifeHours} onChange={(e) => setForm({ ...form, floorLifeHours: e.target.value })} placeholder="ör. 168" />
            </label>
            <label className="field">Raf ömrü (kapalı paket, gün)
              <input value={form.shelfLifeDays} onChange={(e) => setForm({ ...form, shelfLifeDays: e.target.value })} placeholder="ör. 365" />
            </label>
            <label className="field">Çıkış politikası
              <select value={form.issuePolicy} onChange={(e) => setForm({ ...form, issuePolicy: e.target.value })}>
                <option value="fifo">FIFO (ilk giren ilk çıkar)</option>
                <option value="fefo">FEFO (önce süresi dolan çıkar)</option>
              </select>
            </label>
            <label className="field" style={{ gridColumn: "1 / -1" }}>Saklama koşulu
              <input value={form.storageCondition} onChange={(e) => setForm({ ...form, storageCondition: e.target.value })} placeholder="ör. ≤10°C, kuru dolap" />
            </label>
            <div className="row" style={{ gridColumn: "1 / -1" }}>
              <button onClick={() => saveStorage.mutate()} disabled={saveStorage.isPending}>Kaydet</button>
              <button className="ghost" onClick={() => setForm(null)}>Vazgeç</button>
            </div>
            <ErrorNotice error={saveStorage.error} />
          </div>
        ) : (
          <div className="row between">
            <div className="grid4">
              <div className="stat"><small>MSL</small><b>{item.mslLevel ?? "—"}</b></div>
              <div className="stat"><small>Kullanım süresi</small><b>{item.floorLifeHours ? `${item.floorLifeHours} sa` : "—"}</b></div>
              <div className="stat"><small>Raf ömrü</small><b>{item.shelfLifeDays ? `${item.shelfLifeDays} gün` : "—"}</b></div>
              <div className="stat"><small>Çıkış politikası</small><b>{item.issuePolicy.toUpperCase()}</b></div>
              <div className="stat"><small>Saklama koşulu</small><b>{item.storageCondition ?? "—"}</b></div>
            </div>
            {can("item.storage.manage") ? (
              <button onClick={() => setForm({ mslLevel: item.mslLevel ?? "", floorLifeHours: item.floorLifeHours ?? "", shelfLifeDays: item.shelfLifeDays ?? "", storageCondition: item.storageCondition ?? "", issuePolicy: item.issuePolicy })}>
                Düzenle
              </button>
            ) : null}
          </div>
        )
      ) : null}
      {q.data?.lots.length === 0 ? <Empty>Bu kaleme ait lot yok.</Empty> : null}
      {q.data && q.data.lots.length > 0 ? (
        <table>
          <thead><tr><th>Lot</th><th className="num">Miktar</th><th>Üretim</th><th>Son kullanma</th><th>Paket açıldı</th><th>Durum</th>{can("item.storage.manage") || can("inventory.issue") ? <th /> : null}</tr></thead>
          <tbody>
            {q.data.lots.map((l: any) => (
              <Fragment key={l.id}>
                <tr>
                  <td className="mono">{l.lotNo}</td>
                  <td className="num">{fmt(l.qty)}</td>
                  <td className="muted">{l.mfgDate ?? "—"}</td>
                  <td className="muted">{l.expiresAt ? l.expiresAt.slice(0, 10) : "—"}</td>
                  <td className="muted">{l.openedAt ? fmtDate(l.openedAt) : "—"}{l.floorLifeExpiresAt ? <div className="muted">kullanım sonu: {fmtDate(l.floorLifeExpiresAt)}</div> : null}</td>
                  <td>{l.status !== "unknown" ? <span className={`badge ${l.status === "expired" ? "bad" : l.status === "expiring_soon" ? "warn" : ""}`}>{SHELF_STATUS[l.status]}</span> : "—"}</td>
                  {can("item.storage.manage") || can("inventory.issue") || can("production.execute") ? (
                    <td>
                      <div className="row">
                        {can("item.storage.manage") ? <button onClick={() => setExpiryFor({ id: l.id, mfgDate: l.mfgDate ?? "", expiresAt: l.expiresAt ? l.expiresAt.slice(0, 10) : "" })}>Tarih gir</button> : null}
                        {can("inventory.issue") && !l.openedAt ? <button onClick={() => openLot.mutate(l.id)} disabled={openLot.isPending}>Paketi aç</button> : null}
                        {can("production.execute") && item?.mslLevel && l.openedAt ? <button onClick={() => setDryoutFor(dryoutFor === l.id ? null : l.id)}>{dryoutFor === l.id ? "Kapat" : "Kurutma"}</button> : null}
                      </div>
                    </td>
                  ) : null}
                </tr>
                {dryoutFor === l.id ? (
                  <tr><td colSpan={7}><DryoutPanel lotId={l.id} onChanged={() => qc.invalidateQueries({ queryKey: ["itemLots", itemId] })} /></td></tr>
                ) : null}
              </Fragment>
            ))}
          </tbody>
        </table>
      ) : null}
      {expiryFor ? (
        <div className="card">
          <h3>Lot üretim/son kullanma tarihi</h3>
          <div className="row">
            <label className="field">Üretim tarihi
              <input type="date" value={expiryFor.mfgDate} onChange={(e) => setExpiryFor({ ...expiryFor, mfgDate: e.target.value })} />
            </label>
            <label className="field">Son kullanma tarihi
              <input type="date" value={expiryFor.expiresAt} onChange={(e) => setExpiryFor({ ...expiryFor, expiresAt: e.target.value })} />
            </label>
            <button onClick={() => saveExpiry.mutate()} disabled={saveExpiry.isPending}>Kaydet</button>
            <button className="ghost" onClick={() => setExpiryFor(null)}>Vazgeç</button>
          </div>
          <ErrorNotice error={saveExpiry.error} />
        </div>
      ) : null}
    </section>
  );
}

/**
 * Kurutma (bake-out) çevrimi: JEDEC J-STD-033 tablosu burada sabit kodlanmaz (cihaz kalınlığına ve
 * üretici prosedürüne göre değişir); reçete kalite ekibi tarafından sürümlü tanımlanır. Tamamlanan bir
 * çevrim yalnızca kullanım süresi (floor life) saatini sıfırlar — raf ömrünü etkilemez.
 */
function DryoutPanel({ lotId, onChanged }: { lotId: string; onChanged: () => void }) {
  const can = useCan();
  const qc = useQueryClient();
  const cycles = useQuery({ queryKey: ["dryoutCycles", lotId], queryFn: () => get<any[]>(`/api/lots/${lotId}/dryout`) });
  const recipes = useQuery({ queryKey: ["dryoutRecipes"], queryFn: () => get<any[]>("/api/dryout-recipes") });
  const equipment = useQuery({ queryKey: ["equipment"], queryFn: () => get<any[]>("/api/equipment") });
  const ovens = (equipment.data ?? []).filter((e: any) => e.kind === "oven");
  const [recipeId, setRecipeId] = useState("");
  const [equipmentId, setEquipmentId] = useState("");
  const open = cycles.data?.find((c: any) => c.status === "in_progress");
  const [complete, setComplete] = useState({ actualTemperatureC: "", actualDurationHours: "" });

  const start = useMutation({
    mutationFn: () => post(`/api/lots/${lotId}/dryout/start`, { recipeId, equipmentId }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["dryoutCycles", lotId] }); onChanged(); },
  });
  const finish = useMutation({
    mutationFn: (status: "completed" | "aborted") =>
      post(`/api/lots/${lotId}/dryout/${open!.id}/complete`, {
        status,
        actualTemperatureC: complete.actualTemperatureC ? Number(complete.actualTemperatureC) : undefined,
        actualDurationHours: complete.actualDurationHours ? Number(complete.actualDurationHours) : undefined,
      }),
    onSuccess: () => { setComplete({ actualTemperatureC: "", actualDurationHours: "" }); qc.invalidateQueries({ queryKey: ["dryoutCycles", lotId] }); onChanged(); },
  });

  return (
    <div className="stack">
      <b>Kurutma (bake-out) geçmişi</b>
      <ErrorNotice error={start.error ?? finish.error} />
      {cycles.data?.length === 0 ? <span className="muted">Kayıt yok.</span> : null}
      {cycles.data?.length ? (
        <table><tbody>
          {cycles.data.map((c: any) => (
            <tr key={c.id}>
              <td><StateBadge value={c.status} prefix="dryout" /></td>
              <td className="muted">reçete v{c.recipeVersionNo} ({c.recipeTemperatureC}°C · {c.recipeDurationHours} sa)</td>
              <td className="muted">{c.equipmentCode}</td>
              <td className="muted">{fmtDate(c.startedAt)} → {c.endedAt ? fmtDate(c.endedAt) : "—"}</td>
              <td className="muted">{c.actualTemperatureC ? `gerçekleşen ${c.actualTemperatureC}°C · ${c.actualDurationHours} sa` : ""}</td>
            </tr>
          ))}
        </tbody></table>
      ) : null}
      {open ? (
        can("production.execute") ? (
          <form className="row" onSubmit={(e) => { e.preventDefault(); finish.mutate("completed"); }}>
            <span className="muted">Açık çevrim ({fmtDate(open.startedAt)} başladı) — gerçekleşen değerleri girip kapatın:</span>
            <label className="field" style={{ width: 110 }}>Sıcaklık (°C)<input inputMode="decimal" value={complete.actualTemperatureC} onChange={(e) => setComplete({ ...complete, actualTemperatureC: e.target.value })} /></label>
            <label className="field" style={{ width: 110 }}>Süre (sa)<input inputMode="decimal" value={complete.actualDurationHours} onChange={(e) => setComplete({ ...complete, actualDurationHours: e.target.value })} /></label>
            <button className="primary" disabled={finish.isPending}>Tamamlandı</button>
            <button type="button" className="ghost" disabled={finish.isPending} onClick={() => finish.mutate("aborted")}>Yarıda kesildi</button>
          </form>
        ) : null
      ) : can("production.execute") ? (
        <form className="row" onSubmit={(e) => { e.preventDefault(); start.mutate(); }}>
          <label className="field" style={{ flex: 1 }}>Reçete
            <select required value={recipeId} onChange={(e) => setRecipeId(e.target.value)}>
              <option value="">Seçin</option>
              {(recipes.data ?? []).map((r: any) => <option key={r.id} value={r.id}>v{r.versionNo} — {r.temperatureC}°C / {r.durationHours} sa{r.mslLevel ? ` (MSL ${r.mslLevel})` : ""}{r.itemCode ? ` (${r.itemCode})` : ""}</option>)}
            </select>
          </label>
          <label className="field" style={{ flex: 1 }}>Fırın
            <select required value={equipmentId} onChange={(e) => setEquipmentId(e.target.value)}>
              <option value="">Seçin</option>
              {ovens.map((o: any) => <option key={o.id} value={o.id} disabled={o.status !== "active" || o.calibrationExpired}>{o.code} — {o.name}{o.status !== "active" ? " (hizmet dışı)" : o.calibrationExpired ? " (kalibrasyon geçti)" : ""}</option>)}
            </select>
          </label>
          <button className="primary" style={{ alignSelf: "flex-end" }} disabled={start.isPending}>Çevrimi başlat</button>
        </form>
      ) : null}
      {!recipes.data?.length && can("item.storage.manage") ? <p className="muted" style={{ margin: 0 }}>Henüz kurutma reçetesi tanımlı değil (kalite ekibi tanımlar — üreticinin datasheet/prosedürüne göre).</p> : null}
    </div>
  );
}

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
      {item ? <StorageSection itemId={item.id} itemCode={item.code} /> : null}
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
