import { useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SalesOrder } from "@apisfactory/shared";
import { get, newKey, openDownload, post } from "../lib/api";
import { AddCustomConnector, ConnectorCredentialsForm, ENV_LABEL, MODE_LABEL, ModeBadge, ModeOptions, AdapterBadge } from "../components/Connectors";
import { Empty, ErrorNotice, Loading, PageHeader, StateBadge, fmt, fmtDate, useCan, NeedRole } from "../lib/ui";
import { Barcode } from "../lib/Barcode";
import { History } from "./Sales";

const CHECK: [string, string][] = [["box", "Kutu / ambalaj"], ["accessories", "Aksesuar ve evrak"], ["label", "Ürün / seri etiketi"], ["inspection", "Son görsel kontrol"]];
const PROBLEM: Record<string, string> = { damage: "Hasarlı teslim", not_delivered: "Teslim edilemedi", wrong_address: "Yanlış adres", other: "Diğer" };

export function addressText(a: any) {
  if (!a) return "—";
  return [a.recipient, a.line1, a.line2, [a.district, a.city].filter(Boolean).join(" / "), a.postalCode, a.country !== "TR" ? a.country : null].filter(Boolean).join(", ");
}

/** Sipariş ekranı: teslim adresi, kısmi teslim izni, sevk edilebilir miktar ve sevkiyat hazırlığı. */
export function OrderDelivery({ order }: { order: SalesOrder & { customerId: string } }) {
  const can = useCan();
  const nav = useNavigate();
  const qc = useQueryClient();
  const st = useQuery({ queryKey: ["shippable", order.id], queryFn: () => get<any>(`/api/sales-orders/${order.id}/shippable`) });
  const addrs = useQuery({ queryKey: ["addresses", order.customerId], queryFn: () => get<any[]>(`/api/customers/${order.customerId}/addresses`) });
  const list = useQuery({ queryKey: ["shipments", order.id], queryFn: () => get<any[]>(`/api/sales-orders/${order.id}/shipments`), enabled: can("shipment.view") });
  const refresh = () => ["shippable", "addresses", "shipments", "history"].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  const act = useMutation({ mutationFn: (f: () => Promise<unknown>) => f(), onSuccess: refresh });
  const [qty, setQty] = useState<Record<string, string>>({});
  const [key, setKey] = useState(newKey());
  const [adding, setAdding] = useState(false);
  const create = useMutation({
    mutationFn: () =>
      post<any>(`/api/sales-orders/${order.id}/shipments`, {
        lines: Object.entries(qty).filter(([, q]) => q && Number(q) > 0).map(([lineId, q]) => ({ lineId, qty: q })),
      }, { "idempotency-key": key }),
    onSuccess: (s) => { setKey(newKey()); refresh(); nav(`/shipments/${s.id}`); },
  });
  const s = st.data;
  const active = (addrs.data ?? []).filter((a) => a.active);
  const current = active.find((a) => a.id === s?.deliveryAddressId) ?? active.find((a) => a.isDefault);
  return (
    <section className="card">
      <div className="row between">
        <h2>Teslimat ve sevkiyat</h2>
        {s ? <StateBadge value={s.status} /> : null}
      </div>
      <ErrorNotice error={act.error ?? st.error} />
      <div className="row" style={{ alignItems: "flex-end" }}>
        <label className="field" style={{ flex: 1 }}>Teslim adresi
          <select disabled={!can("sales.create") || !s || ["shipped", "cancelled"].includes(s.status)} value={current?.id ?? ""}
            onChange={(e) => { const addressId = e.target.value; act.mutate(() => post(`/api/sales-orders/${order.id}/delivery`, { addressId })); }}>
            <option value="" disabled>{active.length ? "Seçin" : "Kayıtlı adres yok"}</option>
            {active.map((a) => <option key={a.id} value={a.id}>{a.label}{a.isDefault ? " (varsayılan)" : ""} — {addressText(a)}</option>)}
          </select>
        </label>
        <label className="row" style={{ gap: 6 }}>
          <input type="checkbox" style={{ minHeight: 0 }} disabled={!can("sales.create") || !s} checked={!!s?.allowPartial}
            onChange={(e) => { const allowPartial = e.target.checked; act.mutate(() => post(`/api/sales-orders/${order.id}/delivery`, { allowPartial })); }} />
          Kısmi teslim kabul
        </label>
        {can("customer.address.manage") ? <button onClick={() => setAdding(!adding)}>Adres ekle</button> : null}
      </div>
      {adding ? <AddressForm customerId={order.customerId} onDone={() => { setAdding(false); refresh(); }} /> : null}
      {s ? (
        <table>
          <thead><tr><th>Ürün</th><th className="num">Sipariş</th><th className="num">Sevk edilen</th><th className="num">Hazırlıkta</th><th className="num">Hazır (ayrılmış)</th><th className="num">Şimdi sevk edilebilir</th>{can("shipment.create") ? <th>Bu sevkiyata</th> : null}</tr></thead>
          <tbody>
            {s.lines.map((l: any) => (
              <tr key={l.lineId}>
                <td className="mono">{l.productCode} Rev.{l.rev}</td><td className="num">{fmt(l.ordered)}</td><td className="num">{fmt(l.shipped)}</td>
                <td className="num">{fmt(l.inOpen)}</td><td className="num">{fmt(l.ready)}</td><td className="num"><b>{fmt(l.shippableNow)}</b></td>
                {can("shipment.create") ? (
                  <td><input aria-label={`${l.productCode} sevk miktarı`} inputMode="decimal" style={{ width: 90 }} value={qty[l.lineId] ?? ""} placeholder={l.shippableNow}
                    disabled={Number(l.shippableNow) === 0} onChange={(e) => setQty({ ...qty, [l.lineId]: e.target.value })} /></td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      ) : <Loading />}
      {can("shipment.create") && s?.status === "firm" ? (
        <div className="row">
          <button className="primary" disabled={create.isPending || !Object.values(qty).some((q) => Number(q) > 0)} onClick={() => create.mutate()}>Sevkiyat hazırla</button>
          <span className="muted">Yalnızca satıra ayrılmış ve son kaliteden geçmiş ürün. {s.allowPartial ? "" : "Kısmi teslim kapalı: kalanın tamamı birlikte gider."}</span>
        </div>
      ) : null}
      <ErrorNotice error={create.error} />
      {list.data?.length ? (
        <table>
          <thead><tr><th>Sevkiyat</th><th className="num">Miktar</th><th>Durum</th><th>Kargo / takip</th><th>Sevk</th></tr></thead>
          <tbody>
            {list.data.map((x) => (
              <tr key={x.id} className="click" onClick={() => nav(`/shipments/${x.id}`)}>
                <td className="mono">{x.code}</td><td className="num">{fmt(x.qty)}</td><td><StateBadge value={x.status} prefix="sh" /></td>
                <td>{x.carrier ?? "—"} {x.trackingNo ? <span className="mono">{x.trackingNo}</span> : null}</td><td className="muted">{fmtDate(x.shippedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

function AddressForm({ customerId, onDone }: { customerId: string; onDone: () => void }) {
  const [f, setF] = useState({ label: "", recipient: "", phone: "", line1: "", line2: "", district: "", city: "", postalCode: "", isDefault: false });
  const save = useMutation({
    mutationFn: () => post(`/api/customers/${customerId}/addresses`, Object.fromEntries(Object.entries(f).filter(([, v]) => v !== ""))),
    onSuccess: onDone,
  });
  const inp = (k: keyof typeof f, label: string, req = false, width?: number) => (
    <label className="field" style={width ? { width } : { flex: 1 }}>{label}<input required={req} value={f[k] as string} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></label>
  );
  return (
    <form className="stack" onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
      <div className="row">{inp("label", "Ad (ör. Merkez)", true, 160)}{inp("recipient", "Teslim alan", true)}{inp("phone", "Telefon", false, 170)}</div>
      <div className="row">{inp("line1", "Adres", true)}{inp("line2", "Adres 2")}</div>
      <div className="row">
        {inp("district", "İlçe", false, 160)}{inp("city", "İl", true, 160)}{inp("postalCode", "Posta kodu", false, 120)}
        <label className="row" style={{ gap: 6, alignSelf: "flex-end" }}><input type="checkbox" style={{ minHeight: 0 }} checked={f.isDefault} onChange={(e) => setF({ ...f, isDefault: e.target.checked })} /> Varsayılan</label>
        <button className="primary" style={{ alignSelf: "flex-end" }} disabled={save.isPending}>Kaydet</button>
      </div>
      <ErrorNotice error={save.error} />
      <p className="muted" style={{ margin: 0 }}>Adres düzenlenmez; yanlışsa pasife alınıp yenisi eklenir. Sevk edilmiş belgeler sevk anındaki adresi saklar.</p>
    </form>
  );
}

export function ShipmentsPage() {
  const nav = useNavigate();
  const can = useCan();
  const [status, setStatus] = useState("");
  const q = useQuery({ queryKey: ["allShipments", status], queryFn: () => get<any[]>(`/api/shipments${status ? `?status=${status}` : ""}`) });
  return (
    <>
      <PageHeader title="Sevkiyat" sub="Hazırlık → paketleme (okutma ve kontrol listesi) → sevk → teslim. Kargo firmasına istek gönderilmez; irsaliye TASLAK." actions={
        <>
          {can("shipment.create") ? <Link className="btn" to="/shipments/cargo-connectors">Kargo bağlayıcıları</Link> : null}
          <select aria-label="Durum filtresi" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Tümü</option>
            {["preparing", "packed", "shipped", "delivered", "problem", "cancelled"].map((s) => <option key={s} value={s}>{SH_LABEL[s]}</option>)}
          </select>
        </>
      } />
      <section className="card">
        {q.isLoading ? <Loading /> : <ErrorNotice error={q.error} />}
        {q.data?.length === 0 ? <Empty>Sevkiyat yok. Kesin siparişin ekranından hazırlanır.</Empty> : null}
        {q.data && q.data.length > 0 ? (
          <table>
            <thead><tr><th>Sevkiyat</th><th>Sipariş</th><th>Müşteri</th><th className="num">Miktar</th><th className="num">Paket</th><th>Durum</th><th>Takip</th><th>Oluşturma</th></tr></thead>
            <tbody>
              {q.data.map((s) => (
                <tr key={s.id} className="click" onClick={() => nav(`/shipments/${s.id}`)}>
                  <td className="mono">{s.code}</td><td className="mono">{s.salesOrderCode}</td><td>{s.customerName}</td><td className="num">{fmt(s.qty)}</td>
                  <td className="num">{s.packages}</td><td><StateBadge value={s.status} prefix="sh" /></td><td className="mono">{s.trackingNo ?? "—"}</td><td className="muted">{fmtDate(s.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>
    </>
  );
}

export const SH_LABEL: Record<string, string> = { preparing: "Hazırlanıyor", packed: "Paketlendi", shipped: "Sevk edildi", delivered: "Teslim edildi", problem: "Teslim sorunu", cancelled: "İptal" };

/**
 * W36 + oturum 41 — kargo bağlayıcıları. Firmalar arasında değişen şey (erişim bilgisi alanları, firmaya özel ayarlar,
 * etiket biçimi, takip kodları) adaptördedir; bu ekran her firma için aynıdır. CANLI mod yalnız adaptörü olan firmada açılır.
 */
export function CargoConnectorsPage() {
  const can = useCan();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["cargoConnectors"], queryFn: () => get<any[]>("/api/cargo-connectors") });
  const [edit, setEdit] = useState<any | null>(null);
  const done = () => { setEdit(null); qc.invalidateQueries({ queryKey: ["cargoConnectors"] }); };
  const save = useMutation({
    mutationFn: () => post(`/api/cargo-connectors/${edit.id}`, { mode: edit.mode, note: edit.note || null, reason: edit.reason }),
    onSuccess: done,
  });
  return (
    <>
      <PageHeader title="Kargo bağlayıcıları" sub="Kargo firması seçimi şirket kararıdır. TEST modu sentetik takip no üretir, firmaya hiçbir şey iletilmez. ELLE modu her firmayla çalışır: kaydı firmanın kendi sisteminde açar, takip no'yu buraya girersiniz. CANLI mod, yalnız gerçek bağlantısı geliştirilip firmanın test ortamında doğrulanmış firmalarda açılır." />
      <p style={{ marginTop: 0 }}><Link to="/shipments">← Sevkiyat</Link> · Gönderici adresi ve telefonu: <Link to="/receivables/einvoice-connectors">şirket bilgileri</Link></p>
      <NeedRole perm="shipment.create" what="Kargo bağlayıcılarını ayarlamak" />
      <section className="card">
        <table>
          <thead><tr><th>Kargo firması</th><th>Mod</th><th>Gerçek bağlantı</th><th>Erişim bilgisi</th><th>Ayarlar</th><th /></tr></thead>
          <tbody>{q.data?.map((c: any) => (
            <tr key={c.id}>
              <td>{c.name}{c.isCustom ? <span className="muted"> (eklenen)</span> : null}{c.note ? <div className="muted" style={{ fontSize: 13 }}>{c.note}</div> : null}</td>
              <td><ModeBadge mode={c.mode} /></td>
              <td>{c.adapterAvailable ? <AdapterBadge c={c} extra={c.trackingSupported ? " · takip" : ""} /> : <span className="muted">geliştirilmedi</span>}</td>
              <td>{c.hasCredentials ? <>kayıtlı · {ENV_LABEL[c.environment] ?? c.environment}</> : <span className="muted">yok</span>}</td>
              <td className="muted">{Object.keys(c.settings ?? {}).length ? Object.entries(c.settings).map(([k, v]) => `${k}: ${v}`).join(", ") : "—"}</td>
              <td>{can("shipment.create") ? <button onClick={() => setEdit({ ...c, reason: "" })}>Ayarla</button> : null}</td>
            </tr>
          ))}</tbody>
        </table>
        {can("shipment.create") ? <AddCustomConnector basePath="/api/cargo-connectors" queryKey="cargoConnectors" label="kargo firması" /> : null}
      </section>
      {q.isLoading ? <Loading /> : <ErrorNotice error={q.error} />}
      {edit ? (
        <section className="card">
          <h3>{edit.name}</h3>
          <ErrorNotice error={save.error} />
          <div className="row" style={{ alignItems: "flex-end" }}>
            <label className="field">Mod
              <select aria-label="Bağlayıcı modu" value={edit.mode} onChange={(e) => setEdit({ ...edit, mode: e.target.value })}>
                <ModeOptions c={edit} kind="cargo" />
              </select>
            </label>
            <label className="field" style={{ flex: 1 }}>Not<input value={edit.note ?? ""} onChange={(e) => setEdit({ ...edit, note: e.target.value })} /></label>
            <label className="field" style={{ flex: 1 }}>Gerekçe<input aria-label="Bağlayıcı gerekçesi" value={edit.reason} onChange={(e) => setEdit({ ...edit, reason: e.target.value })} /></label>
            <button className="primary" disabled={edit.reason.trim().length < 3 || save.isPending} onClick={() => save.mutate()}>Kaydet</button>
            <button onClick={() => setEdit(null)}>Vazgeç</button>
          </div>
          <TrackingUrlForm connector={edit} onSaved={done} />
          <CargoSettingsForm connector={edit} onSaved={done} />
          <ConnectorCredentialsForm basePath="/api/cargo-connectors" connector={edit} onSaved={done} />
        </section>
      ) : null}
    </>
  );
}

/** Firmanın herkese açık takip sayfası: şirket kendisi girer ({no} takip no ile değişir); sevkiyatta bağlantı olarak görünür. */
function TrackingUrlForm({ connector: c, onSaved }: { connector: any; onSaved: () => void }) {
  const [template, setTemplate] = useState<string>(c.trackingUrlTemplate ?? "");
  const [reason, setReason] = useState("");
  const save = useMutation({ mutationFn: () => post(`/api/cargo-connectors/${c.id}/tracking-url`, { template: template.trim() || null, reason }), onSuccess: onSaved });
  return (
    <div className="stack" style={{ marginTop: 12 }}>
      <h4 style={{ margin: 0 }}>Takip sayfası</h4>
      <p className="muted" style={{ margin: 0 }}>Firmanın web sitesindeki gönderi sorgulama adresi; takip no yerine <span className="mono">{"{no}"}</span> yazın. Boş bırakılırsa bağlantı gösterilmez.</p>
      <ErrorNotice error={save.error} />
      <div className="row" style={{ alignItems: "flex-end", flexWrap: "wrap" }}>
        <label className="field" style={{ flex: 2 }}>Adres şablonu<input aria-label="Takip adresi şablonu" placeholder="https://…?takipno={no}" value={template} onChange={(e) => setTemplate(e.target.value)} /></label>
        <label className="field" style={{ flex: 1 }}>Gerekçe<input aria-label="Takip adresi gerekçesi" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        <button disabled={reason.trim().length < 3 || save.isPending} onClick={() => save.mutate()}>Kaydet</button>
      </div>
    </div>
  );
}

/** Firmaya özel, gizli olmayan ayarlar. Adaptör alanları tanımlıysa (seçenekli) onlar; değilse serbest anahtar/değer. */
function CargoSettingsForm({ connector: c, onSaved }: { connector: any; onSaved: () => void }) {
  const fields: { key: string; label: string; options?: string[]; required?: boolean }[] | null = c.settingFields;
  const [values, setValues] = useState<Record<string, string>>({ ...(c.settings ?? {}) });
  const [newKeyName, setNewKeyName] = useState("");
  const [reason, setReason] = useState("");
  const save = useMutation({ mutationFn: () => post(`/api/cargo-connectors/${c.id}/settings`, { settings: Object.fromEntries(Object.entries(values).filter(([, v]) => v !== "")), reason }), onSuccess: onSaved });
  const keys = fields ? fields.map((f) => f.key) : Object.keys(values);
  return (
    <div className="stack" style={{ marginTop: 12 }}>
      <h4 style={{ margin: 0 }}>Firma ayarları</h4>
      <p className="muted" style={{ margin: 0 }}>Gizli olmayan, firmaya özel yapılandırma (ör. servis tipi, ödeme tipi). Ekranda görünür ve değişiklik geçmişine yazılır.</p>
      <ErrorNotice error={save.error} />
      <div className="row" style={{ alignItems: "flex-end", flexWrap: "wrap" }}>
        {keys.map((k) => {
          const f = fields?.find((x) => x.key === k);
          return (
            <label key={k} className="field">{f?.label ?? k}{f?.required ? " *" : ""}
              {f?.options ? (
                <select aria-label={`Ayar ${k}`} value={values[k] ?? ""} onChange={(e) => setValues({ ...values, [k]: e.target.value })}>
                  <option value="">—</option>{f.options.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : <input aria-label={`Ayar ${k}`} value={values[k] ?? ""} onChange={(e) => setValues({ ...values, [k]: e.target.value })} />}
            </label>
          );
        })}
        {!fields ? (
          <div className="row" style={{ gap: 6 }}>
            <input aria-label="Yeni ayar adı" placeholder="yeni ayar adı" value={newKeyName} onChange={(e) => setNewKeyName(e.target.value)} />
            <button type="button" disabled={!newKeyName.trim()} onClick={() => { setValues({ ...values, [newKeyName.trim()]: "" }); setNewKeyName(""); }}>+ ayar</button>
          </div>
        ) : null}
        <label className="field" style={{ flex: 1 }}>Gerekçe<input aria-label="Ayar gerekçesi" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        <button disabled={reason.trim().length < 3 || save.isPending} onClick={() => save.mutate()}>Ayarları kaydet</button>
      </div>
    </div>
  );
}

/** Sonucu belirsiz kargo kaydı: otomatik tekrar yok (çift ücretli kayıt riski); kullanıcı firma panelinden doğrular. */
function CargoResolve({ id, error, manage, onDone }: { id: string; error: string | null; manage: boolean; onDone: () => void }) {
  const [trackingNo, setTrackingNo] = useState("");
  const [reason, setReason] = useState("");
  const m = useMutation({ mutationFn: (body: object) => post(`/api/shipments/${id}/cargo-resolve`, body), onSuccess: onDone });
  return (
    <section className="card">
      <div className="notice warn" style={{ margin: 0 }}>
        Kargo kaydının sonucu <b>belirsiz</b> ({error}). Kayıt firmada oluşmuş olabilir; çift ücretli kayıt riski nedeniyle sistem otomatik yeniden denemez. Firma panelinden kontrol edip sonucu işaretleyin.
      </div>
      {manage ? (
        <div className="row" style={{ flexWrap: "wrap", alignItems: "flex-end" }}>
          <label className="field" style={{ flex: 1, minWidth: 220 }}>Gerekçe / kontrol notu<input aria-label="Kargo çözüm gerekçesi" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          <label className="field" style={{ width: 200 }}>Panelde görülen takip no<input aria-label="Takip no" value={trackingNo} onChange={(e) => setTrackingNo(e.target.value.trim())} /></label>
          <button disabled={reason.trim().length < 3 || trackingNo.length < 3 || m.isPending} onClick={() => m.mutate({ outcome: "created", trackingNo, reason })}>Kayıt oluşmuş</button>
          <button disabled={reason.trim().length < 3 || m.isPending} onClick={() => m.mutate({ outcome: "not_created", reason })}>Kayıt oluşmamış</button>
        </div>
      ) : null}
      <ErrorNotice error={m.error} />
    </section>
  );
}

const CARGO_STATUS_LABEL: Record<string, string> = { created: "kayıt açıldı", in_transit: "yolda", out_for_delivery: "dağıtımda", delivered: "teslim edildi", returned: "iade", problem: "sorun", unknown: "bilinmiyor" };
const LABEL_EXT: Record<string, string> = { "application/pdf": "pdf", "application/zpl": "zpl", "image/png": "png" };

export function ShipmentPage() {
  const { id } = useParams();
  const can = useCan();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["shipment", id], queryFn: () => get<any>(`/api/shipments/${id}`) });
  const refresh = () => { qc.invalidateQueries({ queryKey: ["shipment", id] }); qc.invalidateQueries({ queryKey: ["history"] }); };
  const act = useMutation({ mutationFn: (f: () => Promise<unknown>) => f(), onSuccess: refresh });
  const [shipForm, setShipForm] = useState({ carrier: "", trackingNo: "" });
  const [shipKey] = useState(newKey());
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState({ kind: "damage", note: "" });
  const [tracking, setTracking] = useState("");
  const [cargoConnectorId, setCargoConnectorId] = useState("");
  const [manualTracking, setManualTracking] = useState("");
  const [manualStatus, setManualStatus] = useState({ status: "in_transit", note: "" });
  const needsLabel = can("shipment.create") && !q.data?.trackingNo && ["preparing", "packed"].includes(q.data?.status) && !["queued", "sending", "unknown"].includes(q.data?.cargoRequestStatus);
  const cargoQ = useQuery({ queryKey: ["cargoConnectors"], queryFn: () => get<any[]>("/api/cargo-connectors"), enabled: needsLabel });
  const readyQ = useQuery({ queryKey: ["cargoReadiness", id, q.data?.status, q.data?.packages?.length], queryFn: () => get<any>(`/api/shipments/${id}/cargo-readiness`), enabled: needsLabel });
  const selectedCargo = cargoQ.data?.find((c: any) => c.id === cargoConnectorId);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNotice error={q.error} />;
  const s = q.data;
  const edit = can("shipment.create") && s.status === "preparing";
  return (
    <>
      <PageHeader
        title={`Sevkiyat ${s.code}`}
        sub={<>{s.customerName} · sipariş <Link to={`/sales/${s.salesOrderId}`}>{s.salesOrderCode}</Link> · <Link to="/shipments">← Sevkiyat</Link></>}
        actions={<><StateBadge value={s.status} prefix="sh" /><span className="badge mode">TASLAK BELGE</span><Link className="btn" to={`/shipments/${s.id}/print`}>Etiket ve irsaliye taslağı</Link></>}
      />
      <ErrorNotice error={act.error} />
      <section className="card">
        <div className="grid4">
          <div className="stat"><small>Teslim adresi {s.addressSnapshot ? "(sevk anındaki)" : ""}</small><b style={{ fontSize: 15 }}>{s.address?.label}</b><small>{addressText(s.address)}</small></div>
          <div className="stat"><small>Kargo / takip</small><b style={{ fontSize: 15 }}>{s.carrier ?? "—"}</b><small className="mono">{s.trackingNo ?? ""}{s.cargoLabelMode ? <span style={{ marginLeft: 6 }}><ModeBadge mode={s.cargoLabelMode} /></span> : null}</small></div>
          <div className="stat"><small>Sevk</small><b style={{ fontSize: 15 }}>{fmtDate(s.shippedAt)}</b><small>{s.shippedBy ?? ""}</small></div>
          <div className="stat"><small>Teslim</small><b style={{ fontSize: 15 }}>{fmtDate(s.deliveredAt)}</b><small>{s.problemNote ?? ""}</small></div>
        </div>
        <table>
          <thead><tr><th>Ürün</th><th className="num">Sevkiyat</th><th className="num">Paketlenen</th><th /></tr></thead>
          <tbody>{s.lines.map((l: any) => <tr key={l.id}><td className="mono">{l.productCode} Rev.{l.rev} <span className="muted">{l.productName}</span></td><td className="num">{fmt(l.qty)}</td><td className="num">{fmt(l.packed)}</td><td>{l.complete ? <span className="badge ok">Tamam</span> : <span className="badge warn">Eksik</span>}</td></tr>)}</tbody>
        </table>
      </section>

      {edit && s.pickList.length ? (
        <section className="card">
          <h2>Toplama listesi</h2>
          <table>
            <thead><tr><th>Lot</th><th className="num">Satıra ayrılmış</th><th>Paketlenmemiş seriler</th></tr></thead>
            <tbody>{s.pickList.map((p: any) => <tr key={p.lineId + p.lotNo}><td className="mono">{p.lotNo}</td><td className="num">{fmt(p.reservedQty)}</td><td className="mono">{p.serials.length ? p.serials.join(", ") : <span className="muted">serisiz lot — lot numarası + miktar okutun</span>}</td></tr>)}</tbody>
          </table>
        </section>
      ) : null}

      <section className="card">
        <div className="row between">
          <h2>Paketler</h2>
          {edit ? (
            <div className="row">
              <button onClick={() => act.mutate(() => post(`/api/shipments/${id}/packages`))}>Paket ekle</button>
              <button className="primary" onClick={() => act.mutate(() => post(`/api/shipments/${id}/pack-complete`))}>Paketlemeyi tamamla</button>
            </div>
          ) : null}
        </div>
        {s.packages.map((p: any) => <PackageCard key={p.id} p={p} edit={edit} onDone={refresh} />)}
      </section>

      {["queued", "sending"].includes(s.cargoRequestStatus) ? <div className="notice info">Kargo kaydı arka planda açılıyor ({s.cargoConnector}) — firma yanıtı gelince takip no ve etiket burada görünür.</div> : null}
      {s.cargoRequestStatus === "failed" && !s.trackingNo ? <div className="notice bad">Son kargo kaydı firma tarafından reddedildi (kayıt oluşmadı): {s.cargoRequestError}. Düzeltip yeniden deneyebilirsiniz.</div> : null}
      {s.cargoRequestStatus === "unknown" ? <CargoResolve id={id!} error={s.cargoRequestError} manage={can("shipment.create")} onDone={refresh} /> : null}

      {needsLabel ? (
        <section className="card">
          <h2>Kargo etiketi</h2>
          <p className="muted" style={{ margin: 0 }}>TEST modundaki bağlayıcı sentetik takip no üretir (firmaya iletilmez); ELLE modunda kaydı firmanın kendi sisteminde açıp takip no'yu girersiniz; CANLI bağlayıcı firmada kargo kaydı açar ve gerçek takip no + etiket dosyası alır. İstenirse taşıyıcı aşağıda elle de girilebilir.</p>
          {readyQ.data && !readyQ.data.ready ? (
            <div className="notice warn">
              Kargo kaydı için eksik bilgi{selectedCargo?.mode === "live" ? " — CANLI kayıt bunlar tamamlanmadan açılamaz" : selectedCargo?.mode === "manual" ? " (firmanın sisteminde kayıt açarken gerekir)" : " (TEST etiketini etkilemez)"}:
              <ul style={{ margin: "4px 0 0" }}>{readyQ.data.issues.map((x: any) => <li key={x.field}>{x.message}</li>)}</ul>
            </div>
          ) : readyQ.data?.ready ? <p className="muted" style={{ margin: 0 }}>{readyQ.data.packages} koli{readyQ.data.totalWeightKg ? ` · toplam ${fmt(readyQ.data.totalWeightKg)} kg` : " · ağırlığı girilmemiş koli var"}</p> : null}
          <div className="row">
            <select aria-label="Kargo bağlayıcısı" value={cargoConnectorId} onChange={(e) => setCargoConnectorId(e.target.value)}>
              <option value="">Seçin…</option>
              {cargoQ.data?.map((c: any) => <option key={c.id} value={c.id}>{c.name} ({MODE_LABEL[c.mode]?.[0] ?? c.mode})</option>)}
            </select>
            {selectedCargo?.mode === "manual" ? <input aria-label="Firmanın verdiği takip no" placeholder="Firmanın verdiği takip no" value={manualTracking} onChange={(e) => setManualTracking(e.target.value.trim())} /> : null}
            {selectedCargo?.mode === "manual"
              ? <button disabled={manualTracking.length < 3 || act.isPending} onClick={() => act.mutate(() => post(`/api/shipments/${id}/cargo-label`, { connectorId: cargoConnectorId, trackingNo: manualTracking }))}>Takip no kaydet</button>
              : <button disabled={!cargoConnectorId || act.isPending} onClick={() => act.mutate(() => post(`/api/shipments/${id}/cargo-label`, { connectorId: cargoConnectorId }))}>Etiket üret</button>}
          </div>
        </section>
      ) : null}

      {s.cargoLabelMode ? (
        <section className="card">
          <h2>Kargo kaydı <ModeBadge mode={s.cargoLabelMode} /></h2>
          <p style={{ margin: 0 }}>
            {s.cargoConnector} · takip no {s.trackingUrl ? <a className="mono" href={s.trackingUrl} target="_blank" rel="noopener noreferrer">{s.trackingNo}</a> : <span className="mono">{s.trackingNo}</span>}{s.labelRef ? <> · etiket <span className="mono">{s.labelRef}</span></> : null}
            {s.cargoStatus ? <> · durum <b>{CARGO_STATUS_LABEL[s.cargoStatus] ?? s.cargoStatus}</b>{s.cargoStatusRaw ? <span className="muted"> ({s.cargoStatusRaw})</span> : null} {s.cargoStatusAt ? <span className="muted">{fmtDate(s.cargoStatusAt)}</span> : null}</> : null}
          </p>
          {s.cargoLabelMode === "test" ? <p className="muted" style={{ margin: 0 }}>TEST — sentetik takip no, kargo firmasına iletilmedi.</p> : null}
          {s.cargoLabelMode === "manual" ? (
            <>
              <p className="muted" style={{ margin: 0 }}>ELLE — kayıt firmanın kendi sisteminde açıldı; durumu firmanın takip sayfasından bakıp işaretleyin.</p>
              {can("shipment.create") ? (
                <div className="row" style={{ alignItems: "flex-end", flexWrap: "wrap" }}>
                  <label className="field">Durum
                    <select aria-label="Kargo durumu" value={manualStatus.status} onChange={(e) => setManualStatus({ ...manualStatus, status: e.target.value })}>
                      {["created", "in_transit", "out_for_delivery", "delivered", "returned", "problem"].map((x) => <option key={x} value={x}>{CARGO_STATUS_LABEL[x]}</option>)}
                    </select>
                  </label>
                  <label className="field" style={{ flex: 1 }}>Not (isteğe bağlı)<input aria-label="Kargo durum notu" value={manualStatus.note} onChange={(e) => setManualStatus({ ...manualStatus, note: e.target.value })} /></label>
                  <button disabled={act.isPending} onClick={() => act.mutate(() => post(`/api/shipments/${id}/cargo-status`, { status: manualStatus.status, ...(manualStatus.note.trim() ? { note: manualStatus.note.trim() } : {}) }))}>Durumu kaydet</button>
                </div>
              ) : null}
            </>
          ) : null}
          {s.cargoLabelMode === "live" ? (
            <div className="row">
              {s.hasLabelFile ? <button onClick={() => openDownload(`/api/shipments/${id}/cargo-label-file`, `${s.code}-kargo.${LABEL_EXT[s.labelContentType] ?? "bin"}`, s.labelContentType ?? "")}>Etiketi indir</button> : null}
              <button disabled={act.isPending} onClick={() => act.mutate(() => post(`/api/shipments/${id}/cargo-track`))}>Takip durumunu güncelle</button>
            </div>
          ) : null}
        </section>
      ) : null}

      {can("shipment.create") && s.status === "packed" ? (
        <section className="card">
          <h2>Sevk et</h2>
          <form className="row" onSubmit={(e) => { e.preventDefault(); act.mutate(() => post(`/api/shipments/${id}/ship`, { carrier: shipForm.carrier || undefined, trackingNo: shipForm.trackingNo || undefined }, { "idempotency-key": shipKey })); }}>
            <label className="field">Kargo / taşıyıcı{s.carrier ? <input value={s.carrier} disabled /> : <input required minLength={2} value={shipForm.carrier} onChange={(e) => setShipForm({ ...shipForm, carrier: e.target.value })} />}</label>
            <label className="field">Takip no (isteğe bağlı){s.trackingNo ? <input value={s.trackingNo} disabled /> : <input value={shipForm.trackingNo} onChange={(e) => setShipForm({ ...shipForm, trackingNo: e.target.value })} />}</label>
            <button className="primary" style={{ alignSelf: "flex-end" }}>Sevk et</button>
          </form>
          {!s.carrier ? <p className="muted" style={{ margin: 0 }}>Kargo etiketi üretilmediyse taşıyıcı elle girilir. Adres kontrolü sevk anında yapılır ve belgeye kopyalanır.</p> : null}
        </section>
      ) : null}

      {["shipped", "problem"].includes(s.status) ? (
        <section className="card">
          <h2>Teslim</h2>
          {can("shipment.create") ? (
            <div className="row">
              <input aria-label="Takip numarası" placeholder="Takip numarası" value={tracking} onChange={(e) => setTracking(e.target.value)} />
              <button disabled={tracking.length < 3} onClick={() => act.mutate(() => post(`/api/shipments/${id}/tracking`, { trackingNo: tracking }))}>Takip no kaydet</button>
            </div>
          ) : null}
          {can("shipment.deliver") ? (
            <div className="row">
              <button className="primary" onClick={() => act.mutate(() => post(`/api/shipments/${id}/delivery`, { outcome: "delivered" }))}>Teslim edildi</button>
              <select aria-label="Sorun türü" value={problem.kind} onChange={(e) => setProblem({ ...problem, kind: e.target.value })}>{Object.entries(PROBLEM).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
              <input aria-label="Sorun açıklaması" placeholder="Açıklama" value={problem.note} onChange={(e) => setProblem({ ...problem, note: e.target.value })} style={{ flex: 1 }} />
              <button className="danger" disabled={problem.note.length < 3} onClick={() => act.mutate(() => post(`/api/shipments/${id}/delivery`, { outcome: "problem", ...problem }))}>Sorun kaydet</button>
            </div>
          ) : null}
        </section>
      ) : null}

      {can("shipment.create") && ["preparing", "packed"].includes(s.status) ? (
        <section className="card">
          <div className="row">
            <input aria-label="İptal gerekçesi" placeholder="İptal gerekçesi" value={reason} onChange={(e) => setReason(e.target.value)} style={{ flex: 1 }} />
            <button className="danger" disabled={reason.length < 3} onClick={() => act.mutate(() => post(`/api/shipments/${id}/cancel`, { reason }))}>Sevkiyatı iptal et</button>
          </div>
          <p className="muted" style={{ margin: 0 }}>Stok hareketi yoktur; paketlenen seriler serbest kalır.</p>
        </section>
      ) : null}
      <History entityType="shipment" id={s.id} />
    </>
  );
}

/** Okutma alanı: el terminali/barkod okuyucu Enter gönderir; seri tek adet, lot için miktar alanı kullanılır. */
function PackageCard({ p, edit, onDone }: { p: any; edit: boolean; onDone: () => void }) {
  const [code, setCode] = useState("");
  const [qty, setQty] = useState("");
  const [check, setCheck] = useState<Record<string, boolean>>({});
  const [weight, setWeight] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  const scan = useMutation({
    mutationFn: () => post(`/api/packages/${p.id}/items`, { code: code.trim(), qty: qty || undefined }),
    onSuccess: () => { setCode(""); setQty(""); onDone(); ref.current?.focus(); },
    onError: () => ref.current?.select(),
  });
  const act = useMutation({ mutationFn: (f: () => Promise<unknown>) => f(), onSuccess: onDone });
  const open = edit && !p.closedAt;
  return (
    <div className="card" style={{ background: "var(--surface-2)" }}>
      <div className="row between">
        <div className="row"><h3 className="mono">{p.code}</h3>{p.closedAt ? <span className="badge ok">Kapalı</span> : <span className="badge warn">Açık</span>}{p.weightKg ? <span className="muted">{fmt(p.weightKg)} kg</span> : null}</div>
        <span className="muted">{p.items.length} kalem</span>
      </div>
      {open ? (
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (code.trim()) scan.mutate(); }}>
          <label className="field" style={{ flex: 1 }}>Seri veya lot okut<input ref={ref} autoFocus value={code} onChange={(e) => setCode(e.target.value)} placeholder="Barkod okutun veya yazın, Enter" /></label>
          <label className="field" style={{ width: 110 }}>Miktar (lot)<input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} /></label>
          <button className="primary" style={{ alignSelf: "flex-end" }} disabled={scan.isPending}>Ekle</button>
        </form>
      ) : null}
      <ErrorNotice error={scan.error ?? act.error} />
      {p.items.length ? (
        <table>
          <tbody>{p.items.map((i: any) => (
            <tr key={i.id}><td className="mono">{i.serial ?? `Lot ${i.lotNo}`}</td><td className="mono muted">{i.serial ? i.lotNo : ""}</td><td className="num">{fmt(i.qty)}</td>
              <td>{open ? <button onClick={() => act.mutate(() => post(`/api/package-items/${i.id}/remove`))}>Çıkar</button> : null}</td></tr>
          ))}</tbody>
        </table>
      ) : <Empty>Boş paket.</Empty>}
      {open && p.items.length ? (
        <div className="row">
          {CHECK.map(([k, label]) => (
            <label key={k} className="row" style={{ gap: 6 }}><input type="checkbox" style={{ minHeight: 0 }} checked={!!check[k]} onChange={(e) => setCheck({ ...check, [k]: e.target.checked })} />{label}</label>
          ))}
          <label className="field" style={{ width: 100 }}>kg<input inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value)} /></label>
          <button style={{ alignSelf: "flex-end" }} disabled={CHECK.some(([k]) => !check[k])}
            onClick={() => act.mutate(() => post(`/api/packages/${p.id}/close`, { checklist: Object.fromEntries(CHECK.map(([k]) => [k, !!check[k]])), weightKg: weight ? Number(weight) : undefined }))}>
            Paketi kapat
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Yazdırma: irsaliye TASLAĞI ve paket etiketleri (Code128). Resmî belge değildir. */
export function ShipmentPrintPage() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ["shipment", id], queryFn: () => get<any>(`/api/shipments/${id}`) });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNotice error={q.error} />;
  const s = q.data;
  const total = s.packages.length;
  return (
    <div className="print">
      <div className="row between no-print">
        <Link to={`/shipments/${s.id}`}>← Sevkiyata dön</Link>
        <button className="primary" onClick={() => window.print()}>Yazdır</button>
      </div>
      <section className="sheet">
        <div className="watermark">TASLAK — RESMÎ BELGE DEĞİLDİR</div>
        <div className="row between">
          <div><h2 style={{ margin: 0 }}>Sevk irsaliyesi (taslak)</h2><div className="mono">{s.code}</div></div>
          <Barcode value={s.code} height={40} />
        </div>
        <div className="row" style={{ alignItems: "flex-start", gap: 32 }}>
          <div><small className="muted">Alıcı</small><div><b>{s.customerName}</b></div><div>{addressText(s.address)}</div>{s.address?.phone ? <div>{s.address.phone}</div> : null}</div>
          <div><small className="muted">Sipariş</small><div className="mono">{s.salesOrderCode}</div><small className="muted">Sevk</small><div>{fmtDate(s.shippedAt)}</div></div>
          <div><small className="muted">Taşıyıcı</small><div>{s.carrier ?? "—"}</div><div className="mono">{s.trackingNo ?? ""}</div></div>
        </div>
        <table>
          <thead><tr><th>Ürün</th><th className="num">Miktar</th><th>Seri / lot</th></tr></thead>
          <tbody>
            {s.lines.map((l: any) => (
              <tr key={l.id}>
                <td>{l.productCode} Rev.{l.rev} — {l.productName}</td><td className="num">{fmt(l.qty)}</td>
                <td className="mono" style={{ fontSize: 12 }}>{s.packages.flatMap((p: any) => p.items.filter((i: any) => i.lineId === l.id).map((i: any) => i.serial ?? `${i.lotNo} × ${fmt(i.qty)}`)).join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">{total} koli. e-İrsaliye sağlayıcısı bağlı değildir; bu çıktı yalnızca iç kontrol içindir.</p>
      </section>
      {s.packages.map((p: any) => (
        <section key={p.id} className="sheet label">
          <div className="row between"><b>{s.customerName}</b><b>Koli {p.seq}/{total}</b></div>
          <div>{addressText(s.address)}</div>
          <Barcode value={p.code} height={56} module={2} />
          <div className="mono">{p.code} · {s.salesOrderCode}{p.weightKg ? ` · ${fmt(p.weightKg)} kg` : ""}</div>
          <div className="row" style={{ flexWrap: "wrap", gap: 12 }}>
            {p.items.filter((i: any) => i.serial).map((i: any) => (
              <div key={i.id} style={{ textAlign: "center" }}><Barcode value={i.serial} height={28} module={1} /><div className="mono" style={{ fontSize: 11 }}>{i.serial}</div></div>
            ))}
            {p.items.filter((i: any) => !i.serial).map((i: any) => <div key={i.id} className="mono">Lot {i.lotNo} × {fmt(i.qty)}</div>)}
          </div>
          <div className="watermark small">TASLAK</div>
        </section>
      ))}
    </div>
  );
}
