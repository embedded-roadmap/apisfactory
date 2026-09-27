import { useState } from "react";
import { Link, NavLink, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, newKey, post } from "../lib/api";
import { Empty, ErrorNotice, Loading, PageHeader, fmt, fmtDate, useCan } from "../lib/ui";
import { History } from "./Sales";
import { Discussion } from "../components/Discussion";

const ST: Record<string, [string, string]> = { draft: ["taslak", "warn"], issued: ["kesildi — açık", "warn"], paid: ["tahsil edildi", "ok"], cancelled: ["iptal", ""] };
const today = () => new Date().toISOString().slice(0, 10);
const money = (n: number | null | undefined, c?: string) => (n === null || n === undefined ? "—" : `${fmt(String(n))}${c ? ` ${c}` : ""}`);

function Tabs() {
  const can = useCan();
  return (
    <div className="row tabs" role="tablist">
      <NavLink to="/receivables" end>Müşteri faturaları</NavLink>
      <NavLink to="/receivables/aging">Yaşlandırma & kredi</NavLink>
      {can("receivable.manage") ? <NavLink to="/receivables/einvoice-connectors">E-belge bağlayıcıları</NavLink> : null}
    </div>
  );
}

const MODE_LABEL: Record<string, [string, string]> = { not_connected: ["BAĞLANMADI", ""], test: ["TEST", "warn"], live: ["CANLI", "ok"] };
const ENV_LABEL: Record<string, string> = { sandbox: "test ortamı", production: "üretim" };

/**
 * W36 + oturum 41 — e-fatura/e-arşiv ayarları: şirket ve müşteri vergi kimliği (sağlayıcıdan bağımsız ön koşul),
 * bağlayıcılar ve şifreli erişim bilgisi. CANLI mod yalnız gerçek adaptörü geliştirilmiş sağlayıcıda seçilebilir.
 */
export function EinvoiceConnectorsPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["einvoiceConnectors"], queryFn: () => get<any[]>("/api/einvoice-connectors") });
  const [edit, setEdit] = useState<any | null>(null);
  const save = useMutation({
    mutationFn: () => post(`/api/einvoice-connectors/${edit.id}`, { mode: edit.mode, note: edit.note || null, reason: edit.reason }),
    onSuccess: () => { setEdit(null); qc.invalidateQueries({ queryKey: ["einvoiceConnectors"] }); },
  });
  return (
    <>
      <Header />
      <CompanyTaxProfileCard />
      <CustomerTaxIdentityCard />
      <section className="card">
        <h2>E-belge bağlayıcıları</h2>
        <p className="muted" style={{ margin: 0 }}>Resmi e-fatura/e-arşiv gönderimi bir GİB özel entegratör sözleşmesi gerektirir — sağlayıcı seçimi şirket kararıdır. TEST modu sentetik ETTN üretir, GİB'e hiçbir şey gönderilmez. CANLI mod, yalnız gerçek bağlantısı geliştirilip sağlayıcının test ortamında doğrulanmış sağlayıcılarda açılır.</p>
        <table>
          <thead><tr><th>Sağlayıcı</th><th>Mod</th><th>Gerçek bağlantı</th><th>Erişim bilgisi</th><th>Not</th><th /></tr></thead>
          <tbody>{q.data?.map((c: any) => (
            <tr key={c.id}>
              <td>{c.name}</td>
              <td><span className={`badge ${MODE_LABEL[c.mode]![1]}`}>{MODE_LABEL[c.mode]![0]}</span></td>
              <td>{c.adapterAvailable ? <span className="badge ok">var</span> : <span className="muted">geliştirilmedi</span>}</td>
              <td>{c.hasCredentials ? <>kayıtlı · {ENV_LABEL[c.environment] ?? c.environment}<div className="muted" style={{ fontSize: 13 }}>{fmtDate(c.credentialsUpdatedAt)}</div></> : <span className="muted">yok</span>}</td>
              <td className="muted">{c.note ?? "—"}</td>
              <td><button onClick={() => setEdit({ ...c, reason: "" })}>Ayarla</button></td>
            </tr>
          ))}</tbody>
        </table>
      </section>
      {q.isLoading ? <Loading /> : <ErrorNotice error={q.error} />}
      {edit ? (
        <section className="card">
          <h3>{edit.name}</h3>
          <ErrorNotice error={save.error} />
          <div className="row" style={{ alignItems: "flex-end" }}>
            <label className="field">Mod
              <select aria-label="Bağlayıcı modu" value={edit.mode} onChange={(e) => setEdit({ ...edit, mode: e.target.value })}>
                <option value="not_connected">BAĞLANMADI</option>
                <option value="test">TEST</option>
                <option value="live" disabled={!edit.adapterAvailable || !edit.hasCredentials}>CANLI{!edit.adapterAvailable ? " (gerçek bağlantı geliştirilmedi)" : !edit.hasCredentials ? " (önce erişim bilgisi)" : ""}</option>
              </select>
            </label>
            <label className="field" style={{ flex: 1 }}>Not<input value={edit.note ?? ""} onChange={(e) => setEdit({ ...edit, note: e.target.value })} /></label>
            <label className="field" style={{ flex: 1 }}>Gerekçe<input aria-label="Bağlayıcı gerekçesi" value={edit.reason} onChange={(e) => setEdit({ ...edit, reason: e.target.value })} /></label>
            <button className="primary" disabled={edit.reason.trim().length < 3 || save.isPending} onClick={() => save.mutate()}>Kaydet</button>
            <button onClick={() => setEdit(null)}>Vazgeç</button>
          </div>
          <ConnectorCredentialsForm connector={edit} onSaved={() => { setEdit(null); qc.invalidateQueries({ queryKey: ["einvoiceConnectors"] }); }} />
        </section>
      ) : null}
    </>
  );
}

