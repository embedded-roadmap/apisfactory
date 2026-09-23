import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, post } from "../lib/api";
import { Empty, ErrorNotice, Loading, PageHeader, fmtDate, useCan } from "../lib/ui";
import { PurchasingTabs } from "./Procurement";

const MODE: Record<string, [string, string]> = { not_connected: ["BAĞLANMADI", ""], test: ["TEST", "warn"], price_file: ["FİYAT DOSYASI", "ok"] };
const num = (n: number | null | undefined, d = 4) => (n === null || n === undefined ? "—" : n.toLocaleString("tr-TR", { maximumFractionDigits: d }));

/** W17 — distribütör bağlayıcıları: mod, tedarikçi eşlemesi, önbellek süresi, kota, fiyat listesi yükleme. */
export function DistributorsPage() {
  const can = useCan();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["distributors"], queryFn: () => get<any[]>("/api/distributors") });
  const sup = useQuery({ queryKey: ["suppliers"], queryFn: () => get<any[]>("/api/suppliers") });
  const [edit, setEdit] = useState<any | null>(null);
  const save = useMutation({
    mutationFn: () => post(`/api/distributors/${edit.id}`, { mode: edit.mode, supplierId: edit.supplierId || null, cacheTtlMinutes: Number(edit.cacheTtlMinutes), dailyCallLimit: Number(edit.dailyCallLimit), currency: edit.currency, reason: edit.reason }),
    onSuccess: () => { setEdit(null); qc.invalidateQueries({ queryKey: ["distributors"] }); },
  });
  const [upload, setUpload] = useState<{ id: string; file: { name: string; content: string } | null; decimal: string } | null>(null);
  const up = useMutation({ mutationFn: () => post<any>(`/api/distributors/${upload!.id}/price-file`, { fileName: upload!.file!.name, content: upload!.file!.content, decimal: upload!.decimal }), onSuccess: () => qc.invalidateQueries({ queryKey: ["distributors"] }) });
  return (
    <>
      <PageHeader title="Satın alma" sub="Distribütör fiyat/stok bağlantısı. Gerçek distribütör API'si bağlı değil (lisans/erişim doğrulaması bekliyor): TEST modu sentetik katalog üretir ve her yerde işaretlenir; FİYAT DOSYASI modu distribütörden indirilen listeyi yükler." />
      <PurchasingTabs />
      <section className="card">
        <h2>Bağlayıcılar</h2>
        {q.isLoading ? <Loading /> : <ErrorNotice error={q.error} />}
        <table>
          <thead><tr><th>Distribütör</th><th>Mod</th><th>Tedarikçi</th><th className="num">Önbellek</th><th className="num">Bugün çağrı / kota</th><th className="num">Önbellekten</th><th className="num">Teklif</th><th>Son veri</th><th /></tr></thead>
          <tbody>{q.data?.map((c) => (
            <tr key={c.id}>
              <td>{c.name} <span className="muted">({c.currency})</span></td>
              <td><span className={`badge mode ${MODE[c.mode]![1]}`}>{MODE[c.mode]![0]}</span></td>
              <td>{c.supplierName ?? <span className="muted">bağlı değil</span>}</td>
              <td className="num">{c.cacheTtlMinutes >= 60 ? `${Math.round(c.cacheTtlMinutes / 60)} sa` : `${c.cacheTtlMinutes} dk`}</td>
              <td className="num">{c.callsToday} / {c.dailyCallLimit}</td><td className="num">{c.cacheHitsToday}</td><td className="num">{c.offers}</td>
              <td className="muted">{c.lastFetchedAt ? fmtDate(c.lastFetchedAt) : "—"}</td>
              <td className="row">
                {can("supplier.manage") ? <button onClick={() => setEdit({ ...c, supplierId: c.supplierId ?? "", reason: "" })}>Ayarla</button> : null}
                {can("supplier.manage") && c.mode === "price_file" ? <button onClick={() => setUpload({ id: c.id, file: null, decimal: "," })}>Fiyat listesi yükle</button> : null}
              </td>
            </tr>
          ))}</tbody>
        </table>
        <p className="muted" style={{ margin: 0 }}>Önbellek süresi dolan teklif "eski" görünür; test modunda istek üzerine yenilenir (günlük kotaya tabi). Fiyat dosyası yenilenmez; yeni dosya yüklenir. Otomatik RFQ teklifi için bağlayıcı bir tedarikçiye bağlanmalıdır.</p>
      </section>
      {edit ? (
        <section className="card">
          <h2>{edit.name}</h2>
          <form className="row" style={{ flexWrap: "wrap" }} onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
            <label className="field">Mod<select aria-label="Bağlayıcı modu" value={edit.mode} onChange={(e) => setEdit({ ...edit, mode: e.target.value })}><option value="not_connected">Bağlı değil</option><option value="test">TEST (sentetik katalog)</option><option value="price_file">Fiyat dosyası</option></select></label>
            <label className="field">Tedarikçi<select aria-label="Bağlı tedarikçi" value={edit.supplierId} onChange={(e) => setEdit({ ...edit, supplierId: e.target.value })}><option value="">—</option>{sup.data?.map((s) => <option key={s.id} value={s.id}>{s.code} — {s.name}</option>)}</select></label>
            <label className="field" style={{ width: 130 }}>Önbellek (dk)<input inputMode="numeric" value={edit.cacheTtlMinutes} onChange={(e) => setEdit({ ...edit, cacheTtlMinutes: e.target.value })} /></label>
            <label className="field" style={{ width: 130 }}>Günlük kota<input aria-label="Günlük kota" inputMode="numeric" value={edit.dailyCallLimit} onChange={(e) => setEdit({ ...edit, dailyCallLimit: e.target.value })} /></label>
            <label className="field" style={{ width: 80 }}>Para<input value={edit.currency} onChange={(e) => setEdit({ ...edit, currency: e.target.value.toUpperCase() })} /></label>
            <label className="field" style={{ flex: 1 }}>Gerekçe<input aria-label="Bağlayıcı gerekçesi" required minLength={3} value={edit.reason} onChange={(e) => setEdit({ ...edit, reason: e.target.value })} /></label>
            <button className="primary" style={{ alignSelf: "flex-end" }}>Kaydet</button><button type="button" style={{ alignSelf: "flex-end" }} onClick={() => setEdit(null)}>Vazgeç</button>
          </form>
          <ErrorNotice error={save.error} />
        </section>
      ) : null}
      {upload ? (
        <section className="card">
          <h2>Fiyat listesi yükle</h2>
          <p className="muted" style={{ margin: 0 }}>CSV sütunları: <span className="mono">mpn</span> (zorunlu), <span className="mono">manufacturer, sku, stock, moq, lead_time_days, lifecycle</span> ve fiyat kırılımları <span className="mono">price_1, price_10, price_100…</span> (başlıktaki sayı adet).</p>
          <div className="row">
            <input aria-label="Fiyat listesi dosyası" type="file" accept=".csv,.txt" onChange={async (e) => { const f = e.target.files?.[0]; setUpload({ ...upload, file: f ? { name: f.name, content: await f.text() } : null }); }} />
            <label className="field" style={{ width: 130 }}>Ondalık<select value={upload.decimal} onChange={(e) => setUpload({ ...upload, decimal: e.target.value })}><option value=",">virgül</option><option value=".">nokta</option></select></label>
            <button className="primary" disabled={!upload.file || up.isPending} onClick={() => up.mutate()}>Yükle</button>
            <button onClick={() => { setUpload(null); up.reset(); }}>Kapat</button>
          </div>
          <ErrorNotice error={up.error} />
          {up.data ? <div className="notice">{up.data.saved}/{up.data.total} satır kaydedildi ({up.data.ref}).{up.data.errors.length ? <ul>{up.data.errors.map((x: string) => <li key={x}>{x}</li>)}</ul> : null}</div> : null}
        </section>
      ) : null}
    </>
  );
}

