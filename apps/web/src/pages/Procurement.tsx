import { useState, type FormEvent } from "react";
import { Link, NavLink, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, newKey, post } from "../lib/api";
import { Empty, ErrorNotice, Loading, PageHeader, fmt, fmtDate, useCan } from "../lib/ui";
import { History } from "./Sales";
import { Discussion } from "../components/Discussion";
import { ItemOffers } from "./Distributors";

export function PurchasingTabs() {
  return (
    <div className="row tabs" role="tablist">
      <NavLink to="/purchasing" end>Talepler</NavLink>
      <NavLink to="/purchasing/rfqs">Teklifler</NavLink>
      <NavLink to="/purchasing/orders">Siparişler</NavLink>
      <NavLink to="/purchasing/followups">Takip</NavLink>
      <NavLink to="/purchasing/suppliers">Tedarikçiler</NavLink>
      <NavLink to="/purchasing/distributors">Distribütörler</NavLink>
      <NavLink to="/purchasing/supply-risk">Tedarik Riski</NavLink>
    </div>
  );
}

const PO_STATUS: Record<string, [string, string]> = {
  draft: ["taslak", "warn"], sent: ["gönderildi (test)", "warn"], confirmed: ["teyitli", "ok"], partially_received: ["kısmi teslim", "warn"], received: ["teslim alındı", "ok"], cancelled: ["iptal", ""],
};
const Header = () => (
  <>
    <PageHeader title="Satın alma" sub="Teklif → gerekçeli seçim → sipariş → tedarikçi teyidi → takip. Tedarikçiye gerçek gönderim yapılmaz: gönderim ve hatırlatmalar test modunda çıkış kutusuna yazılır." />
    <PurchasingTabs />
  </>
);

// ---- Tedarikçiler ------------------------------------------------------------------------------
export function SuppliersPage() {
  const can = useCan();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["suppliers"], queryFn: () => get<any[]>("/api/suppliers") });
  const act = useMutation({ mutationFn: (f: () => Promise<unknown>) => f(), onSuccess: () => qc.invalidateQueries({ queryKey: ["suppliers"] }) });
  const [f, setF] = useState({ code: "", name: "", contactEmail: "", defaultLeadTimeDays: "", paymentTermsDays: "30" });
  const [reason, setReason] = useState<Record<string, string>>({});
  return (
    <>
      <Header />
      <ErrorNotice error={act.error} />
      <section className="card">
        <h2>Tedarikçiler</h2>
        {q.isLoading ? <Loading /> : <ErrorNotice error={q.error} />}
        {q.data?.length === 0 ? <Empty>Tedarikçi yok.</Empty> : null}
        {q.data?.length ? (
          <table>
            <thead><tr><th>Kod</th><th>Ad</th><th>E-posta</th><th className="num">Temin (gün)</th><th className="num">Vade (gün)</th><th className="num">Satır</th><th className="num">Gecikmiş</th><th className="num">Ort. kayma (gün)</th><th>Durum</th><th /></tr></thead>
            <tbody>{q.data.map((s) => (
              <tr key={s.id}>
                <td className="mono">{s.code}</td><td>{s.name}</td><td className="muted">{s.contactEmail ?? "—"}</td><td className="num">{s.defaultLeadTimeDays ?? "—"}</td><td className="num">{s.paymentTermsDays}</td>
                <td className="num">{s.lineCount}</td><td className="num">{s.overdueLines ? <span className="badge bad">{s.overdueLines}</span> : 0}</td><td className="num">{s.avgSlipDays ?? "—"}</td>
                <td>{s.status === "active" ? <span className="badge ok">aktif</span> : <span className="badge bad" title={s.blockedReason}>bloke</span>}</td>
                <td>{can("supplier.manage") ? (
                  <div className="row">
                    <input aria-label={`${s.code} gerekçe`} placeholder="Gerekçe" value={reason[s.id] ?? ""} onChange={(e) => setReason({ ...reason, [s.id]: e.target.value })} style={{ width: 130 }} />
                    <button disabled={(reason[s.id] ?? "").length < 3} onClick={() => act.mutate(() => post(`/api/suppliers/${s.id}/status`, { status: s.status === "active" ? "blocked" : "active", reason: reason[s.id] }))}>{s.status === "active" ? "Bloke et" : "Aktifleştir"}</button>
                  </div>
                ) : null}</td>
              </tr>
            ))}</tbody>
          </table>
        ) : null}
        {can("supplier.manage") ? (
          <form className="row" onSubmit={(e: FormEvent) => { e.preventDefault(); act.mutate(() => post("/api/suppliers", { code: f.code, name: f.name, contactEmail: f.contactEmail || undefined, defaultLeadTimeDays: f.defaultLeadTimeDays ? Number(f.defaultLeadTimeDays) : undefined, paymentTermsDays: Number(f.paymentTermsDays) || 30 }).then(() => setF({ code: "", name: "", contactEmail: "", defaultLeadTimeDays: "", paymentTermsDays: "30" }))); }}>
            <label className="field" style={{ width: 110 }}>Kod<input aria-label="Tedarikçi kodu" required value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></label>
            <label className="field" style={{ flex: 1 }}>Ad<input aria-label="Tedarikçi adı" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
            <label className="field">E-posta<input type="email" value={f.contactEmail} onChange={(e) => setF({ ...f, contactEmail: e.target.value })} /></label>
            <label className="field" style={{ width: 110 }}>Temin (gün)<input inputMode="numeric" value={f.defaultLeadTimeDays} onChange={(e) => setF({ ...f, defaultLeadTimeDays: e.target.value })} /></label>
            <label className="field" style={{ width: 110 }}>Vade (gün)<input inputMode="numeric" value={f.paymentTermsDays} onChange={(e) => setF({ ...f, paymentTermsDays: e.target.value })} /></label>
            <button className="primary" style={{ alignSelf: "flex-end" }}>Ekle</button>
          </form>
        ) : null}
      </section>
    </>
  );
}