/** Entegratör erişim bilgisi: yalnız yazılır, sunucu şifreli saklar ve hiçbir zaman geri göstermez. */
function ConnectorCredentialsForm({ connector: c, onSaved }: { connector: any; onSaved: () => void }) {
  const known: string[] | null = c.credentialFields;
  const [environment, setEnvironment] = useState<string>(c.environment ?? "sandbox");
  const [values, setValues] = useState<Record<string, string>>({});
  const [extra, setExtra] = useState([{ k: "", v: "" }]);
  const [reason, setReason] = useState("");
  const credentials = known
    ? Object.fromEntries(known.map((f) => [f, values[f] ?? ""]))
    : Object.fromEntries(extra.filter((x) => x.k.trim() && x.v).map((x) => [x.k.trim(), x.v]));
  const complete = Object.keys(credentials).length > 0 && Object.values(credentials).every(Boolean);
  const save = useMutation({ mutationFn: () => post(`/api/einvoice-connectors/${c.id}/credentials`, { environment, credentials, reason }), onSuccess: onSaved });
  return (
    <div className="stack" style={{ marginTop: 12 }}>
      <h4 style={{ margin: 0 }}>Erişim bilgisi {c.hasCredentials ? <span className="badge ok">kayıtlı</span> : null}</h4>
      <p className="muted" style={{ margin: 0 }}>Entegratörün verdiği kullanıcı/parola veya API anahtarı. Şifreli saklanır; kaydedildikten sonra hiçbir ekranda gösterilmez — değiştirmek için yeniden girin.</p>
      <ErrorNotice error={save.error} />
      <div className="row" style={{ alignItems: "flex-end", flexWrap: "wrap" }}>
        <label className="field">Ortam
          <select aria-label="Entegratör ortamı" value={environment} onChange={(e) => setEnvironment(e.target.value)}>
            <option value="sandbox">Test ortamı (sandbox)</option>
            <option value="production">Üretim</option>
          </select>
        </label>
        {known
          ? known.map((f) => (
              <label key={f} className="field">{f}<input aria-label={`Erişim bilgisi ${f}`} type="password" autoComplete="off" value={values[f] ?? ""} onChange={(e) => setValues({ ...values, [f]: e.target.value })} /></label>
            ))
          : extra.map((x, i) => (
              <div key={i} className="row" style={{ gap: 6 }}>
                <input aria-label="Alan adı" placeholder="alan (ör. username)" value={x.k} onChange={(e) => setExtra(extra.map((y, j) => (j === i ? { ...y, k: e.target.value } : y)))} />
                <input aria-label="Alan değeri" type="password" autoComplete="off" placeholder="değer" value={x.v} onChange={(e) => setExtra(extra.map((y, j) => (j === i ? { ...y, v: e.target.value } : y)))} />
              </div>
            ))}
        {!known && extra.length < 10 ? <button type="button" onClick={() => setExtra([...extra, { k: "", v: "" }])}>+ alan</button> : null}
        <label className="field" style={{ flex: 1 }}>Gerekçe<input aria-label="Erişim bilgisi gerekçesi" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        <button className="primary" disabled={!complete || reason.trim().length < 3 || save.isPending} onClick={() => save.mutate()}>Erişim bilgisini kaydet</button>
      </div>
    </div>
  );
}

const emptyProfile = { legalName: "", taxNo: "", taxOffice: "", addressLine: "", district: "", city: "", postalCode: "" };

/** Satıcı (şirket) vergi kimliği — hangi entegratör seçilirse seçilsin e-belgenin ön koşulu. */
function CompanyTaxProfileCard() {
  const can = useCan();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["companyTaxProfile"], queryFn: () => get<any>("/api/company/tax-profile") });
  const [f, setF] = useState<typeof emptyProfile | null>(null);
  const v = f ?? { ...emptyProfile, ...Object.fromEntries(Object.entries(q.data ?? {}).map(([k, x]) => [k, x ?? ""])) };
  const save = useMutation({
    mutationFn: () => post("/api/company/tax-profile", { ...v, district: v.district || null, postalCode: v.postalCode || null }),
    onSuccess: (r) => { setF(null); qc.setQueryData(["companyTaxProfile"], r); },
  });
  const edit = can("org.manage");
  const field = (k: keyof typeof emptyProfile, label: string, w?: number) => (
    <label className="field" style={w ? { width: w } : { flex: 1 }}>{label}<input aria-label={`Şirket ${label}`} disabled={!edit} value={v[k]} onChange={(e) => setF({ ...v, [k]: e.target.value })} /></label>
  );
  return (
    <section className="card">
      <h2>Şirket vergi kimliği</h2>
      <p className="muted" style={{ margin: 0 }}>E-fatura/e-arşivde satıcı bilgisi olarak kullanılır. VKN (10 hane) veya TCKN (11 hane) kontrol hanesiyle doğrulanır.{edit ? "" : " Değiştirmek için organizasyon yönetimi yetkisi gerekir."}</p>
      {q.isLoading ? <Loading /> : <ErrorNotice error={q.error} />}
      <div className="row" style={{ flexWrap: "wrap" }}>
        {field("legalName", "Resmi unvan")}
        {field("taxNo", "VKN/TCKN", 160)}
        {field("taxOffice", "Vergi dairesi", 180)}
      </div>
      <div className="row" style={{ flexWrap: "wrap" }}>
        {field("addressLine", "Adres")}
        {field("district", "İlçe", 150)}
        {field("city", "İl", 150)}
        {field("postalCode", "Posta kodu", 110)}
      </div>
      {edit ? <div className="row"><button className="primary" disabled={!f || save.isPending} onClick={() => save.mutate()}>Kaydet</button></div> : null}
      <ErrorNotice error={save.error} />
    </section>
  );
}

