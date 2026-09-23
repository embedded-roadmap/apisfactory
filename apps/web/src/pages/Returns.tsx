import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, newKey, post } from "../lib/api";
import { Empty, ErrorNotice, Loading, PageHeader, StateBadge, fmt, fmtDate, useCan } from "../lib/ui";
import { History } from "./Sales";
import { addressText } from "./Shipping";

export const KIND: Record<string, string> = { return: "İade", warranty: "Garanti", field_failure: "Saha arızası" };
export const CAUSE: Record<string, string> = {
  manufacturing: "Üretim hatası", component: "Komponent", design: "Tasarım", firmware: "Firmware",
  customer_damage: "Müşteri kaynaklı hasar", no_fault_found: "Arıza bulunamadı", unknown: "Belirlenemedi",
};
export const DISPOSITION: Record<string, string> = {
  return_as_is: "Olduğu gibi iade", repair: "Tamir", replace: "Değişim", scrap: "Hurda", restock: "Stoğa al",
};

/** İade listesi ve yeni iade: seri/lot okutulur, müşteri ve garanti sistemden bulunur. */
export function ReturnsPage() {
  const can = useCan();
  const nav = useNavigate();
  const [status, setStatus] = useState("");
  const q = useQuery({ queryKey: ["rmas", status], queryFn: () => get<any[]>(`/api/rmas${status ? `?status=${status}` : ""}`) });
  return (
    <>
      <PageHeader title="İade ve garanti" sub="İade malı sağlam stoğa kendiliğinden girmez: iade kabul alanına alınır, kalite kararıyla yönlenir." actions={
        <select aria-label="Durum filtresi" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Tümü</option>
          {["open", "received", "inspected", "decided", "closed", "cancelled"].map((s) => <option key={s} value={s}>{RMA_LABEL[s]}</option>)}
        </select>
      } />
      {can("rma.create") ? <NewRma /> : null}
      <section className="card">
        {q.isLoading ? <Loading /> : <ErrorNotice error={q.error} />}
        {q.data?.length === 0 ? <Empty>İade kaydı yok.</Empty> : null}
        {q.data && q.data.length > 0 ? (
          <table>
            <thead><tr><th>İade</th><th>Tür</th><th>Müşteri</th><th>Ürün</th><th>Seri / lot</th><th className="num">Miktar</th><th>Garanti</th><th>Neden</th><th>Karar</th><th>Durum</th></tr></thead>
            <tbody>
              {q.data.map((r) => (
                <tr key={r.id} className="click" onClick={() => nav(`/returns/${r.id}`)}>
                  <td className="mono">{r.code}</td><td>{KIND[r.kind]}</td><td>{r.customerName}</td><td className="mono">{r.productCode}</td>
                  <td className="mono">{r.serial ?? r.lotNo}</td><td className="num">{fmt(r.qty)}</td>
                  <td>{r.inWarranty === null ? "—" : r.inWarranty ? <span className="badge ok">İçinde</span> : <span className="badge bad">Dışında</span>}</td>
                  <td>{r.cause ? CAUSE[r.cause] : "—"}</td><td>{r.disposition ? DISPOSITION[r.disposition] : "—"}</td><td><StateBadge value={r.status} prefix="rma" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>
    </>
  );
}

export const RMA_LABEL: Record<string, string> = { open: "Açık", received: "Teslim alındı", inspected: "İncelendi", decided: "Karar verildi", closed: "Kapandı", cancelled: "İptal" };

function NewRma() {
  const nav = useNavigate();
  const [code, setCode] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [f, setF] = useState({ kind: "warranty", qty: "", complaint: "" });
  const [key] = useState(newKey());
  const customers = useQuery({ queryKey: ["customers"], queryFn: () => get<any[]>("/api/customers") });
  const look = useMutation({ mutationFn: () => get<any>(`/api/rma-lookup?code=${encodeURIComponent(code.trim())}${customerId ? `&customerId=${customerId}` : ""}`) });
  const create = useMutation({
    mutationFn: () => post<any>("/api/rmas", { code: code.trim(), customerId: customerId || undefined, qty: f.qty || undefined, kind: f.kind, complaint: f.complaint }, { "idempotency-key": key }),
    onSuccess: (r) => nav(`/returns/${r.id}`),
  });
  const src = look.data;
  return (
    <section className="card">
      <h2>Yeni iade</h2>
      <form className="row" onSubmit={(e: FormEvent) => { e.preventDefault(); look.mutate(); }}>
        <label className="field" style={{ flex: 1 }}>Seri veya bitmiş ürün lotu<input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Okutun veya yazın" /></label>
        <label className="field">Müşteri (lot için zorunlu)
          <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            <option value="">Sevkiyattan bul</option>
            {customers.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <button style={{ alignSelf: "flex-end" }} disabled={!code.trim() || look.isPending}>Sorgula</button>
      </form>
      <ErrorNotice error={look.error} />
      {src ? (
        <div className="stack">
          <div className="grid4">
            <div className="stat"><small>Ürün</small><b style={{ fontSize: 15 }}>{src.productCode} Rev.{src.rev}</b><small className="mono">{src.serial ?? `lot · iade edilebilir ${fmt(src.returnableQty)}`}</small></div>
            <div className="stat"><small>Müşteri</small><b style={{ fontSize: 15 }}>{src.customerName ?? customers.data?.find((c) => c.id === src.customerId)?.name ?? "—"}</b><small className="mono">{src.salesOrderCode ?? ""}</small></div>
            <div className="stat"><small>Sevk</small><b style={{ fontSize: 15 }}>{fmtDate(src.shippedAt)}</b><small className="mono">{src.shipmentCode ?? "sevkiyat kaydı yok"}</small></div>
            <div className="stat"><small>Garanti ({src.warrantyMonths} ay)</small><b style={{ fontSize: 15 }}>{src.inWarranty === null ? "Hesaplanamadı" : src.inWarranty ? "İçinde" : "Dışında"}</b><small>{src.warrantyUntil ? `bitiş ${src.warrantyUntil}` : ""}</small></div>
          </div>
          {src.serial && src.deviceStatus !== "shipped" ? <div className="notice warn">Cihaz müşteride görünmüyor (durum: {src.deviceStatus}).</div> : null}
          <form className="row" onSubmit={(e: FormEvent) => { e.preventDefault(); create.mutate(); }}>
            <label className="field">Tür
              <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
            </label>
            {!src.serial ? <label className="field" style={{ width: 100 }}>Miktar<input required inputMode="decimal" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} /></label> : null}
            <label className="field" style={{ flex: 1 }}>Müşteri şikâyeti<input required minLength={5} value={f.complaint} onChange={(e) => setF({ ...f, complaint: e.target.value })} /></label>
            <button className="primary" style={{ alignSelf: "flex-end" }} disabled={create.isPending}>İade aç</button>
          </form>
          <ErrorNotice error={create.error} />
        </div>
      ) : null}
    </section>
  );
}

export function ReturnPage() {
  const { id } = useParams();
  const can = useCan();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["rma", id], queryFn: () => get<any>(`/api/rmas/${id}`) });
  const refresh = () => { qc.invalidateQueries({ queryKey: ["rma", id] }); qc.invalidateQueries({ queryKey: ["history"] }); };
  const act = useMutation({ mutationFn: (f: () => Promise<unknown>) => f(), onSuccess: refresh });
  const [inspect, setInspect] = useState({ finding: "", cause: "unknown", openChangeRequest: false });
  const [decide, setDecide] = useState({ disposition: "repair", note: "", creditNote: false, replacementCode: "", retestPassed: false });
  const [repair, setRepair] = useState({ note: "", retestPassed: true });
  const [ship, setShip] = useState({ carrier: "", trackingNo: "" });
  const [shipKey] = useState(newKey());
  const [cancel, setCancel] = useState("");
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNotice error={q.error} />;
  const r = q.data;
  const canRedecide = r.status === "decided" && r.disposition === "repair" && r.retestPassed === false;
  return (
    <>
      <PageHeader
        title={`İade ${r.code}`}
        sub={<>{KIND[r.kind]} · {r.customerName} · {r.productCode} Rev.{r.rev} · {r.serial ? <Link to={`/devices/${r.serial}`} className="mono">{r.serial}</Link> : <span className="mono">lot {r.lotNo} × {fmt(r.qty)}</span>} · <Link to="/returns">← İadeler</Link></>}
        actions={<><StateBadge value={r.status} prefix="rma" />{r.inWarranty === null ? null : r.inWarranty ? <span className="badge ok">Garanti içinde</span> : <span className="badge bad">Garanti dışında</span>}</>}
      />
      <ErrorNotice error={act.error} />
      <section className="card">
        <div className="grid4">
          <div className="stat"><small>Şikâyet</small><b style={{ fontSize: 15 }}>{r.complaint}</b><small>{r.openedBy} · {fmtDate(r.createdAt)}</small></div>
          <div className="stat"><small>Sevk / sipariş</small><b style={{ fontSize: 15 }} className="mono">{r.shipmentCode ?? "—"}</b><small>{r.salesOrderCode ? <Link to={`/sales/${r.salesOrderId}`}>{r.salesOrderCode}</Link> : null} · {fmtDate(r.shippedAt)}</small></div>
          <div className="stat"><small>Garanti bitişi</small><b style={{ fontSize: 15 }}>{r.warrantyUntil ?? "—"}</b></div>
          <div className="stat"><small>Teslim alındı</small><b style={{ fontSize: 15 }}>{fmtDate(r.receivedAt)}</b><small>{r.serial ? `cihaz: ${r.deviceStatus}` : ""}</small></div>
        </div>
        {r.finding ? <p style={{ margin: 0 }}><b>Bulgu ({CAUSE[r.cause]}):</b> {r.finding} <span className="muted">— {r.inspectedBy}</span> {r.changeRequestId ? <Link to={`/changes/${r.changeRequestId}`} className="mono">{r.changeRequestCode}</Link> : null}</p> : null}
        {r.disposition ? <p style={{ margin: 0 }}><b>Karar: {DISPOSITION[r.disposition]}</b> — {r.dispositionNote} <span className="muted">({r.decidedBy})</span>{r.creditNoteRequested ? <span className="badge warn">Alacak belgesi talebi muhasebede</span> : null}</p> : null}
        {r.replacementSerial || r.replacementLotNo ? <p style={{ margin: 0 }}>Değişim ürünü: <span className="mono">{r.replacementSerial ?? r.replacementLotNo}</span></p> : null}
        {r.repairNote ? <p style={{ margin: 0 }}>Tamir: {r.repairNote} — {r.retestPassed ? <span className="badge ok">Tekrar test geçti</span> : <span className="badge bad">Tekrar test kaldı</span>}</p> : null}
        {r.outboundCarrier ? <p style={{ margin: 0 }}>Gönderim: {r.outboundCarrier} <span className="mono">{r.outboundTracking ?? ""}</span> · {addressText(r.outboundAddress)}</p> : null}
      </section>

      {r.status === "open" && can("inventory.receive") ? (
        <section className="card">
          <div className="row">
            <button className="primary" onClick={() => act.mutate(() => post(`/api/rmas/${id}/receive`, {}))}>Teslim al (iade kabul alanına)</button>
            <span className="muted">Satılabilir stok değişmez.</span>
          </div>
        </section>
      ) : null}

      {r.status === "received" && can("rma.decide") ? (
        <section className="card">
          <h2>İnceleme</h2>
          <form className="stack" onSubmit={(e) => { e.preventDefault(); act.mutate(() => post(`/api/rmas/${id}/inspect`, inspect)); }}>
            <label className="field">Bulgu<textarea required minLength={5} rows={3} value={inspect.finding} onChange={(e) => setInspect({ ...inspect, finding: e.target.value })} /></label>
            <div className="row">
              <label className="field">Kök neden
                <select value={inspect.cause} onChange={(e) => setInspect({ ...inspect, cause: e.target.value })}>{Object.entries(CAUSE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
              </label>
              {["design", "component", "firmware", "manufacturing"].includes(inspect.cause) ? (
                <label className="row" style={{ gap: 6, alignSelf: "flex-end" }}><input type="checkbox" style={{ minHeight: 0 }} checked={inspect.openChangeRequest} onChange={(e) => setInspect({ ...inspect, openChangeRequest: e.target.checked })} /> Ar-Ge'ye değişiklik talebi aç</label>
              ) : null}
              <button className="primary" style={{ alignSelf: "flex-end" }}>İncelemeyi kaydet</button>
            </div>
          </form>
        </section>
      ) : null}

      {(r.status === "inspected" || canRedecide) && can("rma.decide") ? (
        <section className="card">
          <h2>{canRedecide ? "Tamir başarısız — yeniden karar" : "Karar"}</h2>
          <form className="stack" onSubmit={(e) => {
            e.preventDefault();
            act.mutate(() => post(`/api/rmas/${id}/decide`, { ...decide, replacementCode: decide.replacementCode || undefined, retestPassed: decide.disposition === "restock" ? decide.retestPassed : undefined }));
          }}>
            <div className="row">
              <label className="field">Karar
                <select aria-label="Karar" value={decide.disposition} onChange={(e) => setDecide({ ...decide, disposition: e.target.value })}>
                  {Object.entries(DISPOSITION).filter(([k]) => r.serial || !["repair", "restock"].includes(k)).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </label>
              {decide.disposition === "replace" ? <label className="field">Değişim seri/lot (okut)<input required value={decide.replacementCode} onChange={(e) => setDecide({ ...decide, replacementCode: e.target.value })} /></label> : null}
              {decide.disposition === "restock" ? (
                <label className="row" style={{ gap: 6, alignSelf: "flex-end" }}><input type="checkbox" style={{ minHeight: 0 }} checked={decide.retestPassed} onChange={(e) => setDecide({ ...decide, retestPassed: e.target.checked })} /> Tekrar test geçti</label>
              ) : null}
              <label className="row" style={{ gap: 6, alignSelf: "flex-end" }}>
                <input type="checkbox" style={{ minHeight: 0 }} disabled={r.inWarranty === false || r.cause === "customer_damage"} checked={decide.creditNote} onChange={(e) => setDecide({ ...decide, creditNote: e.target.checked })} /> Alacak belgesi talebi (muhasebe)
              </label>
            </div>
            <label className="field">Gerekçe<input required minLength={3} value={decide.note} onChange={(e) => setDecide({ ...decide, note: e.target.value })} /></label>
            <div className="row"><button className="primary">Kararı kaydet</button></div>
            <p className="muted" style={{ margin: 0 }}>Stoğa alma yalnızca "arıza bulunamadı" + tekrar test geçti ile. Değişimde iade gelen ürün karantinaya alınır. Hurda ve stoğa alma iadeyi kapatır.</p>
          </form>
        </section>
      ) : null}

      {r.status === "decided" && r.disposition === "repair" && r.retestPassed === null && can("production.test.record") ? (
        <section className="card">
          <h2>Tamir ve tekrar test</h2>
          <form className="row" onSubmit={(e) => { e.preventDefault(); act.mutate(() => post(`/api/rmas/${id}/repair`, repair)); }}>
            <label className="field" style={{ flex: 1 }}>Tamir notu<input required minLength={3} value={repair.note} onChange={(e) => setRepair({ ...repair, note: e.target.value })} /></label>
            <label className="field">Tekrar test
              <select value={repair.retestPassed ? "pass" : "fail"} onChange={(e) => setRepair({ ...repair, retestPassed: e.target.value === "pass" })}><option value="pass">Geçti</option><option value="fail">Kaldı</option></select>
            </label>
            <button className="primary" style={{ alignSelf: "flex-end" }}>Kaydet</button>
          </form>
        </section>
      ) : null}

      {r.status === "decided" && ["return_as_is", "replace"].concat(r.retestPassed ? ["repair"] : []).includes(r.disposition) && can("shipment.create") ? (
        <section className="card">
          <h2>Müşteriye gönder</h2>
          <form className="row" onSubmit={(e) => { e.preventDefault(); act.mutate(() => post(`/api/rmas/${id}/ship-back`, { carrier: ship.carrier, trackingNo: ship.trackingNo || undefined }, { "idempotency-key": shipKey })); }}>
            <label className="field">Kargo / taşıyıcı<input required minLength={2} value={ship.carrier} onChange={(e) => setShip({ ...ship, carrier: e.target.value })} /></label>
            <label className="field">Takip no<input value={ship.trackingNo} onChange={(e) => setShip({ ...ship, trackingNo: e.target.value })} /></label>
            <button className="primary" style={{ alignSelf: "flex-end" }}>Gönder ve kapat</button>
          </form>
          <p className="muted" style={{ margin: 0 }}>{r.disposition === "replace" ? `Değişim ürünü (${r.replacementSerial ?? r.replacementLotNo}) stoktan düşülür.` : "İade kabul alanındaki ürün müşteriye geri gider."} Müşterinin varsayılan adresi kullanılır; kargo bağlayıcısı bağlı değil.</p>
        </section>
      ) : null}

      {r.status === "open" && can("rma.create") ? (
        <section className="card">
          <div className="row">
            <input aria-label="İptal gerekçesi" placeholder="İptal gerekçesi" value={cancel} onChange={(e) => setCancel(e.target.value)} style={{ flex: 1 }} />
            <button className="danger" disabled={cancel.length < 3} onClick={() => act.mutate(() => post(`/api/rmas/${id}/cancel`, { reason: cancel }))}>İadeyi iptal et</button>
          </div>
        </section>
      ) : null}
      <History entityType="rma" id={r.id} />
    </>
  );
}

/** Cihaz geçmişi: seri → revizyon, BOM, lotlar, testler, sevkiyat, iade (prompt §22). */
export function DevicePage() {
  const { serial } = useParams();
  const nav = useNavigate();
  const [code, setCode] = useState(serial ?? "");
  const q = useQuery({ enabled: !!serial, queryKey: ["device", serial], queryFn: () => get<any>(`/api/devices/${encodeURIComponent(serial!)}`) });
  const d = q.data;
  return (
    <>
      <PageHeader title="Cihaz geçmişi" sub="Seri numarasından üretim, test, sevkiyat ve iade kaydı." />
      <section className="card">
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (code.trim()) nav(`/devices/${encodeURIComponent(code.trim())}`); }}>
          <label className="field" style={{ flex: 1 }}>Seri numarası<input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Okutun veya yazın" /></label>
          <button className="primary" style={{ alignSelf: "flex-end" }}>Göster</button>
        </form>
      </section>
      {q.isLoading ? <Loading /> : <ErrorNotice error={q.error} />}
      {d ? (
        <>
          <section className="card">
            <div className="row between"><h2 className="mono">{d.serial}</h2><StateBadge value={d.status} prefix="dev" /></div>
            <div className="grid4">
              <div className="stat"><small>Ürün</small><b style={{ fontSize: 15 }}>{d.productCode} Rev.{d.rev}</b><small>BOM v{d.bomVersionNo}</small></div>
              <div className="stat"><small>İş emri</small><b style={{ fontSize: 15 }}><Link to={`/production/${d.workOrderId}`} className="mono">{d.workOrderCode}</Link></b><small>bitmiş lot {d.finishedLotNo ?? "—"}</small></div>
              <div className="stat"><small>Müşteri</small><b style={{ fontSize: 15 }}>{d.shipments.at(-1)?.customerName ?? "—"}</b><small className="mono">{d.shipments.at(-1)?.code ?? ""}</small></div>
              <div className="stat"><small>İade</small><b style={{ fontSize: 15 }}>{d.rmas.length}</b></div>
            </div>
          </section>
          <section className="card">
            <h2>Testler</h2>
            {d.testRuns.length === 0 ? <Empty>Test kaydı yok.</Empty> : (
              <table><thead><tr><th>#</th><th>Sonuç</th><th>Plan</th><th>Ekipman</th><th>Firmware</th><th>Ölçümler</th><th>Operatör</th><th>Zaman</th></tr></thead>
                <tbody>{d.testRuns.map((t: any) => (
                  <tr key={t.runNo}><td>{t.runNo}</td><td>{t.result === "pass" ? <span className="badge ok">geçti</span> : <span className="badge bad">kaldı</span>}</td><td>{t.testPlanVersion ? `v${t.testPlanVersion}` : "—"}</td>
                    <td className="mono">{t.equipmentCode ?? "—"}</td><td className="mono">{t.firmwareVersion ?? "—"}</td>
                    <td className="mono" style={{ fontSize: 12 }}>{(t.measurements ?? []).map((m: any) => `${m.name}=${m.value}${m.unit ?? ""}`).join(" ")}</td><td>{t.operator}</td><td className="muted">{fmtDate(t.createdAt)}</td></tr>
                ))}</tbody></table>
            )}
          </section>
          <section className="card">
            <h2>Malzeme lotları</h2>
            <table><tbody>{d.materialLots.map((l: any) => <tr key={l.itemCode + l.lotNo}><td className="mono">{l.itemCode}</td><td className="mono">{l.mpn}</td><td className="mono">{l.lotNo}</td><td className="num">{fmt(l.qty)}</td></tr>)}</tbody></table>
          </section>
          <section className="card">
            <h2>Sevkiyat ve iade</h2>
            {d.shipments.length === 0 && d.rmas.length === 0 ? <Empty>Sevk edilmemiş.</Empty> : null}
            <table><tbody>
              {d.shipments.map((s: any) => <tr key={s.code}><td>Sevk</td><td className="mono">{s.code}</td><td>{s.customerName}</td><td className="mono">{s.salesOrderCode}</td><td><StateBadge value={s.status} prefix="sh" /></td><td className="muted">{fmtDate(s.shippedAt)}</td></tr>)}
              {d.rmas.map((r: any) => <tr key={r.id} className="click" onClick={() => nav(`/returns/${r.id}`)}><td>{KIND[r.kind]}</td><td className="mono">{r.code}</td><td>{r.complaint}</td><td>{r.cause ? CAUSE[r.cause] : "—"}</td><td>{r.disposition ? DISPOSITION[r.disposition] : <StateBadge value={r.status} prefix="rma" />}</td><td className="muted">{fmtDate(r.createdAt)}</td></tr>)}
            </tbody></table>
          </section>
          <History entityType="device" id={d.id} />
        </>
      ) : null}
    </>
  );
}