// ---- Teklif talepleri ------------------------------------------------------------------------
export function RfqsPage() {
  const q = useQuery({ queryKey: ["rfqs"], queryFn: () => get<any[]>("/api/rfqs") });
  return (
    <>
      <Header />
      <section className="card">
        <h2>Teklif talepleri</h2>
        <p className="muted" style={{ margin: 0 }}>Onaylı satın alma talebinden "Teklif iste" ile açılır.</p>
        {q.isLoading ? <Loading /> : <ErrorNotice error={q.error} />}
        {q.data?.length === 0 ? <Empty>Teklif talebi yok.</Empty> : null}
        {q.data?.length ? (
          <table>
            <thead><tr><th>Kod</th><th>Kalem</th><th className="num">Miktar</th><th>İhtiyaç</th><th>Talep</th><th className="num">Teklif</th><th>Durum</th></tr></thead>
            <tbody>{q.data.map((r) => (
              <tr key={r.id}><td className="mono"><Link to={`/purchasing/rfqs/${r.id}`}>{r.code}</Link></td><td className="mono">{r.itemCode}</td><td className="num">{fmt(r.qty)}</td><td>{r.needDate ?? "—"}</td><td className="mono">{r.prCode ?? "—"}</td><td className="num">{r.quotes}</td>
                <td><span className={`badge ${r.status === "open" ? "warn" : r.status === "awarded" ? "ok" : ""}`}>{{ open: "açık", awarded: "seçildi", cancelled: "iptal" }[r.status as string]}</span></td></tr>
            ))}</tbody>
          </table>
        ) : null}
      </section>
    </>
  );
}