/** Alıcı (müşteri) vergi kimliği — e-Fatura için VKN/TCKN ve resmi unvan zorunlu. */
function CustomerTaxIdentityCard() {
  const can = useCan();
  const customers = useQuery({ queryKey: ["customers"], queryFn: () => get<any[]>("/api/customers") });
  const [customerId, setCustomerId] = useState("");
  const cur = useQuery({ queryKey: ["customerTax", customerId], queryFn: () => get<any>(`/api/customers/${customerId}/tax-identity`), enabled: !!customerId });
  const [f, setF] = useState<{ legalName: string; taxNo: string; taxOffice: string } | null>(null);
  const v = f ?? { legalName: cur.data?.legalName ?? "", taxNo: cur.data?.taxNo ?? "", taxOffice: cur.data?.taxOffice ?? "" };
  const save = useMutation({
    mutationFn: () => post(`/api/customers/${customerId}/tax-identity`, { ...v, taxOffice: v.taxOffice || null }),
    onSuccess: () => { setF(null); cur.refetch(); },
  });
  const edit = can("receivable.manage");
  return (
    <section className="card">
      <h2>Müşteri vergi kimliği</h2>
      <p className="muted" style={{ margin: 0 }}>e-Fatura alıcısı için VKN/TCKN ve resmi unvan zorunludur; fatura adresi müşterinin varsayılan teslim adresinden alınır.</p>
      <div className="row" style={{ flexWrap: "wrap", alignItems: "flex-end" }}>
        <label className="field">Müşteri
          <select aria-label="Vergi kimliği müşterisi" value={customerId} onChange={(e) => { setCustomerId(e.target.value); setF(null); }}>
            <option value="">Seçin</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}
          </select>
        </label>
        {customerId ? (
          <>
            <label className="field" style={{ flex: 1 }}>Resmi unvan<input aria-label="Müşteri resmi unvanı" disabled={!edit} value={v.legalName} onChange={(e) => setF({ ...v, legalName: e.target.value })} /></label>
            <label className="field" style={{ width: 160 }}>VKN/TCKN<input aria-label="Müşteri VKN/TCKN" disabled={!edit} inputMode="numeric" value={v.taxNo} onChange={(e) => setF({ ...v, taxNo: e.target.value })} /></label>
            <label className="field" style={{ width: 180 }}>Vergi dairesi<input aria-label="Müşteri vergi dairesi" disabled={!edit} value={v.taxOffice} onChange={(e) => setF({ ...v, taxOffice: e.target.value })} /></label>
            {edit ? <button className="primary" disabled={!f || save.isPending} onClick={() => save.mutate()}>Kaydet</button> : null}
          </>
        ) : null}
      </div>
      <ErrorNotice error={cur.error} />
      <ErrorNotice error={save.error} />
    </section>
  );
}
const Header = () => (
  <>
    <PageHeader title="Alacaklar & tahsilat" sub="Sevk edilen sevkiyattan taslak fatura; kesilen fatura değişmez. Resmi e-fatura/e-arşiv gönderimi yok (belge TASLAK). Sistem tahsilat yapmaz — alınmış ödemenin kaydı tutulur." />
    <Tabs />
  </>
);

