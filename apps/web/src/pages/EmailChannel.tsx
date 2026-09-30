import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, get, post } from "../lib/api";
import { Empty, ErrorNotice, Loading, PageHeader, fmtDate, useCan } from "../lib/ui";
import { WorkflowTabs } from "./Workflow";

const TOPIC: Record<string, string> = {
  mention: "Mesajda bahsedilme", meeting_invite: "Toplantı daveti", meeting_minutes: "Toplantı tutanağı", meeting_cancelled: "Toplantı iptali",
  escalation: "Süresi geçen iş yükseltmesi", customer_reminder: "Müşteriye ödeme hatırlatması", test_send: "Deneme",
};
const MODE: Record<string, string> = { off: "Kapalı — yalnız uygulama içi", test: "Test — gönderilmez, yalnız kaydedilir", live: "Canlı — gönderilir" };
const STATUS: Record<string, string> = { sent: "ok", test: "warn", skipped: "", failed: "bad" };

/** Yaygın sağlayıcılar için sunucu önerisi (yalnız doldurma kolaylığı; her SMTP sunucusu kullanılabilir). */
const PRESETS: { label: string; host: string; port: number; secure: boolean }[] = [
  { label: "Google Workspace / Gmail", host: "smtp.gmail.com", port: 465, secure: true },
  { label: "Microsoft 365 / Outlook", host: "smtp.office365.com", port: 587, secure: false },
  { label: "Yandex", host: "smtp.yandex.com.tr", port: 465, secure: true },
];

type Form = { mode: string; host: string; port: string; secure: boolean; username: string; password: string; fromAddress: string; fromName: string; replyTo: string; topics: string[] };

