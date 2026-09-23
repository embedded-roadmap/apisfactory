import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, newKey, post } from "../lib/api";
import { Empty, ErrorNotice, Loading, PageHeader, StateBadge, fmt, fmtDate, useCan } from "../lib/ui";
import { History } from "./Sales";
import { WorkOrderCost } from "./Reports";
import { Discussion } from "../components/Discussion";

export function ProductionPage() {
  const can = useCan();
  const nav = useNavigate();
  const qc = useQueryClient();
  const needs = useQuery({ queryKey: ["needs"], queryFn: () => get<any[]>("/api/production-needs") });
  const wos = useQuery({ queryKey: ["wos"], queryFn: () => get<any[]>("/api/work-orders") });
  const create = useMutation({
    mutationFn: (productionNeedId: string) => post<any>("/api/work-orders", { productionNeedId }),
    onSuccess: (wo) => { qc.invalidateQueries({ queryKey: ["needs"] }); nav(`/production/${wo.id}`); },
  });
  const open = needs.data?.filter((n) => n.status === "planned") ?? [];
  return (
    <>
      <PageHeader title="Üretim" sub="İş emri yayımlanmış ürün sürümünü, BOM'u ve rotayı sabitler; sonraki revizyon veya rota sürümü açık işi değiştirmez." actions={<Link to="/production/routings">Rotalar & standart süreler</Link>} />
      <ErrorNotice error={create.error} />
      <section className="card">
        <h2>Planlanacak üretim ihtiyaçları</h2>
        {needs.isLoading ? <Loading /> : <ErrorNotice error={needs.error} />}
        {open.length === 0 ? <Empty>Bekleyen üretim ihtiyacı yok.</Empty> : null}
        {open.length > 0 ? (
          <table>
            <thead><tr><th>Ürün</th><th className="num">Miktar</th><th>Sipariş</th><th>İstenen tarih</th><th /></tr></thead>
            <tbody>
              {open.map((n) => (
                <tr key={n.id}>
                  <td className="mono">{n.productCode} Rev.{n.rev}</td><td className="num">{fmt(n.qty)}</td><td className="mono">{n.salesOrderCode}</td><td>{n.requestedDate}</td>
                  <td>{can("production.plan") ? <button className="primary" disabled={create.isPending} onClick={() => create.mutate(n.id)}>İş emri aç</button> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>
      <section className="card">
        <h2>İş emirleri</h2>
        {wos.data?.length === 0 ? <Empty /> : null}
        {wos.data && wos.data.length > 0 ? (
          <table>
            <thead><tr><th>İş emri</th><th>Ürün</th><th className="num">Miktar</th><th className="num">Serbest</th><th className="num">Hurda</th><th>Durum</th></tr></thead>
            <tbody>
              {wos.data.map((w) => (
                <tr key={w.id} className="click" onClick={() => nav(`/production/${w.id}`)}>
                  <td className="mono">{w.code}</td><td className="mono">{w.productCode} Rev.{w.rev}</td><td className="num">{fmt(w.qty)}</td>
                  <td className="num">{w.released}</td><td className="num">{w.scrapped}</td><td><StateBadge value={w.status} prefix="wo" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>
    </>
  );
}

export function WorkOrderPage() {
  const { id } = useParams();
  const can = useCan();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["wo", id], queryFn: () => get<any>(`/api/work-orders/${id}`) });
  const refresh = () => { qc.invalidateQueries({ queryKey: ["wo", id] }); qc.invalidateQueries({ queryKey: ["history"] }); };
  const act = useMutation({ mutationFn: (f: () => Promise<unknown>) => f(), onSuccess: refresh });
  const [pauseReason, setPauseReason] = useState("");
  const [equipmentId, setEquipmentId] = useState("");
  const [firmware, setFirmware] = useState("");
  const equipment = useQuery({ queryKey: ["equipment"], queryFn: () => get<any[]>("/api/equipment") });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNotice error={q.error} />;
  const wo = q.data;
  const s = wo.stats;
  return (
    <>
      <PageHeader
        title={`İş emri ${wo.code}`}
        sub={<>{wo.productCode} Rev.{wo.rev} · BOM v{wo.bomVersionNo} (sabit) · rota {wo.routingVersionNo ? `v${wo.routingVersionNo}` : "varsayılan şablon"} (sabit) · firmware {wo.firmwareVersion ?? "tanımsız"} · test planı {wo.testPlan ? `v${wo.testPlan.versionNo}` : "yok"} · {wo.salesOrderCode ? `sipariş ${wo.salesOrderCode}` : "stok için"} · <Link to="/production">← Üretim</Link></>}
        actions={
          <div className="row">
            <StateBadge value={wo.status} prefix="wo" />
            {can("production.plan") && wo.status === "planned" ? <button className="primary" onClick={() => act.mutate(() => post(`/api/work-orders/${id}/release`))}>Yayımla (seri üret)</button> : null}
            {can("quality.final.release") && wo.status === "in_progress" && s.passed > 0 ? <button className="primary" onClick={() => act.mutate(() => post(`/api/work-orders/${id}/release-to-stock`))}>Son kalite: {s.passed} cihazı serbest bırak</button> : null}
            {can("production.plan") && wo.status === "in_progress" ? <button onClick={() => act.mutate(() => post(`/api/work-orders/${id}/complete`))}>İş emrini kapat</button> : null}
          </div>
        }
      />
      <ErrorNotice error={act.error} />
      {wo.status === "on_hold" ? <div className="notice bad"><strong>İş emri beklemede:</strong> {wo.holdReason}</div> : null}
      <HoldAndChange wo={wo} onDone={refresh} />
      <div className="grid4">
        <div className="stat"><small>Miktar</small><b>{fmt(wo.qty)}</b></div>
        <div className="stat"><small>İlk testte başarı</small><b>{s.firstPassYield == null ? "—" : `%${(s.firstPassYield * 100).toFixed(1)}`}</b><small>{s.first_passed}/{s.first_tested} ilk test</small></div>
        <div className="stat"><small>Serbest bırakılan</small><b>{s.released}</b></div>
        <div className="stat"><small>Hurda / yeniden işleme</small><b>{s.scrapped} / {s.reworked}</b></div>
      </div>

      <section className="card">
        <h2>Malzeme</h2>
        <table>
          <thead><tr><th>Kalem</th><th>MPN</th><th className="num">Gerekli</th><th className="num">Çıkılan</th><th className="num">Kalan</th><th /></tr></thead>
          <tbody>
            {wo.materials.map((m: any) => (
              <MaterialRow key={m.itemId} m={m} woId={id!} canIssue={can("inventory.issue") && ["released", "in_progress"].includes(wo.status)} onDone={refresh} />
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <div className="row between">
          <h2>Operasyonlar</h2>
          <input aria-label="Duraklatma nedeni" placeholder="Duraklatma nedeni" value={pauseReason} onChange={(e) => setPauseReason(e.target.value)} style={{ maxWidth: 320 }} />
        </div>
        <table>
          <thead><tr><th>#</th><th>Operasyon</th><th>İstasyon</th><th>Durum</th><th>Plan / gerçek</th><th /></tr></thead>
          <tbody>
            {wo.operations.map((o: any) => (
              <tr key={o.id}>
                <td>{o.seq}</td>
                <td>{o.name} {o.isQualityGate ? <span className="badge warn">Kalite kapısı</span> : null}{o.instructions ? <div className="muted" style={{ fontSize: 13 }}>{o.instructions}</div> : null}</td>
                <td className="mono">{o.workCenter}</td>
                <td><StateBadge value={o.status} prefix="op" /></td>
                <td className="muted">{o.plannedMinutes != null ? `${Math.round(o.plannedMinutes)} dk` : "—"} / {o.workedSeconds ? `${Math.round(o.workedSeconds / 60)} dk` : "—"}</td>
                <td className="row">
                  {can("production.execute") && ["pending", "paused"].includes(o.status) && ["released", "in_progress"].includes(wo.status) ? <button onClick={() => act.mutate(() => post(`/api/work-orders/${id}/operations/${o.id}/start`))}>Başla</button> : null}
                  {can("production.execute") && o.status === "in_progress" && wo.status !== "on_hold" ? (
                    <>
                      <button onClick={() => act.mutate(() => post(`/api/work-orders/${id}/operations/${o.id}/pause`, { reason: pauseReason || undefined }))}>Duraklat</button>
                      <button className="primary" onClick={() => act.mutate(() => post(`/api/work-orders/${id}/operations/${o.id}/complete`))}>Tamamla</button>
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>Cihazlar ve test</h2>
        {wo.devices.length === 0 ? <Empty>İş emri yayımlanınca seri numaraları oluşur.</Empty> : null}
        {wo.devices.length > 0 && can("production.test.record") ? (
          <div className="row">
            <label className="field">Test ekipmanı
              <select value={equipmentId} onChange={(e) => setEquipmentId(e.target.value)}>
                <option value="">{wo.testPlan ? "Seçin (zorunlu)" : "Seçin"}</option>
                {equipment.data?.map((e) => (
                  <option key={e.id} value={e.id} disabled={e.status !== "active" || e.calibrationExpired}>
                    {e.code} · {e.name}{e.status !== "active" ? " (hizmet dışı)" : e.calibrationExpired ? ` (kalibrasyon ${e.calibrationDue} doldu)` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">Cihazdaki firmware
              <input value={firmware} onChange={(e) => setFirmware(e.target.value)} placeholder={wo.firmwareVersion ? `beklenen ${wo.firmwareVersion}` : "isteğe bağlı"} style={{ width: 180 }} />
            </label>
            <span className="muted" style={{ alignSelf: "flex-end" }}>{wo.testPlan ? "Karar test planına göre sunucuda verilir." : "Test planı yok: sonucu siz seçersiniz."}</span>
          </div>
        ) : null}
        <table>
          <tbody>
            {wo.devices.map((d: any) => <DeviceRow key={d.serial} d={d} plan={wo.testPlan} ctx={{ equipmentId: equipmentId || undefined, firmwareVersion: firmware || undefined }} onDone={refresh} />)}
          </tbody>
        </table>
      </section>
      {can("field.cost.view") ? <WorkOrderCost woId={wo.id} /> : null}
      <Discussion entityType="work_order" entityId={wo.id} />
      <History entityType="work_order" id={wo.id} />
    </>
  );
}

function MaterialRow({ m, woId, canIssue, onDone }: { m: any; woId: string; canIssue: boolean; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [lotNo, setLotNo] = useState("");
  const [qty, setQty] = useState(m.remaining);
  const [key, setKey] = useState(newKey());
  const lots = useQuery({
    enabled: open,
    queryKey: ["lotsFor", m.itemId],
    queryFn: async () => {
      const own = (await get<any[]>(`/api/stock/balances?itemId=${m.itemId}`)).map((l) => ({ ...l, alt: null as string | null }));
      // W29: onaylı alternatiflerin lotları da seçilebilir (sunucu ürün kapsamını ayrıca doğrular)
      const alts = (await get<any[]>(`/api/alternates?status=approved&itemId=${m.itemId}`).catch(() => [])).filter((a) => a.itemId === m.itemId);
      for (const a of alts) for (const l of await get<any[]>(`/api/stock/balances?itemId=${a.alternateItemId}`)) own.push({ ...l, alt: a.alternateCode });
      return own;
    },
  });
  const issue = useMutation({
    mutationFn: async () => {
      const lot = lots.data?.find((l) => l.lotNo === lotNo);
      if (!lot) throw new Error("Lot seçin");
      return post(`/api/work-orders/${woId}/issue`, { lotId: lot.lotId, qty }, { "idempotency-key": key });
    },
    onSuccess: () => { setOpen(false); setKey(newKey()); onDone(); },
  });
  return (
    <>
      <tr>
        <td className="mono">{m.itemCode}</td><td className="mono">{m.mpn}</td><td className="num">{fmt(m.required)}</td><td className="num">{fmt(m.issued)}{Number(m.issuedAsAlternate) > 0 ? <div className="muted">alternatif {fmt(m.issuedAsAlternate)}</div> : null}</td>
        <td className="num">{m.complete ? <span className="badge ok">Tamam</span> : fmt(m.remaining)}</td>
        <td>{canIssue && !m.complete ? <button onClick={() => setOpen(!open)}>Çıkış yap</button> : null}</td>
      </tr>
      {open ? (
        <tr>
          <td colSpan={6}>
            <div className="row">
              <label className="field">Lot
                <select value={lotNo} onChange={(e) => setLotNo(e.target.value)}>
                  <option value="">Seçin…</option>
                  {lots.data?.map((l) => (
                    <option key={l.lotId + l.locationId} value={l.lotNo} disabled={l.locationType !== "stock"}>
                      {l.lotNo} · {l.locationCode} · {fmt(l.qty)}{l.alt ? ` · onaylı alternatif ${l.alt}` : ""}{l.locationType !== "stock" ? " (kullanılamaz)" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">Miktar<input value={qty} onChange={(e) => setQty(e.target.value)} inputMode="decimal" /></label>
              <button className="primary" style={{ alignSelf: "flex-end" }} disabled={issue.isPending} onClick={() => issue.mutate()}>Çıkışı kaydet</button>
            </div>
            <ErrorNotice error={issue.error} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

type TestCtx = { equipmentId?: string; firmwareVersion?: string };

function DeviceRow({ d, plan, ctx, onDone }: { d: any; plan: any | null; ctx: TestCtx; onDone: () => void }) {
  const can = useCan();
  const [note, setNote] = useState("");
  const [vals, setVals] = useState<Record<string, string>>({});
  const act = useMutation({ mutationFn: (f: () => Promise<any>) => f(), onSuccess: onDone });
  const runs: any[] = d.runs ?? [];
  const limits: any[] = plan?.limits ?? [{ name: "3V3", unit: "V", low: 3.2, high: 3.4, required: false }];
  const measurements = () =>
    limits.filter((l) => vals[l.name] !== undefined && vals[l.name] !== "").map((l) => ({ name: l.name, value: Number(vals[l.name]), ...(plan ? {} : { unit: l.unit, low: l.low, high: l.high }) }));
  const send = (result?: "pass" | "fail") => act.mutate(() => post(`/api/devices/${d.serial}/test`, { ...ctx, result, measurements: measurements() }));
  return (
    <tr>
      <td className="mono"><Link to={`/devices/${d.serial}`}>{d.serial}</Link></td>
      <td><StateBadge value={d.status} prefix="dev" /></td>
      <td className="muted">{runs.map((r) => `#${r.runNo} ${r.result === "pass" ? "geçti" : "kaldı"}`).join(" · ") || "test yok"}</td>
      <td>
        <div className="row">
          {can("production.test.record") && ["in_process", "rework"].includes(d.status) ? (
            <>
              {limits.map((l) => (
                <input key={l.name} aria-label={`${d.serial} ${l.name}`} placeholder={`${l.name}${l.unit ? ` (${l.unit})` : ""}${l.required ? "" : " ?"}`} title={`${l.low ?? "−∞"} … ${l.high ?? "+∞"}`}
                  value={vals[l.name] ?? ""} onChange={(e) => setVals({ ...vals, [l.name]: e.target.value })} style={{ width: 110 }} inputMode="decimal" />
              ))}
              {plan ? (
                <button className="primary" onClick={() => send()}>Testi kaydet</button>
              ) : (
                <button onClick={() => send("pass")}>Geçti</button>
              )}
              <button className="danger" title="Ölçüm dışı hata (görsel, fonksiyon)" onClick={() => send("fail")}>Kaldı</button>
            </>
          ) : null}
          {can("quality.final.release") && d.status === "test_failed" ? (
            <>
              <input aria-label="Karar gerekçesi" placeholder="Gerekçe" value={note} onChange={(e) => setNote(e.target.value)} />
              <button onClick={() => act.mutate(() => post(`/api/devices/${d.serial}/disposition`, { decision: "rework", note }))}>Yeniden işle</button>
              <button className="danger" onClick={() => act.mutate(() => post(`/api/devices/${d.serial}/disposition`, { decision: "scrap", note }))}>Hurda</button>
            </>
          ) : null}
        </div>
        {act.data?.outOfLimit?.length ? <div className="notice warn">Limit dışı: {act.data.outOfLimit.join(", ")} → kaldı</div> : null}
        <ErrorNotice error={act.error} />
      </td>
    </tr>
  );
}

/** Bekletme / devam ve değişiklik talebi. Talep BOM'u değiştirmez; üretimi durdur işaretliyse iş emri bekletilir. */
function HoldAndChange({ wo, onDone }: { wo: any; onDone: () => void }) {
  const can = useCan();
  const nav = useNavigate();
  const [reason, setReason] = useState("");
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ title: "", description: "", urgency: "normal", stopProduction: false, deviceSerial: "" });
  const act = useMutation({ mutationFn: (fn: () => Promise<any>) => fn(), onSuccess: () => { setReason(""); onDone(); } });
  const create = useMutation({
    mutationFn: () => post<any>("/api/change-requests", { workOrderId: wo.id, ...f, deviceSerial: f.deviceSerial || undefined }),
    onSuccess: (cr) => { onDone(); nav(`/changes/${cr.id}`); },
  });
  const active = ["released", "in_progress", "on_hold"].includes(wo.status);
  if (!active && !wo.changeRequests.length) return null;
  return (
    <section className="card">
      <div className="row between">
        <h2>Bekletme ve değişiklik talepleri</h2>
        {can("change.create") && active ? <button onClick={() => setOpen(!open)}>Değişiklik talebi aç</button> : null}
      </div>
      {can("production.plan") && active ? (
        <div className="row">
          <input aria-label="Bekletme / devam gerekçesi" placeholder="Gerekçe" value={reason} onChange={(e) => setReason(e.target.value)} style={{ flex: 1 }} />
          {wo.status !== "on_hold" ? <button disabled={reason.trim().length < 3} onClick={() => act.mutate(() => post(`/api/work-orders/${wo.id}/hold`, { reason }))}>Beklet</button>
            : <button className="primary" disabled={reason.trim().length < 3} onClick={() => act.mutate(() => post(`/api/work-orders/${wo.id}/resume`, { reason }))}>Devam ettir</button>}
        </div>
      ) : null}
      <ErrorNotice error={act.error} />
      {open ? (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <label className="field">Başlık<input required minLength={3} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
          <label className="field">Açıklama (gözlem, etkilenen kart/seri)<textarea required minLength={10} rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
          <div className="row">
            <label className="field">Seri (isteğe bağlı)<input value={f.deviceSerial} onChange={(e) => setF({ ...f, deviceSerial: e.target.value })} /></label>
            <label className="field">Aciliyet
              <select value={f.urgency} onChange={(e) => setF({ ...f, urgency: e.target.value })}>
                <option value="low">Düşük</option><option value="normal">Normal</option><option value="high">Yüksek</option><option value="critical">Kritik</option>
              </select>
            </label>
            <label className="row" style={{ gap: 6, alignSelf: "flex-end" }}><input type="checkbox" style={{ minHeight: 0 }} checked={f.stopProduction} onChange={(e) => setF({ ...f, stopProduction: e.target.checked })} /> Üretimi durdur (iş emri bekletilir)</label>
          </div>
          <div className="row"><button className="primary" disabled={create.isPending}>Talebi aç</button><button type="button" onClick={() => setOpen(false)}>Vazgeç</button></div>
          <ErrorNotice error={create.error} />
        </form>
      ) : null}
      {wo.changeRequests.length ? (
        <table>
          <tbody>
            {wo.changeRequests.map((c: any) => (
              <tr key={c.id} className="click" onClick={() => nav(`/changes/${c.id}`)}>
                <td className="mono">{c.code}</td><td>{c.title}</td><td>{c.stopProduction ? <span className="badge bad">Üretimi durdur</span> : null}</td><td><StateBadge value={c.status} prefix="cr" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
