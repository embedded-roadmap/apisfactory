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
  trial: ["active", "cancelled"],
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
};

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
          <p className="muted" style={{ marginTop: 0 }}>Gerçek bir ödeme sağlayıcı entegrasyonu yoktur — bu yalnızca dışarıda yapılan bir ödemenin kaydını tutar; durumu otomatik değiştirmez.</p>
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
                  {e.eventType === "payment_recorded" ? (e.reference ?? "—") : null}
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
