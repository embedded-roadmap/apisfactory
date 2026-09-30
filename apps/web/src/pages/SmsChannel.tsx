import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, get, post } from "../lib/api";
import { Empty, ErrorNotice, Loading, PageHeader, fmtDate, useCan } from "../lib/ui";
import { WorkflowTabs } from "./Workflow";

const TOPIC: Record<string, string> = {
  mention: "Mesajda bahsedilme", meeting_invite: "Toplantı daveti", meeting_minutes: "Toplantı tutanağı", meeting_cancelled: "Toplantı iptali",
  escalation: "Süresi geçen iş yükseltmesi", customer_reminder: "Müşteriye ödeme hatırlatması", test_send: "Deneme",
};
const MODE: Record<string, string> = { off: "Kapalı", test: "Test — gönderilmez, yalnız kaydedilir", live: "Canlı — gönderilir" };
const STATUS: Record<string, string> = { sent: "ok", test: "warn", skipped: "", failed: "bad" };
type Form = { mode: string; provider: string; sender: string; topics: string[]; creds: Record<string, string> };

/** Oturum 41 — SMS bildirimi: şirketin kendi SMS sağlayıcısı (Netgsm / Verimor). Erişim bilgisi şifreli, ekrana dönmez. */
export function SmsChannelPage() {
  const can = useCan();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["smsChannel"], queryFn: () => get<any>("/api/sms-channel"), enabled: can("workflow.manage") });
  const d = useQuery({ queryKey: ["smsDeliveries"], queryFn: () => get<any[]>("/api/sms-deliveries?limit=50"), enabled: can("workflow.manage") });
  const [f, setF] = useState<Form | null>(null);
  useEffect(() => {
    if (q.data && !f) setF({ mode: q.data.mode, provider: q.data.provider ?? "", sender: q.data.sender ?? "", topics: q.data.topics, creds: {} });
  }, [q.data, f]);
  const refresh = () => { qc.invalidateQueries({ queryKey: ["smsChannel"] }); qc.invalidateQueries({ queryKey: ["smsDeliveries"] }); };
  const save = useMutation({
    mutationFn: (x: Form) => {
      const filled = Object.values(x.creds).some(Boolean);
      return api<any>("PUT", "/api/sms-channel", { mode: x.mode, provider: x.provider || null, sender: x.sender || null, topics: x.topics, ...(filled ? { credentials: x.creds } : {}) });
    },
    onSuccess: () => { setF((p) => (p ? { ...p, creds: {} } : p)); refresh(); },
  });
  const test = useMutation({ mutationFn: () => post<any>("/api/sms-channel/test"), onSuccess: refresh });
  const header = <PageHeader title="SMS bildirimi" sub={<>Kendi SMS sağlayıcınızın hesabı. Çalışanlar numaralarını <Link to="/password">kendi ayar sayfalarından</Link> girer; müşteri hatırlatması varsayılan teslim adresindeki cep telefonuna gider.</>} />;
  if (!can("workflow.manage")) return <>{header}<WorkflowTabs /><Empty>Bu ayar için yetkiniz yok.</Empty></>;
  if (!f) return <>{header}<WorkflowTabs />{q.isLoading ? <Loading /> : <ErrorNotice error={q.error} />}</>;
  const set = (p: Partial<Form>) => setF({ ...f, ...p });
  const prov = f.provider ? q.data?.providers?.[f.provider] : null;
  const submit = (e: FormEvent) => { e.preventDefault(); save.mutate(f); };
  return (
    <>
      {header}
      <WorkflowTabs />
      <section className="card">
        <form onSubmit={submit} className="stack">
          <div className="grid4">
            <label className="field">Mod<select value={f.mode} onChange={(e) => set({ mode: e.target.value })}>{Object.entries(MODE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <label className="field">Sağlayıcı
              <select value={f.provider} onChange={(e) => set({ provider: e.target.value, creds: {} })}>
                <option value="">Seçin…</option>
                {Object.entries(q.data?.providers ?? {}).map(([k, p]: [string, any]) => <option key={k} value={k}>{p.label}</option>)}
              </select>
            </label>
            <label className="field">Gönderici başlığı<input value={f.sender} maxLength={11} onChange={(e) => set({ sender: e.target.value })} placeholder="FIRMA" /></label>
          </div>
          {prov ? (
            <p className="muted" style={{ margin: 0 }}>
              {prov.verified ? null : <span className="badge warn" title="Yayımlanmış belgeden yazıldı; gerçek bir hesapla henüz denenmedi">doğrulanmadı</span>}{" "}
              <a href={prov.docsUrl} target="_blank" rel="noopener noreferrer">belge</a> · Erişim bilgisi {q.data?.hasCredentials && q.data?.provider === f.provider ? <span className="badge ok">kayıtlı</span> : "kayıtlı değil"} — değiştirmek için yeniden girin.
            </p>
          ) : null}
          {prov ? (
            <div className="grid4">
              {prov.credentialFields.map((k: string) => (
                <label key={k} className="field">{k}<input type={k === "password" ? "password" : "text"} autoComplete="off" value={f.creds[k] ?? ""} onChange={(e) => set({ creds: { ...f.creds, [k]: e.target.value } })} /></label>
              ))}
            </div>
          ) : null}
          <fieldset>
            <legend>Hangi bildirimler SMS ile gitsin</legend>
            {(q.data?.topicOptions as string[]).map((t) => (
              <label key={t} className="row" style={{ alignItems: "center" }}>
                <input type="checkbox" checked={f.topics.includes(t)} onChange={(e) => set({ topics: e.target.checked ? [...f.topics, t] : f.topics.filter((x) => x !== t) })} /> {TOPIC[t] ?? t}
              </label>
            ))}
          </fieldset>
          <p className="muted">Mesajlar bilgilendirme amaçlıdır (ticari ileti değildir). İç bildirimlerde içerik değil, yalnız başlık ve bağlantı gönderilir.</p>
          <ErrorNotice error={save.error} />
          <div className="row">
            <button className="primary" disabled={save.isPending}>Kaydet</button>
            <button type="button" disabled={test.isPending || !q.data?.hasCredentials} onClick={() => test.mutate()}>Kendime deneme SMS'i gönder</button>
            {test.data ? (test.data.ok ? <span className="badge ok">Gönderildi</span> : <span className="badge bad">Gönderilemedi: {test.data.error}</span>) : null}
          </div>
          <ErrorNotice error={test.error} />
        </form>
      </section>
      <section className="card">
        <h2>Son gönderimler</h2>
        {d.isLoading ? <Loading /> : <ErrorNotice error={d.error} />}
        {d.data && !d.data.length ? <Empty>Henüz kayıt yok.</Empty> : (
          <table>
            <thead><tr><th>Zaman</th><th>Bildirim</th><th>Alıcı</th><th>Durum</th></tr></thead>
            <tbody>{d.data?.map((x) => (
              <tr key={x.id}>
                <td className="muted">{fmtDate(x.createdAt)}</td>
                <td>{TOPIC[x.topic] ?? x.topic}</td>
                <td className="mono">{x.recipient}</td>
                <td><span className={`badge ${STATUS[x.status] ?? ""}`}>{x.status}</span>{x.error ? <div className="muted">{x.error}</div> : null}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>
    </>
  );
}