export function CustomerInvoicesPage() {
  const can = useCan();
  const qc = useQueryClient();
  const [status, setStatus] = useState("");
  const q = useQuery({ queryKey: ["cinvoices", status], queryFn: () => get<any[]>(`/api/customer-invoices${status ? `?status=${status}` : ""}`) });
  const ship = useQuery({ queryKey: ["uninvoiced"], queryFn: () => get<any[]>("/api/receivables/uninvoiced-shipments"), enabled: can("receivable.manage") });
  const [tax, setTax] = useState("20");
  const make = useMutation({
    mutationFn: (shipmentId: string) => post<any>("/api/customer-invoices/from-shipment", { shipmentId, taxRate: Number(tax.replace(",", ".")) || 0 }, { "Idempotency-Key": newKey() }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["cinvoices"] }); qc.invalidateQueries({ queryKey: ["uninvoiced"] }); },
  });
  return (
    <>
      <Header />
      {can("receivable.manage") ? (
        <section className="card">
          <div className="row between">
            <h2 style={{ margin: 0 }}>Faturası kesilmemiş sevkiyatlar</h2>
            <label className="row" style={{ gap: 6 }}>KDV % <input aria-label="KDV oranı" inputMode="decimal" value={tax} onChange={(e) => setTax(e.target.value)} style={{ width: 70 }} /></label>
          </div>
          <ErrorNotice error={make.error} />
          {ship.data?.length === 0 ? <Empty>Bekleyen sevkiyat yok.</Empty> : null}
          <table><tbody>{ship.data?.map((s) => (
            <tr key={s.id}>
              <td className="mono"><Link to={`/shipments/${s.id}`}>{s.code}</Link></td><td>{s.customerName}</td><td className="mono">{s.orderCode}</td><td className="muted">{fmtDate(s.shippedAt)}</td>
              <td>{s.unpriced ? <span className="badge bad">{s.unpriced} satır fiyatsız</span> : null}</td>
              <td><button disabled={make.isPending} onClick={() => make.mutate(s.id)}>Taslak fatura</button></td>
            </tr>
          ))}</tbody></table>
        </section>
      ) : null}
      <section className="card">
        <div className="row">
          <label className="field">Durum<select aria-label="Müşteri faturası durumu" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Tümü</option>{Object.entries(ST).map(([k, v]) => <option key={k} value={k}>{v[0]}</option>)}</select></label>
        </div>
        {q.isLoading ? <Loading /> : <ErrorNotice error={q.error} />}
        {q.data?.length === 0 ? <Empty>Fatura yok.</Empty> : null}
        {q.data?.length ? (
          <table>
            <thead><tr><th>No</th><th>Müşteri</th><th>Sipariş</th><th>Tarih</th><th>Vade</th><th className="num">Tutar</th><th className="num">Tahsil</th><th>Durum</th></tr></thead>
            <tbody>{q.data.map((x) => (
              <tr key={x.id}>
                <td className="mono"><Link to={`/receivables/${x.id}`}>{x.code}</Link></td><td>{x.customerName}</td><td className="mono">{x.orderCode}</td><td>{x.invoiceDate ?? "—"}</td>
                <td>{x.dueDate ?? "—"} {x.overdue ? <span className="badge bad">vadesi geçti</span> : null}</td><td className="num">{fmt(x.grossAmount)} {x.currency}</td><td className="num">{fmt(x.received)}</td>
                <td><span className={`badge ${ST[x.status]![1]}`}>{ST[x.status]![0]}</span></td>
              </tr>
            ))}</tbody>
          </table>
        ) : null}
      </section>
    </>
  );
}