export function RfqPage() {
  const { id } = useParams();
  const can = useCan();
  const nav = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["rfq", id], queryFn: () => get<any>(`/api/rfqs/${id}`) });
  const sup = useQuery({ queryKey: ["suppliers"], queryFn: () => get<any[]>("/api/suppliers") });
  const act = useMutation({ mutationFn: (f: () => Promise<any>) => f(), onSuccess: () => { qc.invalidateQueries({ queryKey: ["rfq", id] }); qc.invalidateQueries({ queryKey: ["history"] }); } });
  const [f, setF] = useState({ supplierId: "", unitPrice: "", currency: "TRY", leadTimeDays: "", moq: "", validUntil: "", offeredItemId: "" });
  const [pick, setPick] = useState<string | null>(null);
  const [auto, setAuto] = useState<{ added: string[]; skipped: string[] } | null>(null);
  const [reason, setReason] = useState("");
  const [key] = useState(newKey());
  const award = useMutation({ mutationFn: () => post<any>(`/api/rfqs/${id}/award`, { quoteId: pick, reason: reason || undefined }, { "Idempotency-Key": key }), onSuccess: (r) => nav(`/purchasing/orders/${r.poId}`) });
  const r = q.data;
  if (!r) return q.isLoading ? <Loading /> : <ErrorNotice error={q.error} />;
  const open = r.status === "open" && can("purchase.order.manage");
  return (
    <>
      <PageHeader title={`${r.code} — ${r.itemCode} × ${fmt(r.qty)}`} sub={<>{r.itemName} {r.mpn ? `· ${r.mpn}` : ""} · ihtiyaç {r.needDate ?? "—"} · talep {r.prCode ?? "—"}{r.lastCost ? ` · son lot maliyeti ${fmt(r.lastCost.unitCost)} ${r.lastCost.currency}` : ""} · <Link to="/purchasing/rfqs">← Teklifler</Link></>} />
      {r.status === "awarded" ? <div className="notice">Seçildi{r.awardReason ? `: ${r.awardReason}` : ""}.</div> : null}
      {r.approvedAlternates?.length ? (
        <section className="card">
          <h2>Onaylı alternatifler</h2>
          <p className="muted" style={{ margin: 0 }}>Tedarikçi yalnız genel kapsamlı onaylı alternatif için teklif verebilir; ürüne özel onay başka ürünün talebinde kullanılamaz. Alternatif teklifin seçimi gerekçe ister, sipariş alternatif kalemle açılır.</p>
          <table>
            <thead><tr><th>Kalem</th><th>Üretici / MPN</th><th>Kapsam</th><th className="num">Serbest stok</th></tr></thead>
            <tbody>{r.approvedAlternates.map((a: any) => (
              <tr key={a.itemId}><td className="mono">{a.code}</td><td className="muted">{a.manufacturer ?? ""} {a.mpn ?? ""}</td><td>{a.general ? "genel" : `yalnız ${a.productCode}`}</td><td className="num">{fmt(a.freeQty)}</td></tr>
            ))}</tbody>
          </table>
        </section>
      ) : null}
      <section className="card">
        <h2>Teklif karşılaştırma</h2>
        {r.quotes.length === 0 ? <Empty>Henüz teklif yok.</Empty> : (
          <table>
            <thead><tr><th /><th>Tedarikçi</th><th className="num">Birim</th><th className="num">Toplam</th><th className="num">Temin</th><th>Hazır</th><th>MOQ</th><th>Geçerlilik</th><th className="num">Sapma</th><th /></tr></thead>
            <tbody>{r.quotes.map((x: any) => (
              <tr key={x.id} style={{ background: r.awardedQuoteId === x.id ? "var(--accent-soft)" : undefined }}>
                <td>{open ? <input type="radio" name="pick" aria-label={`${x.supplierName} seç`} style={{ minHeight: 0 }} checked={pick === x.id} onChange={() => setPick(x.id)} /> : null}</td>
                <td>{x.supplierName} {x.supplierStatus !== "active" ? <span className="badge bad">bloke</span> : null}{x.offeredItemCode ? <div><span className="badge warn">alternatif: {x.offeredItemCode}</span></div> : null}{x.source === "test_connector" ? <div className="muted" style={{ fontSize: 12 }}>{x.note?.startsWith("TEST") ? <span className="badge mode warn">TEST VERİSİ</span> : null} otomatik (distribütör)</div> : null}</td>
                <td className="num">{x.unitPrice !== null ? `${fmt(x.unitPrice)} ${x.currency}` : "—"}</td>
                <td className="num">{x.total ?? "—"} {x.cheapest ? <span className="badge ok">en ucuz</span> : null}</td>
                <td className="num">{x.leadTimeDays} gün {x.fastest ? <span className="badge ok">en hızlı</span> : null}</td>
                <td>{x.readyDate} {x.meetsNeedDate === false ? <span className="badge bad">ihtiyaç sonrası</span> : null}</td>
                <td>{x.moq ? <>{fmt(x.moq)}{x.moqAbove ? <span className="badge warn">talepten fazla</span> : null}</> : "—"}</td>
                <td>{x.validUntil ?? "—"} {x.expired ? <span className="badge bad">süresi doldu</span> : null}</td>
                <td className="num">{x.deviationPct !== null ? `%${x.deviationPct}` : "—"}</td>
                <td className="muted">{x.enteredBy}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
        {open && pick ? (
          <div className="row">
            <input aria-label="Seçim gerekçesi" placeholder="Gerekçe (en ucuz değilse, ihtiyaç tarihini karşılamıyorsa veya fiyat sapması varsa zorunlu)" value={reason} onChange={(e) => setReason(e.target.value)} style={{ flex: 1 }} />
            <button className="primary" disabled={award.isPending} onClick={() => award.mutate()}>Seç ve sipariş taslağı oluştur</button>
          </div>
        ) : null}
        <ErrorNotice error={award.error} />
      </section>
      {open ? (
        <section className="card">
          <div className="row between">
            <h2 style={{ margin: 0 }}>Teklif gir</h2>
            <button type="button" onClick={() => act.mutate(() => post<any>(`/api/rfqs/${id}/auto-quotes`).then((x) => setAuto(x)))}>Distribütörlerden otomatik teklif</button>
          </div>
          {auto ? <div className="notice">{auto.added.length ? `Eklenen: ${auto.added.join(", ")}. ` : "Eklenen yok. "}{auto.skipped.length ? `Atlanan: ${auto.skipped.join("; ")}.` : ""}</div> : null}
          <form className="row" style={{ flexWrap: "wrap" }} onSubmit={(e) => { e.preventDefault(); act.mutate(() => post(`/api/rfqs/${id}/quotes`, { supplierId: f.supplierId, unitPrice: f.unitPrice.replace(",", "."), currency: f.currency, leadTimeDays: Number(f.leadTimeDays), moq: f.moq || undefined, validUntil: f.validUntil || undefined, offeredItemId: f.offeredItemId || undefined }).then(() => setF({ ...f, supplierId: "", unitPrice: "", leadTimeDays: "", moq: "", offeredItemId: "" }))); }}>
            <label className="field">Tedarikçi<select aria-label="Teklif tedarikçisi" required value={f.supplierId} onChange={(e) => setF({ ...f, supplierId: e.target.value })}><option value="">Seçin</option>{sup.data?.filter((s) => s.status === "active").map((s) => <option key={s.id} value={s.id}>{s.code} — {s.name}</option>)}</select></label>
            {r.approvedAlternates?.some((a: any) => a.general) ? (
              <label className="field">Teklif edilen kalem<select aria-label="Teklif edilen kalem" value={f.offeredItemId} onChange={(e) => setF({ ...f, offeredItemId: e.target.value })}>
                <option value="">{r.itemCode} (istenen)</option>
                {r.approvedAlternates.filter((a: any) => a.general).map((a: any) => <option key={a.itemId} value={a.itemId}>{a.code} (onaylı alternatif)</option>)}
              </select></label>
            ) : null}
            <label className="field" style={{ width: 110 }}>Birim fiyat<input aria-label="Birim fiyat" required inputMode="decimal" value={f.unitPrice} onChange={(e) => setF({ ...f, unitPrice: e.target.value })} /></label>
            <label className="field" style={{ width: 80 }}>Para<input aria-label="Para birimi" value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} /></label>
            <label className="field" style={{ width: 100 }}>Temin (gün)<input aria-label="Temin süresi" required inputMode="numeric" value={f.leadTimeDays} onChange={(e) => setF({ ...f, leadTimeDays: e.target.value })} /></label>
            <label className="field" style={{ width: 100 }}>MOQ<input aria-label="MOQ" inputMode="decimal" value={f.moq} onChange={(e) => setF({ ...f, moq: e.target.value })} /></label>
            <label className="field">Geçerlilik<input type="date" value={f.validUntil} onChange={(e) => setF({ ...f, validUntil: e.target.value })} /></label>
            <button className="primary" style={{ alignSelf: "flex-end" }}>Kaydet</button>
          </form>
          <p className="muted" style={{ margin: 0 }}>Aynı tedarikçinin aynı kalem için yeni teklifi öncekinin yerine geçer; önceki değer işlem geçmişinde kalır.</p>
          <ErrorNotice error={act.error} />
        </section>
      ) : null}
      {r.status === "open" ? <ItemOffers itemId={r.itemId} qty={Number(r.qty)} /> : null}
      <History entityType="rfq" id={r.id} />
    </>
  );
}

// ---- Siparişler ------------------------------------------------------------------------------
export function PurchaseOrdersPage() {
  const q = useQuery({ queryKey: ["pos2"], queryFn: () => get<any[]>("/api/purchase-orders") });
  return (
    <>
      <Header />
      <section className="card">
        <h2>Satın alma siparişleri</h2>
        {q.isLoading ? <Loading /> : <ErrorNotice error={q.error} />}
        {q.data?.length === 0 ? <Empty>Sipariş yok.</Empty> : null}
        {q.data?.length ? (
          <table>
            <thead><tr><th>Kod</th><th>Tedarikçi</th><th>Durum</th><th className="num">Satır</th><th>Sıradaki teyit</th><th>Uyarı</th><th>Oluşturma</th></tr></thead>
            <tbody>{q.data.map((p) => (
              <tr key={p.id}>
                <td className="mono"><Link to={`/purchasing/orders/${p.id}`}>{p.code}</Link></td><td>{p.supplierName}</td>
                <td><span className={`badge ${PO_STATUS[p.status]![1]}`}>{PO_STATUS[p.status]![0]}</span></td><td className="num">{p.lines}</td><td>{p.nextDate ?? "—"}</td>
                <td>{p.overdue ? <span className="badge bad">{p.overdue} gecikmiş</span> : null}{p.unconfirmed && p.status !== "draft" ? <span className="badge warn">{p.unconfirmed} teyitsiz</span> : null}</td>
                <td className="muted">{fmtDate(p.createdAt)}</td>
              </tr>
            ))}</tbody>
          </table>
        ) : null}
      </section>
    </>
  );
}

export function PurchaseOrderPage() {
  const { id } = useParams();
  const can = useCan();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["po", id], queryFn: () => get<any>(`/api/purchase-orders/${id}`) });
  const [last, setLast] = useState<any>(null);
  const act = useMutation({ mutationFn: (f: () => Promise<any>) => f(), onSuccess: (r) => { if (r && "impact" in r) setLast(r); qc.invalidateQueries({ queryKey: ["po", id] }); qc.invalidateQueries({ queryKey: ["history"] }); } });
  const [conf, setConf] = useState<Record<string, { date: string; ref: string; note: string }>>({});
  const [cancel, setCancel] = useState("");
  const p = q.data;
  if (!p) return q.isLoading ? <Loading /> : <ErrorNotice error={q.error} />;
  const manage = can("purchase.order.manage");
  return (
    <>
      <PageHeader title={`${p.code} — ${p.supplierName}`} sub={<>{p.supplierEmail ?? "e-posta yok"} · {p.total ? `toplam ${fmt(p.total)} ${p.currency}` : ""} · oluşturan {p.createdBy} {fmtDate(p.createdAt)} · <Link to="/purchasing/orders">← Siparişler</Link></>}
        actions={<span className={`badge ${PO_STATUS[p.status]![1]}`}>{PO_STATUS[p.status]![0]}</span>} />
      <ErrorNotice error={act.error} />
      {p.sentAt ? <div className="notice info">Gönderim <span className="badge mode warn">TEST</span>: {fmtDate(p.sentAt)} ({p.sentBy}) — tedarikçiye gerçek e-posta/EDI gönderilmedi; çıkış kutusuna yazıldı.</div> : null}
      {p.cancelReason ? <div className="notice">İptal: {p.cancelReason}</div> : null}
      {last?.slipDays > 0 ? (
        <div className="notice warn" role="status">
          Teyit {last.slipDays} gün kaydı. {last.impact.length ? <>Etkilenen satış siparişleri: {last.impact.map((o: any) => `${o.orderCode} (${o.customer}${o.atRisk ? ", termin riskte — satış ve üretime görev açıldı" : ""})`).join("; ")}</> : "Bağlı satış siparişi yok."}
        </div>
      ) : null}
      <section className="card">
        <h2>Satırlar</h2>
        <table>
          <thead><tr><th>Kalem</th><th className="num">Sipariş</th><th className="num">Alınan</th><th className="num">Birim</th><th>İstenen</th><th>Teyit</th><th>Teyit geçmişi</th><th /></tr></thead>
          <tbody>{p.lines.map((l: any) => {
            const c = conf[l.id] ?? { date: "", ref: "", note: "" };
            return (
              <tr key={l.id}>
                <td><span className="mono">{l.itemCode}</span><div className="muted">{l.mpn} {l.prCode ? `· ${l.prCode}` : ""}</div></td>
                <td className="num">{fmt(l.qtyOrdered)}</td><td className="num">{fmt(l.qtyReceived)}</td><td className="num">{l.unitPrice !== null ? fmt(l.unitPrice) : "—"}</td>
                <td>{l.requestedDate ?? "—"}</td>
                <td>{l.confirmedDate ?? <span className="badge warn">teyitsiz</span>} {l.overdue ? <span className="badge bad">gecikti</span> : null}</td>
                <td className="muted" style={{ fontSize: 13 }}>{l.confirmations.map((x: any, i: number) => <div key={i}>{x.date}{x.slipDays ? ` (${x.slipDays > 0 ? "+" : ""}${x.slipDays} g)` : ""}{x.reference ? ` · ${x.reference}` : ""}{x.note ? ` · ${x.note}` : ""} — {x.by}</div>)}</td>
                <td>{manage && l.status === "open" && ["sent", "confirmed", "partially_received"].includes(p.status) ? (
                  <div className="stack" style={{ gap: 4 }}>
                    <input aria-label={`${l.itemCode} teyit tarihi`} type="date" value={c.date} onChange={(e) => setConf({ ...conf, [l.id]: { ...c, date: e.target.value } })} />
                    <input aria-label={`${l.itemCode} tedarikçi ref`} placeholder="Tedarikçi ref." value={c.ref} onChange={(e) => setConf({ ...conf, [l.id]: { ...c, ref: e.target.value } })} />
                    <input aria-label={`${l.itemCode} not`} placeholder="Not (tarih kayarsa zorunlu)" value={c.note} onChange={(e) => setConf({ ...conf, [l.id]: { ...c, note: e.target.value } })} />
                    <button disabled={!c.date} onClick={() => act.mutate(() => post(`/api/purchase-orders/${id}/lines/${l.id}/confirm`, { confirmedDate: c.date, supplierReference: c.ref || undefined, note: c.note || undefined }).then((r) => { setConf({ ...conf, [l.id]: { date: "", ref: "", note: "" } }); return r; }))}>Teyit kaydet</button>
                  </div>
                ) : null}</td>
              </tr>
            );
          })}</tbody>
        </table>
        {manage ? (
          <div className="row">
            {p.status === "draft" ? <button className="primary" onClick={() => act.mutate(() => post(`/api/purchase-orders/${id}/send`))}>Tedarikçiye gönder (test)</button> : null}
            {["draft", "sent", "confirmed"].includes(p.status) ? (
              <>
                <input aria-label="İptal gerekçesi" placeholder="İptal gerekçesi" value={cancel} onChange={(e) => setCancel(e.target.value)} />
                <button className="danger" disabled={cancel.length < 3} onClick={() => act.mutate(() => post(`/api/purchase-orders/${id}/cancel`, { reason: cancel }))}>Siparişi iptal et</button>
              </>
            ) : null}
          </div>
        ) : null}
        <p className="muted" style={{ margin: 0 }}>Mal kabul bu siparişin satırına bağlanınca durum otomatik ilerler (kısmi / tamamı teslim).</p>
      </section>
      <Discussion entityType="purchase_order" entityId={p.id} />
      <History entityType="purchase_order" id={p.id} />
    </>
  );
}

// ---- Takip -------------------------------------------------------------------------------------
export function FollowupsPage() {
  const can = useCan();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["followups"], queryFn: () => get<any[]>("/api/purchasing/followups") });
  const run = useMutation({ mutationFn: () => post<any>("/api/purchasing/followups/run"), onSuccess: () => qc.invalidateQueries({ queryKey: ["followups"] }) });
  const ST: Record<string, [string, string]> = { unconfirmed: ["teyitsiz", "warn"], overdue: ["gecikmiş", "bad"], due_soon: ["7 gün içinde", ""] };
  return (
    <>
      <Header />
      <section className="card">
        <div className="row between">
          <h2 style={{ margin: 0 }}>Tedarikçi takibi</h2>
          {can("purchase.order.manage") ? <button onClick={() => run.mutate()}>Hatırlatmaları şimdi tara</button> : null}
        </div>
        <p className="muted" style={{ margin: 0 }}>Gönderimden 3 gün sonra teyit gelmeyen ve teyit tarihi geçip eksik teslim edilen satırlar için satın almaya görev ve (test modunda) tedarikçiye hatırlatma kaydı; satır başına günde bir kez. Arka plan her dakika tarar.</p>
        {run.data ? <div className="notice">{run.data.followups} satır için takip açıldı.</div> : null}
        <ErrorNotice error={run.error ?? q.error} />
        {q.data?.length === 0 ? <Empty>Takip gerektiren satır yok.</Empty> : null}
        {q.data?.length ? (
          <table>
            <thead><tr><th>Durum</th><th>Sipariş</th><th>Tedarikçi</th><th>Kalem</th><th className="num">Kalan</th><th>İstenen</th><th>Teyit</th><th className="num">Gecikme</th></tr></thead>
            <tbody>{q.data.map((x) => (
              <tr key={x.lineId}>
                <td><span className={`badge ${ST[x.state]![1]}`}>{ST[x.state]![0]}</span></td>
                <td className="mono"><Link to={`/purchasing/orders/${x.poId}`}>{x.poCode}</Link></td><td>{x.supplierName}</td><td className="mono">{x.itemCode}</td>
                <td className="num">{fmt(String(Number(x.qtyOrdered) - Number(x.qtyReceived)))}</td><td>{x.requestedDate ?? "—"}</td><td>{x.confirmedDate ?? "—"}</td><td className="num">{x.daysLate ? `${x.daysLate} gün` : ""}</td>
              </tr>
            ))}</tbody>
          </table>
        ) : null}
      </section>
    </>
  );
}
