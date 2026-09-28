import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, newKey, post } from "../lib/api";
import { Empty, ErrorNotice, Loading, PageHeader, fmt, fmtDate, useCan } from "../lib/ui";

const STATUS_LABEL: Record<string, [string, string]> = {
  trial: ["deneme", "warn"],
  active: ["aktif", "ok"],
  delinquent: ["gecikmiş", "warn"],
  restricted: ["kısıtlı", "bad"],
  cancelled: ["iptal edildi", "bad"],
};
const TRANSITIONS: Record<string, string[]> = {
  trial: ["active", "delinquent", "cancelled"],
  active: ["delinquent", "cancelled"],
  delinquent: ["active", "restricted", "cancelled"],
  restricted: ["active", "cancelled"],
  cancelled: [],
};

type SubscriptionInfo = {
  status: string;
  statusReason: string | null;
  statusChangedAt: string;
  trialEndsAt: string | null;
  plan: { id: string; code: string; name: string; maxActiveUsers: number | null; maxComponents: number | null; includesAi: boolean; includesVideo: boolean } | null;
  usage: { activeUsers: number; activeUsersOverLimit: boolean; components: number; componentsOverLimit: boolean };
};
type Plan = { id: string; code: string; name: string; maxActiveUsers: number | null; maxComponents: number | null; includesAi: boolean; includesVideo: boolean };
type EventRow = {
  id: string;
  eventType: string;
  fromStatus: string | null;
  toStatus: string | null;
  fromPlanCode: string | null;
  toPlanCode: string | null;
  amount: string | null;
  currency: string | null;
  reference: string | null;
  note: string | null;
  recordedBy: string | null;
  createdAt: string;
};

const Header = () => (
  <PageHeader
    title="Abonelik"
    sub="Şirketinizin SaaS paketi ve durumu. Kapsam bilinçli olarak dar tutuldu: şirketler arası bir platform yöneticisi ekranı yoktur — her şirket yalnızca kendi aboneliğini yönetir."
  />
);

const EVENT_LABEL: Record<string, string> = {
  status_changed: "Durum değişikliği",
  plan_changed: "Paket değişikliği",
  payment_recorded: "Ödeme kaydı",
  payment_failed: "Başarısız tahsilat",
  invoice_recorded: "Fatura kesildi",
};
const INTERVAL: Record<string, string> = { monthly: "aylık", yearly: "yıllık" };
const PAY_RESULT: Record<string, [string, string]> = {
  success: ["ok", "Ödeme alındı; abonelik iyzico üzerinden başlatıldı."],
  failed: ["bad", "Ödeme tamamlanamadı. Kart bilgilerini kontrol edip tekrar deneyin."],
};

