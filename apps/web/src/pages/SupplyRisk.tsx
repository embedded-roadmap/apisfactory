import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, post } from "../lib/api";
import { PurchasingTabs } from "./Procurement";
import { Empty, ErrorNotice, Loading, PageHeader, fmt, fmtDate, useCan } from "../lib/ui";

const RISK_LABEL: Record<string, string> = {
  no_source_stock: "Kaynakta stok yok", lifecycle_risk: "Yaşam döngüsü riski",
  stock_drop: "Stok düşüşü", price_increase: "Fiyat artışı", lead_time_increase: "Temin süresi uzaması",
};

function SeverityBadge({ value }: { value: string }) {
  return <span className={`badge ${value === "critical" ? "bad" : "warn"}`}>{value === "critical" ? "Kritik" : "Uyarı"}</span>;
}

function Settings() {
  const can = useCan();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["supply-risk-settings"], queryFn: () => get<any>("/api/supply-risk-settings") });
  const [f, setF] = useState<any>(null);
  const save = useMutation({
    mutationFn: () => post("/api/supply-risk-settings", {
      enabled: f.enabled, stockDropPct: Number(f.stockDropPct), priceIncreasePct: Number(f.priceIncreasePct),
      leadTimeIncreaseDays: Number(f.leadTimeIncreaseDays), scanFrequencyHours: Number(f.scanFrequencyHours),
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["supply-risk-settings"] }),
  });
  const scan = useMutation({
    mutationFn: () => post<any>("/api/supply-risks/scan"),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["supply-risks"] }); qc.invalidateQueries({ queryKey: ["supply-risk-settings"] }); },
  });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNotice error={q.error} />;
  const s = f ?? q.data;
  return (
    <section className="card">
      <h2>Tedarik riski ayarları</h2>
      <div className="muted" style={{ marginBottom: 8 }}>
        Eşikler ve tarama sıklığı şirket bazında ayarlanır. Son tarama: {fmtDate(q.data.lastScannedAt)}.
      </div>
      {can("supply.risk.manage") ? (
        <form className="row" onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
          <label className="field">
            <input type="checkbox" checked={s.enabled} onChange={(e) => setF({ ...s, enabled: e.target.checked })} /> Etkin
          </label>
          <label className="field" style={{ width: 110 }}>Stok düşüşü eşiği (%)<input aria-label="Stok düşüşü eşiği" inputMode="decimal" value={s.stockDropPct} onChange={(e) => setF({ ...s, stockDropPct: e.target.value })} /></label>
          <label className="field" style={{ width: 110 }}>Fiyat artışı eşiği (%)<input aria-label="Fiyat artışı eşiği" inputMode="decimal" value={s.priceIncreasePct} onChange={(e) => setF({ ...s, priceIncreasePct: e.target.value })} /></label>
          <label className="field" style={{ width: 110 }}>Temin uzaması eşiği (gün)<input aria-label="Temin uzaması eşiği" inputMode="decimal" value={s.leadTimeIncreaseDays} onChange={(e) => setF({ ...s, leadTimeIncreaseDays: e.target.value })} /></label>
          <label className="field" style={{ width: 110 }}>Tarama sıklığı (saat)<input aria-label="Tarama sıklığı" inputMode="decimal" value={s.scanFrequencyHours} onChange={(e) => setF({ ...s, scanFrequencyHours: e.target.value })} /></label>
          <button className="primary" style={{ alignSelf: "flex-end" }} disabled={save.isPending}>Kaydet</button>
          <button type="button" style={{ alignSelf: "flex-end" }} disabled={scan.isPending} onClick={() => scan.mutate()}>Şimdi tara</button>
        </form>
      ) : null}
      <ErrorNotice error={save.error} />
      <ErrorNotice error={scan.error} />
      {scan.data ? (
        <div className="notice" style={{ marginTop: 8 }}>
          Tarama tamam: {scan.data.scanned} kalem incelendi, {scan.data.detected} yeni/güncellenen risk, {scan.data.resolved} çözüldü, {scan.data.escalated} kritik göreve yükseltildi.
        </div>
      ) : null}
    </section>
  );
}

