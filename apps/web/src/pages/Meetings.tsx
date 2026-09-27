import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { auth, get, newKey, post } from "../lib/api";
import { Empty, ErrorNotice, Loading, PageHeader, fmtDate, useCan, useMe } from "../lib/ui";
import { Tabs } from "./Planning";
import { History } from "./Sales";
import { Discussion } from "../components/Discussion";

const STATUS: Record<string, [string, string]> = { planned: ["planlandı", "warn"], closed: ["tutanak kapandı", "ok"], cancelled: ["iptal", ""] };
const ATT: Record<string, string> = { invited: "davetli", attended: "katıldı", absent: "katılmadı", excused: "mazeretli" };
const KIND: Record<string, string> = { decision: "Karar", action: "Aksiyon", info: "Bilgi" };
const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

/** W28 — toplantılar: gündem, katılım, tutanak; aksiyonlar kapanışta göreve dönüşür. */
export function MeetingsPage() {
  const can = useCan();
  const nav = useNavigate();
  const [scope, setScope] = useState("upcoming");
  const q = useQuery({ queryKey: ["meetings", scope], queryFn: () => get<any[]>(`/api/meetings?scope=${scope}`) });
  const org = useQuery({ queryKey: ["org"], queryFn: () => get<any>("/api/org") });
  const { me } = useMe();
  const [show, setShow] = useState(false);
  const [f, setF] = useState({ title: "", startsAt: localInput(new Date(Date.now() + 86400e3)), durationMinutes: "60", location: "", agenda: "", participantIds: [] as string[] });
  const [key] = useState(newKey());
  const create = useMutation({
    mutationFn: () => post<any>("/api/meetings", { ...f, startsAt: new Date(f.startsAt).toISOString(), durationMinutes: Number(f.durationMinutes) || 60, location: f.location || undefined, agenda: f.agenda || undefined }, { "Idempotency-Key": key }),
    onSuccess: (m) => nav(`/planning/meetings/${m.id}`),
  });
  return (
    <>
      <PageHeader title="Görev & Plan" sub="Toplantı kararları kayıt altında kalır; aksiyonlar tutanak kapanınca sorumlusuna bitiş tarihli görev olarak açılır. Google veya Microsoft takviminizi bağlarsanız düzenlediğiniz toplantılar takviminize yazılır ve takvimdeki saat değişiklikleri buraya yansır." />
      <Tabs />
      <CalendarConnections />
      <section className="card">
        <div className="row between">
          <div className="row">
            {([["upcoming", "Yaklaşan"], ["mine", "Katıldıklarım"], ["past", "Geçmiş"], ["all", "Tümü"]] as const).map(([k, l]) => (
              <button key={k} className={scope === k ? "primary" : ""} onClick={() => setScope(k)}>{l}</button>
            ))}
          </div>
          {can("task.manage") ? <button onClick={() => setShow(!show)}>Yeni toplantı</button> : null}
        </div>
        {show ? (
          <form className="stack" onSubmit={(e: FormEvent) => { e.preventDefault(); create.mutate(); }}>
            <div className="row">
              <label className="field" style={{ flex: 1 }}>Başlık<input aria-label="Toplantı başlığı" required minLength={3} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
              <label className="field">Başlangıç<input aria-label="Toplantı zamanı" type="datetime-local" required value={f.startsAt} onChange={(e) => setF({ ...f, startsAt: e.target.value })} /></label>
              <label className="field" style={{ width: 100 }}>Süre (dk)<input inputMode="numeric" value={f.durationMinutes} onChange={(e) => setF({ ...f, durationMinutes: e.target.value })} /></label>
              <label className="field">Yer<input value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} /></label>
            </div>
            <label className="field">Gündem<textarea aria-label="Gündem" rows={3} value={f.agenda} onChange={(e) => setF({ ...f, agenda: e.target.value })} /></label>
            <div className="row" style={{ flexWrap: "wrap" }}>
              <b>Katılımcılar:</b>
              {org.data?.users.filter((u: any) => u.id !== me?.user.id).map((u: any) => (
                <label key={u.id} className="row" style={{ gap: 4 }}>
                  <input type="checkbox" style={{ minHeight: 0 }} checked={f.participantIds.includes(u.id)} onChange={(e) => setF({ ...f, participantIds: e.target.checked ? [...f.participantIds, u.id] : f.participantIds.filter((x) => x !== u.id) })} /> {u.name}
                </label>
              ))}
            </div>
            <div className="row"><button className="primary" disabled={create.isPending}>Toplantıyı oluştur</button><span className="muted">Siz düzenleyen olarak eklenirsiniz.</span></div>
            <ErrorNotice error={create.error} />
          </form>
        ) : null}
      </section>
      <section className="card">
        {q.isLoading ? <Loading /> : <ErrorNotice error={q.error} />}
        {q.data?.length === 0 ? <Empty>Toplantı yok.</Empty> : null}
        {q.data?.length ? (
          <table>
            <thead><tr><th>Kod</th><th>Başlık</th><th>Zaman</th><th>Düzenleyen</th><th className="num">Katılımcı</th><th className="num">Aksiyon (açık)</th><th>Durum</th></tr></thead>
            <tbody>{q.data.map((m) => (
              <tr key={m.id}>
                <td className="mono"><Link to={`/planning/meetings/${m.id}`}>{m.code}</Link></td><td>{m.title} {m.isParticipant ? <span className="badge">katılımcı</span> : null}</td>
                <td>{fmtDate(m.startsAt)} <span className="muted">· {m.durationMinutes} dk{m.location ? ` · ${m.location}` : ""}</span></td><td>{m.organizerName}</td>
                <td className="num">{m.participants}</td><td className="num">{m.actions} ({m.openActions})</td>
                <td><span className={`badge ${STATUS[m.status]![1]}`}>{STATUS[m.status]![0]}</span></td>
              </tr>
            ))}</tbody>
          </table>
        ) : null}
      </section>
    </>
  );
}