/** Madde 6 — iyzico ile abonelik ödemesi: fiyat seçimi, ödeme formu, mutabakat ve ek süre bilgisi. */
function BillingCard({ manage, onChanged }: { manage: boolean; onChanged: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["subscription-billing"], queryFn: () => get<any>("/api/subscription/billing") });
  const [priceId, setPriceId] = useState("");
  const [c, setC] = useState({ name: "", surname: "", email: "", gsmNumber: "+90", identityNumber: "", address: "", city: "", country: "Turkey", zipCode: "" });
  const result = new URLSearchParams(window.location.search).get("payment");
  const checkout = useMutation({
    mutationFn: () => post<{ pageUrl: string }>("/api/subscription/checkout", { priceId, customer: { ...c, zipCode: c.zipCode || undefined } }),
    onSuccess: (r) => { window.location.href = r.pageUrl; },
  });
  const sync = useMutation({ mutationFn: () => post<any>("/api/subscription/sync"), onSuccess: () => { qc.invalidateQueries({ queryKey: ["subscription-billing"] }); qc.invalidateQueries({ queryKey: ["provider-payments"] }); onChanged(); } });
  const b = q.data;
  if (!b) return q.isLoading ? null : <ErrorNotice error={q.error} />;
  const field = (k: keyof typeof c, label: string, w?: number) => (
    <label className="field" style={w ? { width: w } : { flex: 1, minWidth: 160 }}>{label}<input aria-label={`Ödeme ${label}`} value={c[k]} onChange={(e) => setC({ ...c, [k]: e.target.value })} /></label>
  );
  return (
    <section className="card">
      <div className="row between">
        <h2 style={{ margin: 0 }}>Ödeme (iyzico)</h2>
        {manage && b.current?.providerLinked ? <button disabled={sync.isPending} onClick={() => sync.mutate()}>Ödeme durumunu yenile</button> : null}
      </div>
      {result && PAY_RESULT[result] ? <div className={`notice ${PAY_RESULT[result]![0]}`}>{PAY_RESULT[result]![1]}</div> : null}
      {b.current?.graceUntil ? <div className="notice warn">Ödeme alınamadı. {b.current.graceUntil} tarihine kadar ödeme yapılmazsa abonelik otomatik olarak <b>kısıtlı</b> duruma geçer ({b.graceDays} gün ek süre).</div> : null}
      {b.current?.providerLinked ? (
        <p style={{ margin: 0 }}>Tekrarlı ödeme iyzico'da aktif: {b.current.planName} · {INTERVAL[b.current.interval] ?? b.current.interval} {fmt(b.current.amount)} {b.current.currency}{b.current.providerSyncedAt ? <span className="muted"> · son mutabakat {fmtDate(b.current.providerSyncedAt)}</span> : null}</p>
      ) : !b.configured ? (
        <p className="muted" style={{ margin: 0 }}>Online ödeme henüz etkin değil (platform iyzico hesabı yapılandırılmadı). Ödemeler şimdilik aşağıdaki "Ödeme kaydı" ile elle kaydedilir.</p>
      ) : null}
      {b.prices.length ? (
        <table>
          <thead><tr><th>Paket</th><th>Dönem</th><th className="num">Fiyat</th><th /></tr></thead>
          <tbody>{b.prices.map((p: any) => (
            <tr key={p.id}>
              <td>{p.planName}</td><td>{INTERVAL[p.interval] ?? p.interval}</td><td className="num">{fmt(p.amount)} {p.currency}</td>
              <td>{manage && b.configured && p.payable && !b.current?.providerLinked ? <label className="row" style={{ gap: 6 }}><input type="radio" name="price" style={{ minHeight: 0 }} checked={priceId === p.id} onChange={() => setPriceId(p.id)} /> seç</label> : !p.payable ? <span className="muted">ödeme planı tanımlanmadı</span> : null}</td>
            </tr>
          ))}</tbody>
        </table>
      ) : <Empty>Henüz fiyat tanımlanmadı (platform işletmecisi).</Empty>}
      {priceId ? (
        <div className="stack">
          <p className="muted" style={{ margin: 0 }}>Fatura bilgileri (iyzico'ya iletilir). Kart bilgisi bir sonraki adımda iyzico'nun güvenli ödeme formunda girilir; bu sisteme gelmez.</p>
          <div className="row" style={{ flexWrap: "wrap" }}>{field("name", "Ad")}{field("surname", "Soyad")}{field("email", "E-posta")}{field("gsmNumber", "Telefon", 170)}{field("identityNumber", "TCKN/VKN", 150)}</div>
          <div className="row" style={{ flexWrap: "wrap" }}>{field("address", "Fatura adresi")}{field("city", "İl", 140)}{field("country", "Ülke", 140)}{field("zipCode", "Posta kodu", 110)}</div>
          <div className="row"><button className="primary" disabled={checkout.isPending} onClick={() => checkout.mutate()}>iyzico ile öde</button><button onClick={() => setPriceId("")}>Vazgeç</button></div>
        </div>
      ) : null}
      <ErrorNotice error={checkout.error ?? sync.error} />
    </section>
  );
}