export function CustomerInvoicePage() {
  const { id } = useParams();
  const can = useCan();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["cinvoice", id], queryFn: () => get<any>(`/api/customer-invoices/${id}`) });
  const act = useMutation({ mutationFn: (f: () => Promise<any>) => f(), onSuccess: () => { qc.invalidateQueries({ queryKey: ["cinvoice", id] }); qc.invalidateQueries({ queryKey: ["history"] }); } });
  const [rc, setRc] = useState({ amount: "", receivedOn: today(), reference: "" });
  const [rcKey, setRcKey] = useState(newKey());
  const [date, setDate] = useState(today());
  const [tax, setTax] = useState<string | null>(null);
  const [cancel, setCancel] = useState("");
  const [connectorId, setConnectorId] = useState("");
  const [kind, setKind] = useState<"e_fatura" | "e_arsiv">("e_arsiv");
  const i = q.data;
  const manage = can("receivable.manage");
  const canSend = manage && i?.status === "issued" && !i?.einvoiceSentAt;
  const einvoiceQ = useQuery({ queryKey: ["einvoiceConnectors"], queryFn: () => get<any[]>("/api/einvoice-connectors"), enabled: canSend });
  const readyQ = useQuery({ queryKey: ["einvoiceReadiness", id, kind], queryFn: () => get<any>(`/api/customer-invoices/${id}/einvoice-readiness?kind=${kind}`), enabled: canSend });
  const selected = einvoiceQ.data?.find((c: any) => c.id === connectorId);
  if (!i) return q.isLoading ? <Loading /> : <ErrorNotice error={q.error} />;
  return (
    <>
      <PageHeader title={`${i.code} — ${i.customerName}`} sub={<>{i.salesOrderId ? <>sipariş <Link to={`/sales/${i.salesOrderId}`}>{i.salesOrderCode}</Link></> : <span className="muted">sipariş bağlantısı yok (tarihsel geçiş)</span>}{i.shipmentId ? <> · sevkiyat <Link to={`/shipments/${i.shipmentId}`}>{i.shipmentCode}</Link></> : null} · hazırlayan {i.createdBy} · <Link to="/receivables">← Faturalar</Link></>}
        actions={<span className={`badge ${ST[i.status]![1]}`}>{ST[i.status]![0]}</span>} />
      {i.migrated ? (
        <div className="notice">
          Bu fatura tarihsel geçişle (W39 devamı) eklendi — sipariş/sevkiyat bağlantısı olmadığından bir sipariş/sevkiyat kaydına bağlanmadı; fatura doğrudan {i.status === "paid" ? "tahsil edildi" : "kesildi"} olarak kaydedildi.
        </div>
      ) : null}
      {i.documentMode === "live" ? (
        <div className="notice info">Belge modu <span className="badge mode ok">CANLI</span>: {i.einvoiceKind === "e_fatura" ? "e-Fatura" : "e-Arşiv"} olarak {i.einvoiceConnector} üzerinden gönderildi (ETTN {i.einvoiceEttn}).</div>
      ) : i.documentMode === "test" ? (
        <div className="notice warn">Belge modu <span className="badge mode warn">TEST</span>: {i.einvoiceKind === "e_fatura" ? "e-Fatura" : "e-Arşiv"} olarak {i.einvoiceConnector} üzerinden sentetik gönderildi (ETTN {i.einvoiceEttn}) — resmi değildir, GİB'e iletilmedi.</div>
      ) : (
        <div className="notice info">Belge modu <span className="badge mode warn">TASLAK</span>: resmi e-fatura/e-arşiv oluşturulmadı ve GİB'e gönderilmedi.</div>
      )}
      {canSend ? (
        <section className="card">
          <h3>E-belge gönder</h3>
          <p className="muted" style={{ margin: 0 }}>Sağlayıcı seçimi şirket kararıdır (<Link to="/receivables/einvoice-connectors">bağlayıcılar ve vergi kimliği</Link>). TEST modundaki bağlayıcı sentetik ETTN üretir; CANLI bağlayıcı belgeyi entegratöre gönderir.</p>
          {readyQ.data && !readyQ.data.ready ? (
            <div className="notice warn">
              {kind === "e_fatura" ? "e-Fatura" : "e-Arşiv"} için eksik bilgi{selected?.mode === "live" ? " — CANLI gönderim bunlar tamamlanmadan yapılamaz" : " (TEST gönderimi etkilemez)"}:
              <ul style={{ margin: "4px 0 0" }}>{readyQ.data.issues.map((x: any) => <li key={x.field}>{x.message}</li>)}</ul>
            </div>
          ) : null}
          <div className="row" style={{ alignItems: "flex-end" }}>
            <label className="field">Sağlayıcı
              <select aria-label="E-belge bağlayıcısı" value={connectorId} onChange={(e) => setConnectorId(e.target.value)}>
                <option value="">Seçin…</option>
                {einvoiceQ.data?.map((c: any) => <option key={c.id} value={c.id}>{c.name} ({MODE_LABEL[c.mode]![0]})</option>)}
              </select>
            </label>
            <label className="field">Tür
              <select aria-label="E-belge türü" value={kind} onChange={(e) => setKind(e.target.value as any)}>
                <option value="e_arsiv">e-Arşiv</option>
                <option value="e_fatura">e-Fatura</option>
              </select>
            </label>
            <button className="primary" disabled={!connectorId || act.isPending} onClick={() => act.mutate(() => post(`/api/customer-invoices/${id}/send-einvoice`, { connectorId, kind }))}>Gönder</button>
          </div>
        </section>
      ) : null}
      <ErrorNotice error={act.error} />
      {i.overdue ? <div className="notice warn">Vadesi geçti ({i.dueDate}).</div> : null}
      {i.cancelReason ? <div className="notice">İptal: {i.cancelReason}</div> : null}
      <section className="card">
        <div className="kpis">
          <div className="kpi"><small>Net</small><b>{fmt(i.netAmount)} {i.currency}</b></div>
          <div className="kpi"><small>KDV %{Number(i.taxRate)}</small><b>{fmt(i.taxAmount)}</b></div>
          <div className="kpi"><small>Toplam</small><b>{fmt(i.grossAmount)}</b></div>
          <div className="kpi"><small>Tahsil (kayıt)</small><b>{fmt(i.received)}</b></div>
          <div className="kpi"><small>Açık</small><b>{fmt(i.open)}</b></div>
        </div>
        <p style={{ margin: 0 }}>{i.invoiceDate ? `Fatura tarihi ${i.invoiceDate} · vade ${i.dueDate} · kesen ${i.issuedBy}` : "Henüz kesilmedi."}</p>
        <table>
          <thead><tr><th>#</th><th>Ürün</th><th className="num">Miktar</th><th className="num">Birim fiyat</th><th className="num">Tutar</th></tr></thead>
          <tbody>{i.lines.map((l: any) => <tr key={l.lineNo}><td>{l.lineNo}</td><td className="mono">{l.description}</td><td className="num">{fmt(l.qty)}</td><td className="num">{fmt(l.unitPrice)}</td><td className="num">{fmt(l.amount)}</td></tr>)}</tbody>
        </table>
        {manage && i.status === "draft" ? (
          <div className="row">
            <label className="row" style={{ gap: 6 }}>KDV % <input aria-label="Taslak KDV oranı" inputMode="decimal" value={tax ?? String(Number(i.taxRate))} onChange={(e) => setTax(e.target.value)} style={{ width: 70 }} /></label>
            <button disabled={tax === null} onClick={() => act.mutate(() => post(`/api/customer-invoices/${id}/update`, { taxRate: Number((tax ?? "0").replace(",", ".")) }).then(() => setTax(null)))}>Güncelle</button>
            <label className="row" style={{ gap: 6, marginLeft: "auto" }}>Fatura tarihi <input aria-label="Fatura tarihi" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
            <button className="primary" onClick={() => act.mutate(() => post(`/api/customer-invoices/${id}/issue`, { invoiceDate: date }))}>Faturayı kes</button>
          </div>
        ) : null}
        {manage && ["draft", "issued"].includes(i.status) && Number(i.received) === 0 ? (
          <div className="row">
            <input aria-label="İptal gerekçesi" placeholder="İptal gerekçesi" value={cancel} onChange={(e) => setCancel(e.target.value)} />
            <button className="danger" disabled={cancel.length < 3} onClick={() => act.mutate(() => post(`/api/customer-invoices/${id}/cancel`, { reason: cancel }))}>İptal et</button>
            <span className="muted">Kesilmiş fatura değiştirilemez; düzeltme için iptal edip sevkiyattan yeniden hazırlayın.</span>
          </div>
        ) : null}
      </section>
      <section className="card">
        <h2>Tahsilat kayıtları</h2>
        <p className="muted" style={{ margin: 0 }}>Sistem tahsilat yapmaz; bankaya gelen ödemenin kaydını girin. Kayıt değiştirilemez.</p>
        {i.receipts.length ? <table><tbody>{i.receipts.map((r: any, k: number) => <tr key={k}><td>{r.receivedOn}</td><td className="num">{fmt(r.amount)} {i.currency}</td><td className="mono">{r.reference}</td><td className="muted">{r.recordedBy} · {fmtDate(r.createdAt)}</td></tr>)}</tbody></table> : <Empty>Tahsilat kaydı yok.</Empty>}
        {i.status === "issued" && can("payment.record") ? (
          <form className="row" onSubmit={(e) => { e.preventDefault(); act.mutate(() => post(`/api/customer-invoices/${id}/receipts`, { ...rc, amount: rc.amount.replace(",", ".") }, { "Idempotency-Key": rcKey }).then(() => { setRc({ amount: "", receivedOn: today(), reference: "" }); setRcKey(newKey()); })); }}>
            <label className="field" style={{ width: 130 }}>Tutar<input aria-label="Tahsilat tutarı" required inputMode="decimal" placeholder={i.open} value={rc.amount} onChange={(e) => setRc({ ...rc, amount: e.target.value })} /></label>
            <label className="field">Tarih<input type="date" required value={rc.receivedOn} onChange={(e) => setRc({ ...rc, receivedOn: e.target.value })} /></label>
            <label className="field" style={{ flex: 1 }}>Banka referansı<input aria-label="Tahsilat referansı" required minLength={3} value={rc.reference} onChange={(e) => setRc({ ...rc, reference: e.target.value })} /></label>
            <button className="primary" style={{ alignSelf: "flex-end" }}>Tahsilat kaydı ekle</button>
          </form>
        ) : null}
      </section>
      {i.status === "issued" ? <CollectionReminderPanel invoice={i} id={id!} manage={manage} onChanged={() => { qc.invalidateQueries({ queryKey: ["cinvoice", id] }); qc.invalidateQueries({ queryKey: ["history"] }); }} /> : null}
      <Discussion entityType="customer_invoice" entityId={i.id} />
      <History entityType="customer_invoice" id={i.id} />
    </>
  );
}