const PROVIDER_LABEL: Record<string, string> = { google: "Google Takvim", microsoft: "Microsoft 365 / Outlook" };
const CAL_RESULT: Record<string, [string, string]> = {
  connected: ["ok", "Takvim bağlandı."],
  denied: ["warn", "Takvim erişimine izin verilmedi; bağlantı açılmadı."],
  error: ["bad", "Takvim bağlanamadı (süre doldu veya sağlayıcı hata verdi). Tekrar deneyin."],
};

/**
 * Madde 5 — kişisel takvim bağlantısı (OAuth). "Bağla" sağlayıcının onay ekranına gider; dönüşte ?calendar=... ile
 * sonuç gösterilir. Token sunucuda şifreli saklanır; bu ekran yalnız durumu gösterir.
 */
function CalendarConnections() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["calendarStatus"], queryFn: () => get<any>("/api/calendar/status") });
  const result = new URLSearchParams(window.location.search).get("calendar");
  const connect = useMutation({ mutationFn: (p: string) => post<{ authorizeUrl: string }>(`/api/calendar/connect/${p}`), onSuccess: (r) => { window.location.href = r.authorizeUrl; } });
  const disconnect = useMutation({ mutationFn: (p: string) => post(`/api/calendar/disconnect/${p}`), onSuccess: () => qc.invalidateQueries({ queryKey: ["calendarStatus"] }) });
  const sync = useMutation({ mutationFn: () => post<{ applied: number; seen: number }>("/api/calendar/sync"), onSuccess: () => { qc.invalidateQueries({ queryKey: ["calendarStatus"] }); qc.invalidateQueries({ queryKey: ["meetings"] }); } });
  const d = q.data;
  if (!d) return q.isLoading ? null : <ErrorNotice error={q.error} />;
  const anyConfigured = Object.values(d.providers).some((p: any) => p.configured);
  const active = d.connections.filter((c: any) => c.status === "active");
  return (
    <section className="card">
      <div className="row between">
        <h2 style={{ margin: 0 }}>Takvim bağlantım</h2>
        {active.length ? <button disabled={sync.isPending} onClick={() => sync.mutate()}>{sync.isPending ? "Senkronlanıyor…" : "Şimdi senkronla"}</button> : null}
      </div>
      {result && CAL_RESULT[result] ? <div className={`notice ${CAL_RESULT[result]![0]}`}>{CAL_RESULT[result]![1]}</div> : null}
      {!anyConfigured ? <p className="muted" style={{ margin: 0 }}>Takvim senkronu henüz etkin değil: platform işletmecisi Google/Microsoft OAuth uygulamasını yapılandırmadı. O zamana kadar toplantı sayfasından .ics daveti indirilebilir.</p> : null}
      <table>
        <tbody>{(["google", "microsoft"] as const).map((p) => {
          const c = d.connections.find((x: any) => x.provider === p);
          const on = c?.status === "active";
          return (
            <tr key={p}>
              <td><b>{PROVIDER_LABEL[p]}</b>{c?.accountEmail ? <div className="muted" style={{ fontSize: 13 }}>{c.accountEmail}</div> : null}</td>
              <td>
                {on ? <span className="badge ok">bağlı</span> : c?.status === "error" ? <span className="badge bad">yeniden bağlanın</span> : <span className="muted">bağlı değil</span>}
                {c?.lastSyncedAt ? <div className="muted" style={{ fontSize: 13 }}>son senkron {fmtDate(c.lastSyncedAt)}</div> : null}
                {c?.lastError ? <div className="muted" style={{ fontSize: 13 }}>{c.lastError}</div> : null}
              </td>
              <td>
                {!d.providers[p].configured ? <span className="muted">yapılandırılmadı</span>
                  : on ? <button disabled={disconnect.isPending} onClick={() => disconnect.mutate(p)}>Bağlantıyı kes</button>
                  : <button className="primary" disabled={connect.isPending} onClick={() => connect.mutate(p)}>{c ? "Yeniden bağla" : "Bağla"}</button>}
              </td>
            </tr>
          );
        })}</tbody>
      </table>
      {sync.data ? <p className="muted" style={{ margin: 0 }}>{sync.data.seen} takvim değişikliği incelendi, {sync.data.applied} toplantı güncellendi.</p> : null}
      <ErrorNotice error={connect.error ?? disconnect.error ?? sync.error} />
    </section>
  );
}