/** Kalem teklifleri (RFQ sayfası vb.). */
export function ItemOffers({ itemId, qty }: { itemId: string; qty: number }) {
  const qc = useQueryClient();
  const [refresh, setRefresh] = useState(false);
  const q = useQuery({ queryKey: ["offers", itemId, qty, refresh], queryFn: () => get<any>(`/api/items/${itemId}/offers?qty=${qty}${refresh ? "&refresh=1" : ""}`) });
  const d = q.data;
  return (
    <section className="card">
      <div className="row between">
        <h2 style={{ margin: 0 }}>Distribütör teklifleri</h2>
        <button onClick={() => { setRefresh(true); qc.invalidateQueries({ queryKey: ["offers", itemId] }); }}>Yenile</button>
      </div>
      {q.isLoading ? <Loading /> : <ErrorNotice error={q.error} />}
      {d?.warnings.map((w: string) => <div key={w} className="notice warn">{w}</div>)}
      {d && d.connectorsActive === 0 ? <Empty>Aktif distribütör bağlayıcısı yok (Satın alma › Distribütörler).</Empty> : null}
      {d?.offers.length ? (
        <table>
          <thead><tr><th>Distribütör</th><th>SKU</th><th className="num">Stok</th><th className="num">MOQ</th><th className="num">Temin</th><th>Yaşam döngüsü</th><th className="num">Birim ({qty} ad.)</th><th>Kaynak</th><th>Alınma</th></tr></thead>
          <tbody>{d.offers.map((o: any) => (
            <tr key={o.connectorId}>
              <td>{o.connector}</td><td className="mono">{o.sku ?? "—"}</td><td className="num">{num(o.stock, 0)}</td><td className="num">{num(o.moq, 0)}</td><td className="num">{o.leadTimeDays ?? "—"} g</td>
              <td>{o.lifecycle && o.lifecycle !== "active" ? <span className="badge bad">{o.lifecycle.toUpperCase()}</span> : o.lifecycle ?? "—"}</td>
              <td className="num">{o.unitPrice !== null ? `${num(o.unitPrice)} ${o.currency}` : <span className="muted">gizli</span>}</td>
              <td>{o.testData ? <span className="badge mode warn">TEST VERİSİ</span> : <span className="muted">{o.sourceRef}</span>}</td>
              <td className="muted">{fmtDate(o.fetchedAt)} {o.stale ? <span className="badge warn">eski</span> : null}</td>
            </tr>
          ))}</tbody>
        </table>
      ) : d && d.connectorsActive > 0 ? <Empty>Teklif bulunamadı.</Empty> : null}
    </section>
  );
}