/** Sağlayıcı tahsilatları ve fatura takibi (muhasebe resmi faturayı elle keser, numarayla işaretler). */
function ProviderPayments({ manage }: { manage: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["provider-payments"], queryFn: () => get<any[]>("/api/subscription/provider-payments") });
  const [inv, setInv] = useState<Record<string, string>>({});
  const mark = useMutation({
    mutationFn: (id: string) => post(`/api/subscription/provider-payments/${id}/invoice`, { invoiceNo: inv[id] }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["provider-payments"] }); qc.invalidateQueries({ queryKey: ["subscription-events"] }); },
  });
  if (!q.data?.length) return null;
  const pending = q.data.filter((p) => p.invoiceStatus === "to_invoice").length;
  return (
    <section className="card">
      <h2>Tahsilatlar ve fatura</h2>
      {pending ? <div className="notice warn">{pending} başarılı tahsilatın resmi faturası kesilmedi. Faturayı kestikten sonra fatura numarasıyla işaretleyin.</div> : null}
      <table>
        <thead><tr><th>Tarih</th><th>Dönem</th><th className="num">Tutar</th><th>Sonuç</th><th>Fatura</th></tr></thead>
        <tbody>{q.data.map((p) => (
          <tr key={p.id}>
            <td>{fmtDate(p.occurredAt)}<div className="muted mono" style={{ fontSize: 12 }}>{p.orderRef}</div></td>
            <td>{p.periodStart ? `${p.periodStart} → ${p.periodEnd ?? "?"}` : "—"}</td>
            <td className="num">{p.amount ? `${fmt(p.amount)} ${p.currency}` : "—"}</td>
            <td>{p.status === "success" ? <span className="badge ok">alındı</span> : <span className="badge bad">başarısız</span>}</td>
            <td>
              {p.invoiceStatus === "invoiced" ? <span className="mono">{p.invoiceNo}</span>
                : p.invoiceStatus === "not_applicable" ? <span className="muted">—</span>
                : manage ? (
                  <div className="row" style={{ gap: 6 }}>
                    <input aria-label="Fatura numarası" placeholder="fatura no" value={inv[p.id] ?? ""} onChange={(e) => setInv({ ...inv, [p.id]: e.target.value })} style={{ width: 170 }} />
                    <button disabled={!inv[p.id]?.trim() || mark.isPending} onClick={() => mark.mutate(p.id)}>Kesildi</button>
                  </div>
                ) : <span className="badge warn">kesilecek</span>}
            </td>
          </tr>
        ))}</tbody>
      </table>
      <ErrorNotice error={mark.error} />
    </section>
  );
}