/** R21: bir faturanın hatırlatma durumu ve elle duraklat/devam ettir. */
function CollectionReminderPanel({ invoice: i, id, manage, onChanged }: { invoice: any; id: string; manage: boolean; onChanged: () => void }) {
  const [reason, setReason] = useState("");
  const pause = useMutation({
    mutationFn: (paused: boolean) => post(`/api/customer-invoices/${id}/reminders/pause`, { paused, reason: reason || (paused ? "Duraklatıldı" : "Devam ettirildi") }),
    onSuccess: () => { setReason(""); onChanged(); },
  });
  return (
    <section className="card">
      <h2>Tahsilat hatırlatması</h2>
      {i.remindersPaused ? (
        <div className="notice warn">Hatırlatmalar duraklatıldı: {i.remindersPausedReason ?? "—"}</div>
      ) : (
        <p className="muted" style={{ margin: 0 }}>
          {i.reminderCount > 0 ? <>Şimdiye kadar {i.reminderCount} hatırlatma gönderildi, sonuncusu {fmtDate(i.lastReminderAt)}.</> : "Henüz hatırlatma gönderilmedi."}
          {" "}Şirket genelindeki kural <Link to="/receivables/aging">yaşlandırma sayfasından</Link> ayarlanır.
        </p>
      )}
      {manage ? (
        <div className="row">
          <input aria-label="Duraklatma/devam gerekçesi" placeholder="Gerekçe (ör. müşteri itiraz etti)" value={reason} onChange={(e) => setReason(e.target.value)} style={{ flex: 1 }} />
          {i.remindersPaused ? (
            <button disabled={pause.isPending} onClick={() => pause.mutate(false)}>Hatırlatmaları devam ettir</button>
          ) : (
            <button disabled={pause.isPending} onClick={() => pause.mutate(true)}>Hatırlatmaları duraklat</button>
          )}
        </div>
      ) : null}
      <ErrorNotice error={pause.error} />
    </section>
  );
}

