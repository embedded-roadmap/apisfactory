import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, newKey, post } from "../lib/api";
import { ErrorNotice, fmtDate, useMe } from "../lib/ui";

/**
 * Kayda bağlı konuşma (W27). Kaydı görebilen herkes okur/yazar; bahsedilen kişi kaydı görme yetkisine sahip olmalı.
 * Mesaj metni değişmez; yazar gerekçeyle geri çekebilir.
 */
export function Discussion({ entityType, entityId }: { entityType: string; entityId: string }) {
  const { me } = useMe();
  const qc = useQueryClient();
  const key = ["thread", entityType, entityId];
  const q = useQuery({ queryKey: key, queryFn: () => get<any>(`/api/threads/${entityType}/${entityId}`) });
  const people = useQuery({ queryKey: ["mentionable", entityType, entityId], queryFn: () => get<any[]>(`/api/threads/${entityType}/${entityId}/mentionable`) });
  const [body, setBody] = useState("");
  const [mentions, setMentions] = useState<string[]>([]);
  const [replyTo, setReplyTo] = useState<any | null>(null);
  const [idem, setIdem] = useState(newKey());
  const [retract, setRetract] = useState<{ id: string; reason: string } | null>(null);
  const refresh = () => { qc.invalidateQueries({ queryKey: key }); qc.invalidateQueries({ queryKey: ["mentions"] }); };
  const send = useMutation({
    mutationFn: () => post(`/api/threads/${entityType}/${entityId}/messages`, { body, mentions, replyTo: replyTo?.id }, { "Idempotency-Key": idem }),
    onSuccess: () => { setBody(""); setMentions([]); setReplyTo(null); setIdem(newKey()); refresh(); },
  });
  const act = useMutation({ mutationFn: (f: () => Promise<unknown>) => f(), onSuccess: refresh });
  const count = q.data?.messages.length ?? 0;
  useEffect(() => {
    if (count > 0) post(`/api/threads/${entityType}/${entityId}/read`).then(() => qc.invalidateQueries({ queryKey: ["mentions"] })).catch(() => {});
  }, [count, entityType, entityId, qc]);
  const byId = new Map((q.data?.messages ?? []).map((m: any) => [m.id, m]));
  const lastRead = q.data?.lastReadAt;
  return (
    <section className="card" aria-label="Konuşma">
      <h2>Konuşma {count ? <span className="muted">({count})</span> : null}</h2>
      <ErrorNotice error={q.error} />
      {count === 0 && q.data ? <p className="muted" style={{ margin: 0 }}>Bu kayıtta henüz mesaj yok. Soru, karar ve bilgi burada kayda bağlı kalır.</p> : null}
      <div className="stack" style={{ gap: 10 }}>
        {q.data?.messages.map((m: any) => {
          const parent = m.replyTo ? (byId.get(m.replyTo) as any) : null;
          const unread = lastRead && m.authorId !== me?.user.id && m.createdAt > lastRead;
          return (
            <div key={m.id} className="msg" style={{ borderLeft: `3px solid ${unread ? "var(--accent, #f5b400)" : "var(--line, #ddd)"}`, paddingLeft: 10 }}>
              <div className="row" style={{ gap: 8 }}>
                <b>{m.authorName}</b><span className="muted" style={{ fontSize: 13 }}>{fmtDate(m.createdAt)}</span>
                {unread ? <span className="badge warn">yeni</span> : null}
              </div>
              {parent ? <div className="muted" style={{ fontSize: 13 }}>↪ {parent.authorName}: {parent.body ? `${String(parent.body).slice(0, 80)}${parent.body.length > 80 ? "…" : ""}` : "geri çekilmiş mesaj"}</div> : null}
              {m.body !== null ? <div style={{ whiteSpace: "pre-wrap" }}>{m.body}</div> : <div className="muted"><i>Mesaj geri çekildi — {m.retractReason}</i></div>}
              {m.mentions.length ? <div className="muted" style={{ fontSize: 13 }}>Bahsedilen: {m.mentions.map((x: any) => `@${x.name}`).join(", ")}</div> : null}
              {m.body !== null ? (
                <div className="row" style={{ gap: 6 }}>
                  <button className="link" onClick={() => setReplyTo(m)}>Yanıtla</button>
                  {m.authorId === me?.user.id ? <button className="link" onClick={() => setRetract({ id: m.id, reason: "" })}>Geri çek</button> : null}
                </div>
              ) : null}
              {retract && retract.id === m.id ? (
                <div className="row">
                  <input aria-label="Geri çekme gerekçesi" placeholder="Gerekçe" value={retract.reason} onChange={(e) => setRetract({ id: m.id, reason: e.target.value })} />
                  <button disabled={retract.reason.length < 3} onClick={() => { const reason = retract.reason; act.mutate(() => post(`/api/messages/${m.id}/retract`, { reason }).then(() => setRetract(null))); }}>Geri çek</button>
                  <button onClick={() => setRetract(null)}>Vazgeç</button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      <ErrorNotice error={act.error} />
      <form className="stack" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); if (body.trim()) send.mutate(); }}>
        {replyTo ? <div className="row muted" style={{ fontSize: 13 }}>↪ {replyTo.authorName} yanıtlanıyor <button type="button" className="link" onClick={() => setReplyTo(null)}>kaldır</button></div> : null}
        <textarea aria-label="Mesaj" rows={3} maxLength={4000} placeholder="Mesaj yazın…" value={body} onChange={(e) => setBody(e.target.value)} />
        <div className="row" style={{ flexWrap: "wrap" }}>
          <select aria-label="Kişiden bahset" value="" onChange={(e) => { if (e.target.value && !mentions.includes(e.target.value)) setMentions([...mentions, e.target.value]); }}>
            <option value="">@ Kişiden bahset…</option>
            {people.data?.filter((p) => p.id !== me?.user.id && !mentions.includes(p.id)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          {mentions.map((id) => {
            const p = people.data?.find((x) => x.id === id);
            return <span key={id} className="badge">@{p?.name ?? id} <button type="button" className="link" aria-label={`${p?.name} çıkar`} onClick={() => setMentions(mentions.filter((x) => x !== id))}>×</button></span>;
          })}
          <button className="primary" disabled={!body.trim() || send.isPending} style={{ marginLeft: "auto" }}>Gönder</button>
        </div>
        <span className="muted" style={{ fontSize: 13 }}>Yalnız bu kaydı görme yetkisi olan kişilerden bahsedilebilir; bahsedilen kişiye günlük işlerinde bildirim düşer.</span>
        <ErrorNotice error={send.error} />
      </form>
    </section>
  );
}

/** Bahsedildiğim okunmamış mesajlar (Günlük işler). */
export function MentionsCard() {
  const q = useQuery({ queryKey: ["mentions"], queryFn: () => get<any[]>("/api/mentions?unread=true") });
  if (!q.data?.length) return null;
  return (
    <section className="card">
      <h2>Bahsedildiğiniz mesajlar <span className="badge warn">{q.data.length}</span></h2>
      <table>
        <tbody>{q.data.map((m) => (
          <tr key={m.messageId}>
            <td><Link to={m.link}>{m.label ?? m.entityType}</Link></td>
            <td><b>{m.authorName}</b>: {m.excerpt ?? <i className="muted">geri çekildi</i>}</td>
            <td className="muted">{fmtDate(m.createdAt)}</td>
          </tr>
        ))}</tbody>
      </table>
    </section>
  );
}