export function SubscriptionPage() {
  const can = useCan();
  const qc = useQueryClient();
  const info = useQuery({ queryKey: ["subscription"], queryFn: () => get<SubscriptionInfo>("/api/subscription") });
  const plans = useQuery({ queryKey: ["subscription-plans"], queryFn: () => get<Plan[]>("/api/subscription/plans") });
  const events = useQuery({ queryKey: ["subscription-events"], queryFn: () => get<EventRow[]>("/api/subscription/events") });

  const [planCode, setPlanCode] = useState("");
  const [toStatus, setToStatus] = useState("");
  const [reason, setReason] = useState("");
  const [pay, setPay] = useState({ amount: "", currency: "TRY", reference: "", note: "" });
  const [payKey] = useState(newKey());

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["subscription"] });
    qc.invalidateQueries({ queryKey: ["subscription-events"] });
  };

  const changePlan = useMutation({
    mutationFn: () => post<any>("/api/subscription/plan", { planCode, reason: reason || undefined }),
    onSuccess: () => { setPlanCode(""); invalidate(); },
  });
  const transition = useMutation({
    mutationFn: () => post<any>("/api/subscription/transition", { to: toStatus, reason }),
    onSuccess: () => { setToStatus(""); setReason(""); invalidate(); },
  });
  const recordPayment = useMutation({
    mutationFn: () => post<any>("/api/subscription/payments", { ...pay, reference: pay.reference || undefined, note: pay.note || undefined }, { "Idempotency-Key": payKey }),
    onSuccess: () => { setPay({ amount: "", currency: "TRY", reference: "", note: "" }); invalidate(); },
  });

  if (!can("subscription.view")) return <><Header /><Empty>Bu sayfa için yetkiniz yok.</Empty></>;
  if (info.isLoading) return <><Header /><Loading /></>;
  if (info.error) return <><Header /><ErrorNotice error={info.error} /></>;
  const d = info.data!;
  const st = STATUS_LABEL[d.status] ?? [d.status, ""];
  const allowedTargets = TRANSITIONS[d.status] ?? [];
  const manage = can("subscription.manage");

  return (
    <>
      <Header />
      <section className="card">
        <h2>Durum & paket</h2>
        <div className="row" style={{ flexWrap: "wrap", gap: "1.5rem" }}>
          <div>Durum: <span className={`badge ${st[1]}`}>{st[0]}</span></div>
          <div>Paket: <strong>{d.plan?.name ?? "—"}</strong></div>
          {d.trialEndsAt ? <div>Deneme bitişi: {d.trialEndsAt}</div> : null}
          <div>Son değişiklik: {fmtDate(d.statusChangedAt)}</div>
        </div>
        {d.statusReason ? <p className="muted">Gerekçe: {d.statusReason}</p> : null}
        {d.status === "restricted" ? (
          <p className="badge bad" style={{ display: "inline-block" }}>
            Kısıtlı durumda: yeni satış siparişi ve satın alma siparişi (teklif ödülü) oluşturulamaz. Üretim, sevkiyat ve mevcut işlerin tamamlanması etkilenmez.
          </p>
        ) : null}
        {d.plan ? (
          <table>
            <thead><tr><th>Aktif kullanıcı</th><th>Bileşen</th><th>AI</th><th>Video</th></tr></thead>
            <tbody>
              <tr>
                <td>{d.usage.activeUsers}{d.plan.maxActiveUsers != null ? ` / ${d.plan.maxActiveUsers}` : " / sınırsız"} {d.usage.activeUsersOverLimit ? <span className="badge warn">limit aşıldı</span> : null}</td>
                <td>{d.usage.components}{d.plan.maxComponents != null ? ` / ${d.plan.maxComponents}` : " / sınırsız"} {d.usage.componentsOverLimit ? <span className="badge warn">limit aşıldı</span> : null}</td>
                <td>{d.plan.includesAi ? "Var" : "Yok"}</td>
                <td>{d.plan.includesVideo ? "Var" : "Yok"}</td>
              </tr>
            </tbody>
          </table>
        ) : null}
        <p className="muted" style={{ margin: 0 }}>
          Limit aşımı yalnızca bilgilendirme amaçlıdır — otomatik kısıtlama tetiklemez (bu bilinçli bir kapsam sınırlaması: gerçek bir kullanım-faturalama motoru henüz yok).
        </p>
      </section>

      <BillingCard manage={manage} onChanged={invalidate} />
      <ProviderPayments manage={manage} />

      {manage ? (
        <section className="card">
          <h2>Paket değiştir</h2>
          {plans.isLoading ? <Loading /> : <ErrorNotice error={plans.error} />}
          <div className="row" style={{ flexWrap: "wrap" }}>
            <label className="field">Yeni paket
              <select aria-label="Yeni paket" value={planCode} onChange={(e) => setPlanCode(e.target.value)}>
                <option value="">Seçin</option>
                {plans.data?.map((p) => <option key={p.code} value={p.code}>{p.name}{p.code === d.plan?.code ? " (mevcut)" : ""}</option>)}
              </select>
            </label>
            <button disabled={!planCode || changePlan.isPending} onClick={() => changePlan.mutate()}>Paketi değiştir</button>
          </div>
          <ErrorNotice error={changePlan.error} />
        </section>
      ) : null}

      {manage ? (
        <section className="card">
          <h2>Durum değiştir</h2>
          {allowedTargets.length === 0 ? <Empty>"{st[0]}" durumundan başka bir duruma geçilemez (kalıcı durum).</Empty> : (
            <div className="row" style={{ flexWrap: "wrap" }}>
              <label className="field">Yeni durum
                <select aria-label="Yeni durum" value={toStatus} onChange={(e) => setToStatus(e.target.value)}>
                  <option value="">Seçin</option>
                  {allowedTargets.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]?.[0] ?? s}</option>)}
                </select>
              </label>
              <label className="field" style={{ flex: 1, minWidth: 240 }}>Gerekçe
                <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Zorunlu — örn. ödeme gecikmesi, manuel onay" />
              </label>
              <button disabled={!toStatus || reason.trim().length < 3 || transition.isPending} onClick={() => transition.mutate()}>Durumu değiştir</button>
            </div>
          )}
          <ErrorNotice error={transition.error} />
        </section>
      ) : null}

      {manage ? (
        <section className="card">
          <h2>Ödeme kaydı</h2>
          <p className="muted" style={{ marginTop: 0 }}>iyzico dışında yapılan ödemeler (havale vb.) için: yalnızca kaydını tutar; durumu otomatik değiştirmez. iyzico tahsilatları otomatik kaydedilir.</p>
          <div className="row" style={{ flexWrap: "wrap" }}>
            <label className="field">Tutar<input value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} placeholder="0.00" /></label>
            <label className="field" style={{ width: 80 }}>Para<input value={pay.currency} onChange={(e) => setPay({ ...pay, currency: e.target.value.toUpperCase() })} /></label>
            <label className="field">Referans<input value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} /></label>
            <label className="field" style={{ flex: 1, minWidth: 200 }}>Not<input value={pay.note} onChange={(e) => setPay({ ...pay, note: e.target.value })} /></label>
            <button disabled={!/^\d+(\.\d{1,6})?$/.test(pay.amount) || recordPayment.isPending} onClick={() => recordPayment.mutate()}>Ödemeyi kaydet</button>
          </div>
          <ErrorNotice error={recordPayment.error} />
        </section>
      ) : null}

      <section className="card">
        <h2>Geçmiş</h2>
        {events.isLoading ? <Loading /> : <ErrorNotice error={events.error} />}
        {events.data?.length === 0 ? <Empty>Kayıt yok.</Empty> : null}
        {events.data?.length ? (
          <table>
            <thead><tr><th>Tarih</th><th>Olay</th><th>Değişim</th><th className="num">Tutar</th><th>Not</th><th>Kaydeden</th></tr></thead>
            <tbody>{events.data.map((e) => (
              <tr key={e.id}>
                <td>{fmtDate(e.createdAt)}</td>
                <td>{EVENT_LABEL[e.eventType] ?? e.eventType}</td>
                <td>
                  {e.eventType === "status_changed" ? `${STATUS_LABEL[e.fromStatus ?? ""]?.[0] ?? e.fromStatus ?? "—"} → ${STATUS_LABEL[e.toStatus ?? ""]?.[0] ?? e.toStatus ?? "—"}` : null}
                  {e.eventType === "plan_changed" ? `${e.fromPlanCode ?? "—"} → ${e.toPlanCode ?? "—"}` : null}
                  {["payment_recorded", "payment_failed", "invoice_recorded"].includes(e.eventType) ? (e.reference ?? "—") : null}
                </td>
                <td className="num">{e.amount ? `${fmt(e.amount)} ${e.currency}` : "—"}</td>
                <td>{e.note ?? "—"}</td>
                <td>{e.recordedBy ?? "—"}</td>
              </tr>
            ))}</tbody>
          </table>
        ) : null}
      </section>
    </>
  );
}