export function ReceivablesAgingPage() {
  const can = useCan();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["arAging"], queryFn: () => get<any>("/api/receivables/aging") });
  const customers = useQuery({ queryKey: ["customers"], queryFn: () => get<any[]>("/api/customers") });
  const [f, setF] = useState({ customerId: "", creditLimit: "", paymentTermsDays: "30", overdueBlockDays: "", billingEmail: "", reason: "" });
  const save = useMutation({
    mutationFn: async () => {
      await post(`/api/customers/${f.customerId}/credit`, { creditLimit: f.creditLimit ? f.creditLimit.replace(",", ".") : null, paymentTermsDays: Number(f.paymentTermsDays) || 0, overdueBlockDays: f.overdueBlockDays ? Number(f.overdueBlockDays) : null, reason: f.reason });
      await post(`/api/customers/${f.customerId}/billing-email`, { billingEmail: f.billingEmail.trim() || null });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["arAging"] }); qc.invalidateQueries({ queryKey: ["customers"] }); setF({ ...f, reason: "" }); },
  });
  const rule = useQuery({ queryKey: ["reminderRule"], queryFn: () => get<any>("/api/receivables/reminder-rule") });
  const [rf, setRf] = useState<any | null>(null);
  const saveRule = useMutation({
    mutationFn: () => post("/api/receivables/reminder-rule", { ...rf, minOverdueDays: Number(rf.minOverdueDays), frequencyDays: Number(rf.frequencyDays), maxReminders: rf.maxReminders === "" || rf.maxReminders === null ? null : Number(rf.maxReminders) }),
    onSuccess: (r) => { setRf(null); qc.setQueryData(["reminderRule"], r); },
  });
  const runNow = useMutation({ mutationFn: () => post<{ sent: number }>("/api/receivables/reminders/run", {}) });
  const rv = rf ?? rule.data;
  const d = q.data;
  return (
    <>
      <Header />
      {q.isLoading ? <Loading /> : <ErrorNotice error={q.error} />}
      <section className="card">
        <h2>Alacak yaşlandırma</h2>
        {d?.buckets.length === 0 ? <Empty>Açık alacak yok.</Empty> : (
          <table>
            <thead><tr><th>Müşteri</th><th>Para</th><th className="num">Vadesi gelmemiş</th><th className="num">1–30 geçmiş</th><th className="num">31–60</th><th className="num">60+</th><th className="num">Toplam</th></tr></thead>
            <tbody>{d?.buckets.map((b: any) => <tr key={b.customerId + b.currency}><td>{b.customerName}</td><td>{b.currency}</td>{["current", "over1", "over31", "over60", "total"].map((k) => <td key={k} className="num">{b[k] ? fmt(b[k]) : "—"}</td>)}</tr>)}</tbody>
          </table>
        )}
      </section>
      <section className="card">
        <h2>Kredi riski</h2>
        <p className="muted" style={{ margin: 0 }}>Risk = açık alacak + faturalanmamış kesin siparişler (KDV hariç). Limit aşımı veya izin verilen günden fazla gecikmiş alacak, yeni siparişin kesinleşmesini engeller; yetkili sipariş bazında gerekçeyle serbest bırakabilir.</p>
        {d?.credit.length ? (
          <table>
            <thead><tr><th>Müşteri</th><th className="num">Limit</th><th className="num">Açık alacak</th><th className="num">Gecikmiş</th><th className="num">Faturalanmamış sipariş</th><th className="num">Risk</th><th className="num">Kullanılabilir</th><th>Durum</th></tr></thead>
            <tbody>{d.credit.map((c: any) => (
              <tr key={c.customerId}>
                <td>{c.customer}<div className="muted" style={{ fontSize: 13 }}>vade {c.paymentTermsDays} g{c.overdueBlockDays !== null ? ` · gecikme sınırı ${c.overdueBlockDays} g` : ""}</div></td>
                <td className="num">{money(c.creditLimit, c.currency)}</td><td className="num">{money(c.openReceivables)}</td>
                <td className="num">{c.overdueAmount ? <>{money(c.overdueAmount)}<div className="muted">{c.maxOverdueDays} gün</div></> : "—"}</td>
                <td className="num">{money(c.uninvoicedOrders)}</td><td className="num"><b>{money(c.exposure)}</b></td><td className="num">{money(c.available)}</td>
                <td>{c.blocked ? <span className="badge bad" title={c.reasons.join("; ")}>engelli</span> : <span className="badge ok">açık</span>}</td>
              </tr>
            ))}</tbody>
          </table>
        ) : <Empty>Kredi tanımlı veya açık alacağı olan müşteri yok.</Empty>}
        {can("receivable.manage") ? (
          <form className="row" style={{ flexWrap: "wrap" }} onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
            <label className="field">Müşteri
              <select aria-label="Kredi müşterisi" required value={f.customerId} onChange={(e) => {
                const cust = customers.data?.find((c) => c.id === e.target.value);
                setF({ ...f, customerId: e.target.value, billingEmail: cust?.billingEmail ?? "" });
              }}><option value="">Seçin</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}</select>
            </label>
            <label className="field" style={{ width: 130 }}>Kredi limiti (TRY)<input aria-label="Kredi limiti" inputMode="decimal" placeholder="boş = limitsiz" value={f.creditLimit} onChange={(e) => setF({ ...f, creditLimit: e.target.value })} /></label>
            <label className="field" style={{ width: 100 }}>Vade (gün)<input aria-label="Müşteri vadesi" inputMode="numeric" value={f.paymentTermsDays} onChange={(e) => setF({ ...f, paymentTermsDays: e.target.value })} /></label>
            <label className="field" style={{ width: 150 }}>Gecikme sınırı (gün)<input aria-label="Gecikme sınırı" inputMode="numeric" placeholder="boş = yok" value={f.overdueBlockDays} onChange={(e) => setF({ ...f, overdueBlockDays: e.target.value })} /></label>
            <label className="field" style={{ width: 200 }}>Fatura e-postası<input aria-label="Fatura e-postası" type="email" placeholder="boş = yok" value={f.billingEmail} onChange={(e) => setF({ ...f, billingEmail: e.target.value })} /></label>
            <label className="field" style={{ flex: 1 }}>Gerekçe<input aria-label="Kredi gerekçesi" required minLength={3} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></label>
            <button className="primary" style={{ alignSelf: "flex-end" }}>Kaydet</button>
          </form>
        ) : null}
        <ErrorNotice error={save.error} />
      </section>
      <section className="card">
        <h2>Tahsilat hatırlatma kuralı</h2>
        <p className="muted" style={{ margin: 0 }}>Vadesi geçmiş açık bakiyeli faturalar için otomatik tarama (dakikada bir) veya elle çalıştırma. Gönderimden hemen önce açık bakiye yeniden doğrulanır; ödenmiş faturaya gitmez. Gerçek e-posta gönderimi yok — alıcı "müşteri" ise çıkış kutusuna (test), "muhasebe" ise iç göreve yazılır.</p>
        {rule.isLoading ? <Loading /> : <ErrorNotice error={rule.error} />}
        {rv ? (
          <div className="stack">
            <div className="row" style={{ flexWrap: "wrap" }}>
              <label className="row" style={{ gap: 6 }}><input type="checkbox" style={{ minHeight: 0 }} disabled={!can("receivable.manage")} checked={!!rv.enabled} onChange={(e) => setRf({ ...rv, enabled: e.target.checked })} /> Etkin</label>
              <label className="field" style={{ width: 150 }}>En az gecikme (gün)<input aria-label="En az gecikme günü" disabled={!can("receivable.manage")} inputMode="numeric" value={rv.minOverdueDays} onChange={(e) => setRf({ ...rv, minOverdueDays: e.target.value })} /></label>
              <label className="field" style={{ width: 150 }}>Sıklık (gün)<input aria-label="Hatırlatma sıklığı" disabled={!can("receivable.manage")} inputMode="numeric" value={rv.frequencyDays} onChange={(e) => setRf({ ...rv, frequencyDays: e.target.value })} /></label>
              <label className="field" style={{ width: 150 }}>Azami hatırlatma<input aria-label="Azami hatırlatma sayısı" disabled={!can("receivable.manage")} inputMode="numeric" placeholder="boş = sınırsız" value={rv.maxReminders ?? ""} onChange={(e) => setRf({ ...rv, maxReminders: e.target.value })} /></label>
              <label className="field">Alıcı
                <select aria-label="Hatırlatma alıcısı" disabled={!can("receivable.manage")} value={rv.recipient} onChange={(e) => setRf({ ...rv, recipient: e.target.value })}>
                  <option value="accounting">Muhasebe (iç görev)</option>
                  <option value="customer">Müşteri (e-posta, test)</option>
                  <option value="both">İkisi de</option>
                </select>
              </label>
            </div>
            <label className="field">Şablon ({"{musteri} {fatura} {gecikme} {tutar} {para_birimi} {vade}"})
              <textarea disabled={!can("receivable.manage")} rows={2} value={rv.template} onChange={(e) => setRf({ ...rv, template: e.target.value })} />
            </label>
            {can("receivable.manage") ? (
              <div className="row">
                <button className="primary" disabled={saveRule.isPending} onClick={() => saveRule.mutate()}>Kuralı kaydet</button>
                <button disabled={runNow.isPending} onClick={() => runNow.mutate()}>Şimdi çalıştır</button>
                {runNow.data ? <span className="muted">{runNow.data.sent} hatırlatma gönderildi.</span> : null}
              </div>
            ) : null}
            <ErrorNotice error={saveRule.error} />
            <ErrorNotice error={runNow.error} />
          </div>
        ) : null}
      </section>
    </>
  );
}

