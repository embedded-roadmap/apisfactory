import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { get, post } from "../lib/api";
import { Empty, ErrorNotice, Loading, PageHeader, fmtDate } from "../lib/ui";
import { Discussion } from "../components/Discussion";

/** R25 — birebir mesajlar: yalnız iki katılımcı görür (yönetici dahil başkası göremez; veri tabanında da korunur). */
export function DirectMessagesPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const list = useQuery({ queryKey: ["directs"], queryFn: () => get<any[]>("/api/direct-conversations"), refetchInterval: 30_000 });
  const people = useQuery({ queryKey: ["directPeople"], queryFn: () => get<any[]>("/api/direct-conversations/people") });
  const [to, setTo] = useState("");
  const start = useMutation({
    mutationFn: () => post<{ id: string }>("/api/direct-conversations", { userId: to }),
    onSuccess: (r) => { setTo(""); list.refetch(); nav(`/collaboration/direct/${r.id}`); },
  });
  const current = list.data?.find((c) => c.id === id);
  return (
    <>
      <PageHeader title="Mesajlar" sub="Birebir konuşmalar yalnız iki kişiye görünür. Kayda bağlı konuşmalar için ilgili kaydın sayfasını, ekip konuşmaları için kanalları kullanın." />
      <div className="row" style={{ alignItems: "flex-start" }}>
        <section className="card" style={{ width: 300 }}>
          <form className="row" onSubmit={(e) => { e.preventDefault(); start.mutate(); }}>
            <select aria-label="Mesaj gönderilecek kişi" value={to} onChange={(e) => setTo(e.target.value)} style={{ flex: 1 }}>
              <option value="">Yeni konuşma…</option>
              {people.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <button disabled={!to || start.isPending}>Aç</button>
          </form>
          <ErrorNotice error={start.error} />
          {list.isLoading ? <Loading /> : <ErrorNotice error={list.error} />}
          {list.data?.length === 0 ? <Empty>Henüz konuşma yok.</Empty> : null}
          {list.data?.map((c) => (
            <button key={c.id} type="button" className="link" onClick={() => nav(`/collaboration/direct/${c.id}`)}
              style={{ display: "block", width: "100%", textAlign: "left", padding: "6px 0", fontWeight: c.id === id ? 700 : 400 }}>
              {c.name} {c.unread ? <span className="badge warn">{c.unread}</span> : null}
              <div className="muted" style={{ fontSize: 12 }}>{c.lastMessageAt ? fmtDate(c.lastMessageAt) : "mesaj yok"}</div>
            </button>
          ))}
        </section>
        <div style={{ flex: 1, minWidth: 0 }}>
          {id ? (
            <>
              <h2 style={{ marginTop: 0 }}>{current?.name ?? ""}</h2>
              <Discussion key={id} entityType="direct" entityId={id} />
            </>
          ) : <section className="card"><Empty>Soldan bir konuşma seçin veya yeni konuşma açın.</Empty></section>}
        </div>
      </div>
    </>
  );
}