function RiskCard({ r }: { r: any }) {
  const can = useCan();
  const qc = useQueryClient();
  const [reason, setReason] = useState("");
  const resolve = useMutation({
    mutationFn: () => post(`/api/supply-risks/${r.id}/resolve`, { reason }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["supply-risks"] }),
  });
  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <span className="mono">{r.itemCode}</span> — {r.itemName} {r.mpn ? <span className="muted">({r.manufacturer} {r.mpn})</span> : null}
        </div>
        <div className="row" style={{ gap: 6 }}>
          <SeverityBadge value={r.severity} />
          <span className="badge">{r.status === "open" ? "Açık" : "Çözüldü"}</span>
        </div>
      </div>
      <div style={{ marginTop: 6 }}><b>{RISK_LABEL[r.riskType] ?? r.riskType}:</b> {r.changeSummary}</div>
      <div className="muted" style={{ marginTop: 4 }}>Kaynak verisi: {fmtDate(r.sourceFetchedAt)} tarihli</div>
      <div className="row" style={{ marginTop: 6, gap: 20 }}>
        <div>Açık talep: <b>{fmt(r.openRequestQty)}</b></div>
        <div>Açık sipariş: <b>{fmt(r.openPoQty)}</b></div>
        <div>İhtiyaç tarihi: <b>{r.earliestNeedDate ?? "—"}</b></div>
        <div>Onaylı alternatif: <b>{r.hasApprovedAlternate ? "var" : "yok"}</b></div>
        <div>Sorumlu: <b>{r.responsibleRole === "rd" ? "Ar-Ge" : "Satın alma"}</b></div>
      </div>
      <div style={{ marginTop: 6 }}><b>Önerilen aksiyon:</b> {r.recommendedAction}</div>
      {r.status === "resolved" ? (
        <div className="muted" style={{ marginTop: 6 }}>Çözüldü ({fmtDate(r.resolvedAt)}): {r.resolvedReason}</div>
      ) : can("supply.risk.manage") ? (
        <form className="row" style={{ marginTop: 8 }} onSubmit={(e: FormEvent) => { e.preventDefault(); resolve.mutate(); }}>
          <label className="field" style={{ flex: 1 }}>Çözüldü gerekçesi<input aria-label="Çözüldü gerekçesi" required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          <button style={{ alignSelf: "flex-end" }} disabled={resolve.isPending}>Çözüldü işaretle</button>
        </form>
      ) : null}
      <ErrorNotice error={resolve.error} />
    </div>
  );
}

export function SupplyRiskPage() {
  const [status, setStatus] = useState<"open" | "resolved" | "all">("open");
  const q = useQuery({ queryKey: ["supply-risks", status], queryFn: () => get<any[]>(`/api/supply-risks?status=${status}`) });
  return (
    <>
      <PageHeader title="Satın alma" sub="Tedarik riski: distribütör verisindeki stok/fiyat/temin/yaşam döngüsü değişimlerinin açık sipariş ve termine etkisi." />
      <PurchasingTabs />
      <div className="notice info">
        TEST bağlayıcısı MPN'den deterministik türer — aynı MPN her zaman aynı değeri verir. Bu yüzden stok düşüşü / fiyat artışı / temin uzaması gibi
        değişim riskleri TEST modunda ancak gerçek bir fiyat dosyası yeniden yüklendiğinde tetiklenir. Kaynakta stok yok ve yaşam döngüsü riskleri
        tek anlık görüntüden çıkarıldığı için TEST modunda da gerçek sinyal verir.
      </div>
      <Settings />
      <section className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          <button className={status === "open" ? "primary" : ""} onClick={() => setStatus("open")}>Açık</button>
          <button className={status === "resolved" ? "primary" : ""} onClick={() => setStatus("resolved")}>Çözüldü</button>
          <button className={status === "all" ? "primary" : ""} onClick={() => setStatus("all")}>Tümü</button>
        </div>
        {q.isLoading ? <Loading /> : <ErrorNotice error={q.error} />}
        {q.data?.length === 0 ? <Empty /> : null}
        {q.data?.map((r) => <RiskCard key={r.id} r={r} />)}
      </section>
    </>
  );
}