/** Sipariş sayfasında kredi durumu ve (yetkiliyse) gerekçeli serbest bırakma. */
export function OrderCredit({ order }: { order: { id: string; customerId: string; status: string; creditReleaseReason?: string | null; creditReleasedAt?: string | null } }) {
  const can = useCan();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["credit", order.customerId], queryFn: () => get<any>(`/api/customers/${order.customerId}/credit`), enabled: can("receivable.view") });
  const [reason, setReason] = useState("");
  const rel = useMutation({ mutationFn: () => post(`/api/sales-orders/${order.id}/credit-release`, { reason }), onSuccess: () => { qc.invalidateQueries({ queryKey: ["order", order.id] }); qc.invalidateQueries({ queryKey: ["history"] }); } });
  const c = q.data;
  if (!c) return null;
  return (
    <section className="card">
      <h2>Müşteri kredi durumu</h2>
      <p style={{ margin: 0 }}>
        Limit {money(c.creditLimit, c.currency)} · açık alacak {money(c.openReceivables)} · faturalanmamış sipariş {money(c.uninvoicedOrders)} · risk <b>{money(c.exposure)}</b>
        {c.maxOverdueDays ? <> · en eski gecikme <b>{c.maxOverdueDays} gün</b></> : null}
      </p>
      <p className="muted" style={{ margin: 0 }}>Bu siparişin tutarı kesinleştirmede riske eklenir. {c.warnings.join(" ")}</p>
      {order.creditReleasedAt ? <div className="notice">Kredi engeli bu sipariş için kaldırıldı: {order.creditReleaseReason}</div> : null}
      {!order.creditReleasedAt && ["draft", "availability_review"].includes(order.status) && can("credit.override") ? (
        <div className="row">
          <input aria-label="Kredi serbest bırakma gerekçesi" placeholder="Engel varsa bu sipariş için gerekçeyle serbest bırak (en az 10 karakter)" value={reason} onChange={(e) => setReason(e.target.value)} style={{ flex: 1 }} />
          <button disabled={reason.length < 10 || rel.isPending} onClick={() => rel.mutate()}>Serbest bırak</button>
        </div>
      ) : null}
      <ErrorNotice error={rel.error} />
    </section>
  );
}
