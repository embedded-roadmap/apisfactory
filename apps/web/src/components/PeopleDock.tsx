import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, get, post } from "../lib/api";
import { ErrorNotice } from "../lib/ui";
import { Discussion } from "./Discussion";

type Presence = "available" | "busy" | "away" | "offline";
type Person = { id: string; name: string; status: Presence; lastSeenAt: string | null };
type MyStatus = "available" | "busy" | "away" | "invisible";

export const STATUS_LABEL: Record<Presence | "invisible", string> = {
  available: "Çevrimiçi", busy: "Meşgul", away: "Dışarıda", offline: "Çevrimdışı", invisible: "Çevrimdışı görün",
};
const EVENT = "apis:open-chat";

/** Başka bir bileşenden (ör. arama kutusu) sohbet penceresini açar. */
export function openChat(userId: string, name: string) {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { userId, name } }));
}

export function StatusDot({ status }: { status: Presence | MyStatus }) {
  const s = status === "invisible" ? "offline" : status;
  return <span className={`pdot ${s}`} title={STATUS_LABEL[status]} aria-label={STATUS_LABEL[status]} />;
}

/**
 * Teams benzeri kişiler paneli (sağ alt): şirket içi kişiler ve durumları, kendi durumum, okunmamış birebir mesajlar ve
 * küçük sohbet penceresi (birebir konuşma altyapısı — R25; yalnız iki kişi görür).
 */
export function PeopleDock() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [chat, setChat] = useState<{ userId: string; name: string; convId?: string } | null>(null);

  // Görünür sekmede dakikada bir "buradayım" sinyali; arka plandaki sekme sinyal göndermez (2 dk sonra çevrimdışı görünür).
  useEffect(() => {
    const beat = () => { if (document.visibilityState === "visible") post("/api/presence/heartbeat").catch(() => {}); };
    beat();
    const h = setInterval(beat, 60_000);
    document.addEventListener("visibilitychange", beat);
    return () => { clearInterval(h); document.removeEventListener("visibilitychange", beat); };
  }, []);

  const presence = useQuery({ queryKey: ["presence"], queryFn: () => get<{ me: { status: MyStatus }; people: Person[] }>("/api/presence"), refetchInterval: open ? 20_000 : 60_000 });
  const directs = useQuery({ queryKey: ["directs"], queryFn: () => get<{ id: string; userId: string; unread: number }[]>("/api/direct-conversations"), refetchInterval: 30_000 });
  const setStatus = useMutation({
    mutationFn: (status: MyStatus) => api("PUT", "/api/presence/status", { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["presence"] }),
  });
  const start = useMutation({
    mutationFn: (userId: string) => post<{ id: string }>("/api/direct-conversations", { userId }),
    onSuccess: (r, userId) => setChat((c) => (c && c.userId === userId ? { ...c, convId: r.id } : c)),
  });

  const startChat = start.mutate; // TanStack Query v5: mutate kararlı başvurudur
  useEffect(() => {
    const onOpen = (e: Event) => {
      const { userId, name } = (e as CustomEvent<{ userId: string; name: string }>).detail;
      setChat({ userId, name });
      startChat(userId);
    };
    window.addEventListener(EVENT, onOpen);
    return () => window.removeEventListener(EVENT, onOpen);
  }, [startChat]);

  const unreadBy = new Map((directs.data ?? []).map((d) => [d.userId, d.unread]));
  const totalUnread = (directs.data ?? []).reduce((s, d) => s + (d.unread || 0), 0);
  const people = presence.data?.people ?? [];
  const online = people.filter((p) => p.status !== "offline").length;
  const me = presence.data?.me.status ?? "available";

  return (
    <>
      {chat ? (
        <section className="chatwin" aria-label={`${chat.name} ile sohbet`}>
          <header>
            <StatusDot status={people.find((p) => p.id === chat.userId)?.status ?? "offline"} />
            <b>{chat.name}</b>
            <span className="muted" style={{ fontSize: 12 }}>{STATUS_LABEL[people.find((p) => p.id === chat.userId)?.status ?? "offline"]}</span>
            <button type="button" aria-label="Sohbeti kapat" onClick={() => { setChat(null); qc.invalidateQueries({ queryKey: ["directs"] }); }}>✕</button>
          </header>
          <div className="chatwin-body">
            {chat.convId ? <Discussion entityType="direct" entityId={chat.convId} /> : start.error ? <ErrorNotice error={start.error} /> : <div className="muted">Açılıyor…</div>}
          </div>
        </section>
      ) : null}

      {open ? (
        <section className="peoplepanel" aria-label="Kişiler">
          <header>
            <b>Kişiler</b>
            <label className="row" style={{ gap: 6, fontSize: 13 }}>
              <StatusDot status={me} />
              <select aria-label="Durumum" value={me} onChange={(e) => setStatus.mutate(e.target.value as MyStatus)}>
                {(["available", "busy", "away", "invisible"] as MyStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
              </select>
            </label>
          </header>
          <ErrorNotice error={presence.error ?? setStatus.error} />
          <div className="peoplelist">
            {people.length === 0 && !presence.isLoading ? <div className="muted" style={{ padding: 12 }}>Şirkette başka kişi yok.</div> : null}
            {people.map((p) => (
              <button key={p.id} type="button" className="person" onClick={() => { setChat({ userId: p.id, name: p.name }); start.mutate(p.id); }}>
                <StatusDot status={p.status} />
                <span className="person-name">{p.name}<small>{STATUS_LABEL[p.status]}</small></span>
                {unreadBy.get(p.id) ? <span className="badge warn">{unreadBy.get(p.id)}</span> : null}
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <button type="button" className="peopledock-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
        <StatusDot status={me} /> Kişiler <span className="muted">{online} çevrimiçi</span>
        {totalUnread ? <span className="badge warn">{totalUnread}</span> : null}
      </button>
    </>
  );
}