/** Takvim daveti indir (.ics) — bağlı takvimi olmayan katılımcılar için standart dosya; kendi takvimine elle içe aktarır. */
async function downloadIcs(id: string, code: string) {
  const { session, companyId } = auth.get();
  const res = await fetch(`/api/meetings/${id}/ics`, { headers: { authorization: `Bearer ${session?.token}`, "x-company-id": companyId ?? "" } });
  if (!res.ok) return;
  const blob = await res.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `toplanti-${code}.ics`;
  a.click();
}

export function MeetingPage() {
  const { id } = useParams();
  const can = useCan();
  const { me } = useMe();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["meeting", id], queryFn: () => get<any>(`/api/meetings/${id}`) });
  const org = useQuery({ queryKey: ["org"], queryFn: () => get<any>("/api/org") });
  const act = useMutation({ mutationFn: (f: () => Promise<any>) => f(), onSuccess: () => { qc.invalidateQueries({ queryKey: ["meeting", id] }); qc.invalidateQueries({ queryKey: ["meetings"] }); qc.invalidateQueries({ queryKey: ["history"] }); } });
  const [notes, setNotes] = useState<string | null>(null);
  const [item, setItem] = useState({ kind: "decision", text: "", ownerUserId: "", dueDate: "" });
  const [addUser, setAddUser] = useState("");
  const [cancel, setCancel] = useState("");
  const [pushResult, setPushResult] = useState<{ status: string; reason?: string } | null>(null);
  const m = q.data;
  useEffect(() => { if (m && notes === null) setNotes(m.notes ?? ""); }, [m, notes]);
  if (!m) return q.isLoading ? <Loading /> : <ErrorNotice error={q.error} />;
  const edit = m.status === "planned" && (m.organizerId === me?.user.id || can("task.manage"));
  const pendingAtt = m.participants.filter((p: any) => p.attendance === "invited").length;
  return (
    <>
      <PageHeader
        title={`${m.code} — ${m.title}`}
        sub={<>{fmtDate(m.startsAt)} · {m.durationMinutes} dk{m.location ? ` · ${m.location}` : ""} · düzenleyen {m.organizerName}{m.entityLink ? <> · bağlı kayıt <Link to={m.entityLink}>{m.entityLabel}</Link></> : null} · <Link to="/planning/meetings">← Toplantılar</Link></>}
        actions={<>
          {m.organizerId === me?.user.id || can("task.manage") ? <button className="ghost" disabled={act.isPending} onClick={() => act.mutate(() => post(`/api/meetings/${id}/calendar-push`).then((r: any) => setPushResult(r)))}>Takvime gönder</button> : null}
          <button className="ghost" onClick={() => downloadIcs(id!, m.code)}>Takvime ekle (.ics)</button> <span className={`badge ${STATUS[m.status]![1]}`}>{STATUS[m.status]![0]}</span>
        </>}
      />
      <ErrorNotice error={act.error} />
      {pushResult ? (
        <div className={`notice ${pushResult.status === "skipped" ? "warn" : "ok"}`}>
          {pushResult.status === "skipped"
            ? pushResult.reason === "no_connection" ? "Düzenleyenin bağlı takvimi yok — Toplantılar sayfasından takvim bağlayın." : "Bu toplantı takvime gönderilmedi (kapanmış/iptal)."
            : `Takvim güncellendi (${pushResult.status === "created" ? "etkinlik oluşturuldu" : pushResult.status === "updated" ? "etkinlik güncellendi" : "etkinlik iptal edildi"}); davetleri takvim sağlayıcısı gönderir.`}
        </div>
      ) : null}
      {m.status === "cancelled" ? <div className="notice">İptal edildi: {m.cancelReason}</div> : null}
      {m.status === "closed" ? <div className="notice">Tutanak {m.closedBy} tarafından {fmtDate(m.closedAt)} kapatıldı; değiştirilemez.</div> : null}
      <div className="grid2" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 16 }}>
        <section className="card">
          <h2>Gündem</h2>
          <div style={{ whiteSpace: "pre-wrap" }}>{m.agenda || <span className="muted">Gündem girilmemiş.</span>}</div>
        </section>
        <section className="card">
          <h2>Katılım {pendingAtt && m.status === "planned" ? <span className="badge warn">{pendingAtt} işaretlenmedi</span> : null}</h2>
          <table><tbody>{m.participants.map((p: any) => (
            <tr key={p.userId}>
              <td>{p.name}{p.userId === m.organizerId ? <span className="muted"> (düzenleyen)</span> : null}</td>
              <td>{edit ? (
                <select aria-label={`${p.name} katılım`} value={p.attendance} onChange={(e) => { const attendance = e.target.value; act.mutate(() => post(`/api/meetings/${id}/participants`, { userId: p.userId, attendance })); }}>
                  {Object.entries(ATT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              ) : ATT[p.attendance]}</td>
              <td>{edit && p.userId !== m.organizerId ? <button className="link" onClick={() => act.mutate(() => post(`/api/meetings/${id}/participants`, { userId: p.userId, action: "remove" }))}>çıkar</button> : null}</td>
            </tr>
          ))}</tbody></table>
          {edit ? (
            <div className="row">
              <select aria-label="Katılımcı ekle" value={addUser} onChange={(e) => setAddUser(e.target.value)}>
                <option value="">Katılımcı ekle…</option>
                {org.data?.users.filter((u: any) => !m.participants.some((p: any) => p.userId === u.id)).map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
              <button disabled={!addUser} onClick={() => act.mutate(() => post(`/api/meetings/${id}/participants`, { userId: addUser }).then(() => setAddUser("")))}>Ekle</button>
            </div>
          ) : null}
        </section>
      </div>

      <section className="card">
        <h2>Tutanak</h2>
        {edit ? (
          <>
            <textarea aria-label="Tutanak notları" rows={5} value={notes ?? ""} onChange={(e) => setNotes(e.target.value)} placeholder="Görüşülenler…" />
            <div className="row"><button disabled={notes === (m.notes ?? "")} onClick={() => act.mutate(() => post(`/api/meetings/${id}/update`, { notes: notes || null }))}>Notları kaydet</button></div>
          </>
        ) : <div style={{ whiteSpace: "pre-wrap" }}>{m.notes || <span className="muted">Not yok.</span>}</div>}
        <h3>Kararlar ve aksiyonlar</h3>
        {m.items.length === 0 ? <Empty>Madde yok.</Empty> : (
          <table>
            <thead><tr><th>#</th><th>Tür</th><th>Madde</th><th>Sorumlu</th><th>Bitiş</th><th>Görev</th><th /></tr></thead>
            <tbody>{m.items.map((i: any) => (
              <tr key={i.id}>
                <td>{i.seq}</td><td><span className={`badge ${i.kind === "action" ? "warn" : i.kind === "decision" ? "ok" : ""}`}>{KIND[i.kind]}</span></td>
                <td style={{ whiteSpace: "pre-wrap" }}>{i.text}</td><td>{i.ownerName ?? "—"}</td><td>{i.dueDate ?? "—"}</td>
                <td>{i.taskId ? <Link to={`/planning/tasks/${i.taskId}`}>görev ({({ open: "açık", in_progress: "sürüyor", blocked: "engelli", done: "tamamlandı", cancelled: "iptal" } as Record<string, string>)[i.taskStatus] ?? i.taskStatus})</Link> : i.kind === "action" ? <span className="muted">kapanışta açılır</span> : ""}</td>
                <td>{edit ? <button className="link" onClick={() => act.mutate(() => post(`/api/meetings/${id}/items/${i.id}/remove`))}>sil</button> : null}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
        {edit ? (
          <form className="row" style={{ flexWrap: "wrap" }} onSubmit={(e) => { e.preventDefault(); act.mutate(() => post(`/api/meetings/${id}/items`, { kind: item.kind, text: item.text, ownerUserId: item.ownerUserId || undefined, dueDate: item.dueDate || undefined }).then(() => setItem({ ...item, text: "" }))); }}>
            <select aria-label="Madde türü" value={item.kind} onChange={(e) => setItem({ ...item, kind: e.target.value })}>{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
            <input aria-label="Madde metni" placeholder="Karar / aksiyon / bilgi" required minLength={3} value={item.text} onChange={(e) => setItem({ ...item, text: e.target.value })} style={{ flex: 1, minWidth: 240 }} />
            {item.kind === "action" ? (
              <>
                <select aria-label="Aksiyon sorumlusu" required value={item.ownerUserId} onChange={(e) => setItem({ ...item, ownerUserId: e.target.value })}>
                  <option value="">Sorumlu</option>{org.data?.users.map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
                <input aria-label="Aksiyon bitişi" type="date" required value={item.dueDate} onChange={(e) => setItem({ ...item, dueDate: e.target.value })} />
              </>
            ) : null}
            <button>Ekle</button>
          </form>
        ) : null}
        {edit ? (
          <div className="row" style={{ marginTop: 12 }}>
            <button className="primary" disabled={act.isPending} onClick={() => act.mutate(() => post(`/api/meetings/${id}/close`))}>Tutanağı kapat ve aksiyonları göreve dönüştür</button>
            <input aria-label="İptal gerekçesi" placeholder="İptal gerekçesi" value={cancel} onChange={(e) => setCancel(e.target.value)} />
            <button className="danger" disabled={cancel.length < 3} onClick={() => act.mutate(() => post(`/api/meetings/${id}/cancel`, { reason: cancel }))}>Toplantıyı iptal et</button>
          </div>
        ) : null}
        {edit ? <p className="muted" style={{ margin: 0 }}>Kapanış için tüm katılım durumları işaretlenmeli ve en az bir madde olmalı. Kapandıktan sonra tutanak değişmez.</p> : null}
      </section>
      <Discussion entityType="meeting" entityId={m.id} />
      <History entityType="meeting" id={m.id} />
    </>
  );
}