/** BOM tedarik görünümü (Ürün sayfası). */
export function BomSourcing({ bomId }: { bomId: string }) {
  const [qty, setQty] = useState("100");
  const [run, setRun] = useState<number | null>(null);
  const q = useQuery({ queryKey: ["sourcing", bomId, run], queryFn: () => get<any>(`/api/boms/${bomId}/sourcing?qty=${run}`), enabled: run !== null });
  const d = q.data;
  return (
    <section className="card">
      <div className="row between">
        <h2 style={{ margin: 0 }}>Tedarik görünümü</h2>
        <div className="row">
          <label className="row" style={{ gap: 6 }}>Adet <input aria-label="Tedarik adedi" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ""))} style={{ width: 90 }} /></label>
          <button onClick={() => setRun(Number(qty) || 1)}>Hesapla</button>
        </div>
      </div>
      {q.isLoading && run !== null ? <Loading /> : <ErrorNotice error={q.error} />}
      {d ? (
        <>
          {d.testData ? <div className="notice warn">Bazı teklifler <b>TEST VERİSİ</b> (sentetik katalog) — gerçek fiyat/stok değildir.</div> : null}
          {d.warnings.map((w: string) => <div key={w} className="notice warn">{w}</div>)}
          <table>
            <thead><tr><th>Kalem</th><th className="num">Brüt</th><th className="num">Serbest stok</th><th className="num">Alınacak</th><th>En iyi teklif</th><th className="num">Tutar</th><th>Risk</th></tr></thead>
            <tbody>{d.lines.map((l: any) => (
              <tr key={l.itemId}>
                <td><span className="mono">{l.code}</span><div className="muted">{l.mpn ?? "MPN yok"}</div></td>
                <td className="num">{num(l.gross, 2)}</td><td className="num">{num(l.free, 2)}</td><td className="num"><b>{num(l.toBuy, 2)}</b></td>
                <td>{l.best ? <>{l.best.connector} · stok {num(l.best.stock, 0)} · {l.best.leadTimeDays ?? "?"} g {l.best.testData ? <span className="badge mode warn">TEST</span> : null}</> : l.toBuy > 0 ? "—" : <span className="muted">stoktan</span>}</td>
                <td className="num">{l.best?.total != null ? `${num(l.best.total, 2)} ${l.best.currency}` : "—"}</td>
                <td>{l.risks.map((r: string) => <span key={r} className="badge bad" style={{ marginRight: 4 }}>{r}</span>)}</td>
              </tr>
            ))}</tbody>
          </table>
          {d.totals ? <p style={{ margin: 0 }}>Tahmini alım: {Object.entries(d.totals).map(([c, v]) => `${num(v as number, 2)} ${c}`).join(" + ") || "—"} <span className="muted">· {d.note}</span></p> : null}
        </>
      ) : <p className="muted" style={{ margin: 0 }}>Adet girip hesaplayın: stok, distribütör teklifleri ve yaşam döngüsü riskleri.</p>}
    </section>
  );
}