/** Oturum 41 — bildirim e-postası: şirketin kendi SMTP sunucusu. Parola şifreli saklanır, ekrana geri gelmez. */
export function EmailChannelPage() {
  const can = useCan();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["emailChannel"], queryFn: () => get<any>("/api/email-channel"), enabled: can("workflow.manage") });
  const d = useQuery({ queryKey: ["emailDeliveries"], queryFn: () => get<any[]>("/api/email-deliveries?limit=50"), enabled: can("workflow.manage") });
  const [f, setF] = useState<Form | null>(null);
  useEffect(() => {
    const s = q.data;
    if (s && !f) setF({ mode: s.mode, host: s.host ?? "", port: s.port ? String(s.port) : "", secure: s.secure, username: s.username ?? "", password: "", fromAddress: s.fromAddress ?? "", fromName: s.fromName ?? "", replyTo: s.replyTo ?? "", topics: s.topics });
  }, [q.data, f]);
  const refresh = () => { qc.invalidateQueries({ queryKey: ["emailChannel"] }); qc.invalidateQueries({ queryKey: ["emailDeliveries"] }); };
  const save = useMutation({
    mutationFn: (x: Form) => api<any>("PUT", "/api/email-channel", {
      mode: x.mode, host: x.host || null, port: x.port ? Number(x.port) : null, secure: x.secure, username: x.username || null,
      ...(x.password ? { password: x.password } : {}), fromAddress: x.fromAddress || null, fromName: x.fromName || null, replyTo: x.replyTo || null, topics: x.topics,
    }),
    onSuccess: () => { setF((p) => (p ? { ...p, password: "" } : p)); refresh(); },
  });
  const test = useMutation({ mutationFn: () => post<any>("/api/email-channel/test"), onSuccess: refresh });
  const header = <PageHeader title="Bildirim e-postası" sub="Kendi e-posta sağlayıcınızın SMTP ayarı. Kapalıyken bildirimler yalnız uygulama içinde görünür." />;
  if (!can("workflow.manage")) return <>{header}<WorkflowTabs /><Empty>Bu ayar için yetkiniz yok.</Empty></>;
  if (!f) return <>{header}<WorkflowTabs />{q.isLoading ? <Loading /> : <ErrorNotice error={q.error} />}</>;
  const set = (p: Partial<Form>) => setF({ ...f, ...p });
  const submit = (e: FormEvent) => { e.preventDefault(); save.mutate(f); };
  return (
    <>
      {header}
      <WorkflowTabs />
      <section className="card">
        <form onSubmit={submit} className="stack">
          <label className="field" style={{ maxWidth: 360 }}>
            Mod
            <select value={f.mode} onChange={(e) => set({ mode: e.target.value })}>
              {Object.entries(MODE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <div className="row">
            <span className="muted">Hazır ayar:</span>
            {PRESETS.map((p) => <button type="button" key={p.host} onClick={() => set({ host: p.host, port: String(p.port), secure: p.secure })}>{p.label}</button>)}
          </div>
          <div className="grid4">
            <label className="field">SMTP sunucusu<input value={f.host} onChange={(e) => set({ host: e.target.value })} placeholder="smtp.ornek.com.tr" /></label>
            <label className="field">Port<input inputMode="numeric" value={f.port} onChange={(e) => set({ port: e.target.value.replace(/\D/g, "") })} placeholder="587" /></label>
            <label className="row" style={{ alignItems: "center" }}><input type="checkbox" checked={f.secure} onChange={(e) => set({ secure: e.target.checked })} /> Doğrudan TLS (465)</label>
          </div>
          <div className="grid4">
            <label className="field">Kullanıcı adı<input value={f.username} onChange={(e) => set({ username: e.target.value })} autoComplete="off" /></label>
            <label className="field">
              Parola {q.data?.hasPassword ? <span className="badge ok">kayıtlı</span> : null}
              <input type="password" value={f.password} onChange={(e) => set({ password: e.target.value })} autoComplete="new-password" placeholder={q.data?.hasPassword ? "Değiştirmek için yazın" : ""} />
            </label>
          </div>
          <div className="grid4">
            <label className="field">Gönderen adresi<input type="email" value={f.fromAddress} onChange={(e) => set({ fromAddress: e.target.value })} /></label>
            <label className="field">Gönderen adı<input value={f.fromName} onChange={(e) => set({ fromName: e.target.value })} /></label>
            <label className="field">Yanıt adresi<input type="email" value={f.replyTo} onChange={(e) => set({ replyTo: e.target.value })} /></label>
          </div>
          <fieldset>
            <legend>Hangi bildirimler e-postayla gitsin</legend>
            {(q.data?.topicOptions as string[]).map((t) => (
              <label key={t} className="row" style={{ alignItems: "center" }}>
                <input type="checkbox" checked={f.topics.includes(t)} onChange={(e) => set({ topics: e.target.checked ? [...f.topics, t] : f.topics.filter((x) => x !== t) })} /> {TOPIC[t] ?? t}
              </label>
            ))}
          </fieldset>
          <p className="muted">Gizlilik: e-postaya mesaj içeriği konmaz — yalnız başlık ve uygulamaya bağlantı. Müşteri hatırlatmasında şirketinizin hatırlatma metni gider.</p>
          <ErrorNotice error={save.error} />
          <div className="row">
            <button className="primary" disabled={save.isPending}>Kaydet</button>
            <button type="button" disabled={test.isPending || !q.data?.host} onClick={() => test.mutate()}>Kendime deneme e-postası gönder</button>
            {test.data ? (test.data.ok ? <span className="badge ok">Gönderildi: {test.data.to}</span> : <span className="badge bad">Gönderilemedi: {test.data.error}</span>) : null}
          </div>
          <ErrorNotice error={test.error} />
        </form>
      </section>
      <section className="card">
        <h2>Son gönderimler</h2>
        {d.isLoading ? <Loading /> : <ErrorNotice error={d.error} />}
        {d.data && !d.data.length ? <Empty>Henüz kayıt yok.</Empty> : (
          <table>
            <thead><tr><th>Zaman</th><th>Bildirim</th><th>Alıcı</th><th>Konu</th><th>Durum</th></tr></thead>
            <tbody>{d.data?.map((x) => (
              <tr key={x.id}>
                <td className="muted">{fmtDate(x.createdAt)}</td>
                <td>{TOPIC[x.topic] ?? x.topic}</td>
                <td className="mono">{x.recipient}</td>
                <td>{x.subject}</td>
                <td><span className={`badge ${STATUS[x.status] ?? ""}`}>{x.status}</span>{x.error ? <div className="muted">{x.error}</div> : null}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>
    </>
  );
}
