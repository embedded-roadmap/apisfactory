import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, newKey, post } from "../lib/api";
import { Empty, ErrorNotice, Loading, PageHeader, StateBadge, fmt, fmtDate, useCan } from "../lib/ui";
import { History } from "./Sales";

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
      <PageHeader title="Üretim" sub="İş emri yayımlanmış ürün sürümünü ve BOM'u sabitler; sonraki revizyon açık işi değiştirmez." />
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
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNotice error={q.error} />;
  const wo = q.data;
  const s = wo.stats;
  return (
    <>
      <PageHeader
        title={`İş emri ${wo.code}`}
        sub={<>{wo.productCode} Rev.{wo.rev} · BOM v{wo.bomVersionNo} (sabit) · {wo.salesOrderCode ? `sipariş ${wo.salesOrderCode}` : "stok için"} · <Link to="/production">← Üretim</Link></>}
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
          <thead><tr><th>#</th><th>Operasyon</th><th>İstasyon</th><th>Durum</th><th>Süre</th><th /></tr></thead>
          <tbody>
            {wo.operations.map((o: any) => (
              <tr key={o.id}>
                <td>{o.seq}</td>
                <td>{o.name} {o.isQualityGate ? <span className="badge warn">Kalite kapısı</span> : null}</td>
                <td className="mono">{o.workCenter}</td>
                <td><StateBadge value={o.status} prefix="op" /></td>
                <td className="muted">{o.workedSeconds ? `${Math.round(o.workedSeconds / 60)} dk` : "—"}</td>
                <td className="row">
                  {can("production.execute") && ["pending", "paused"].includes(o.status) && ["released", "in_progress"].includes(wo.status) ? <button onClick={() => act.mutate(() => post(`/api/work-orders/${id}/operations/${o.id}/start`))}>Başla</button> : null}
                  {can("production.execute") && o.status === "in_progress" ? (
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
        <table>
          <tbody>
            {wo.devices.map((d: any) => <DeviceRow key={d.serial} d={d} onDone={refresh} />)}
          </tbody>
        </table>
      </section>
      <History entityType="work_order" id={wo.id} />
    </>
  );
}

function MaterialRow({ m, woId, canIssue, onDone }: { m: any; woId: string; canIssue: boolean; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [lotNo, setLotNo] = useState("");
  const [qty, setQty] = useState(m.remaining);
  const [key, setKey] = useState(newKey());
  const lots = useQuery({ enabled: open, queryKey: ["lotsFor", m.itemId], queryFn: () => get<any[]>(`/api/stock/balances?itemId=${m.itemId}`) });
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
        <td className="mono">{m.itemCode}</td><td className="mono">{m.mpn}</td><td className="num">{fmt(m.required)}</td><td className="num">{fmt(m.issued)}</td>
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
                      {l.lotNo} · {l.locationCode} · {fmt(l.qty)}{l.locationType !== "stock" ? " (kullanılamaz)" : ""}
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

function DeviceRow({ d, onDone }: { d: any; onDone: () => void }) {
  const can = useCan();
  const [note, setNote] = useState("");
  const [v, setV] = useState("");
  const act = useMutation({ mutationFn: (f: () => Promise<unknown>) => f(), onSuccess: onDone });
  const runs: any[] = d.runs ?? [];
  return (
    <tr>
      <td className="mono">{d.serial}</td>
      <td><StateBadge value={d.status} prefix="dev" /></td>
      <td className="muted">{runs.map((r) => `#${r.runNo} ${r.result === "pass" ? "geçti" : "kaldı"}`).join(" · ") || "test yok"}</td>
      <td>
        <div className="row">
          {can("production.test.record") && ["in_process", "rework"].includes(d.status) ? (
            <>
              <input aria-label={`${d.serial} 3V3 ölçümü`} placeholder="3V3 (V)" value={v} onChange={(e) => setV(e.target.value)} style={{ width: 100 }} inputMode="decimal" />
              <button onClick={() => act.mutate(() => post(`/api/devices/${d.serial}/test`, { result: "pass", measurements: v ? [{ name: "3V3", value: Number(v), unit: "V", low: 3.2, high: 3.4 }] : [] }))}>Geçti</button>
              <button className="danger" onClick={() => act.mutate(() => post(`/api/devices/${d.serial}/test`, { result: "fail", measurements: v ? [{ name: "3V3", value: Number(v), unit: "V", low: 3.2, high: 3.4 }] : [] }))}>Kaldı</button>
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
        <ErrorNotice error={act.error} />
      </td>
    </tr>
  );
}
