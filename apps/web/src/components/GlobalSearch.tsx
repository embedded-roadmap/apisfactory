import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { get } from "../lib/api";
import { useT } from "../lib/ui";
import { NAV_PAGES } from "./Navigation";
import { openChat } from "./PeopleDock";

type Hit = { kind: "page" | "person" | "record"; key: string; title: string; subtitle?: string; to?: string; userId?: string };
const TYPE_LABEL: Record<string, string> = {
  product: "Ürün", sales_order: "Satış siparişi", purchase_order: "Satın alma siparişi", work_order: "İş emri",
  supplier: "Tedarikçi", customer: "Müşteri", item: "Kalem",
};

/** Kısa bekleme: her tuşta sunucuya gitmemek için. */
function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => { const h = setTimeout(() => setV(value), ms); return () => clearTimeout(h); }, [value, ms]);
  return v;
}

/**
 * Sağ üst genel arama (Ctrl+K): sayfalar (yetkiye göre, istemcide), kişiler ve kayıtlar (/api/search, yetkiye göre).
 * Kişi seçilince sağ alttaki sohbet penceresi açılır.
 */
export function GlobalSearch({ perms }: { perms: Set<string> }) {
  const t = useT();
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const dq = useDebounced(q.trim(), 250);
  const remote = useQuery({
    queryKey: ["search", dq],
    queryFn: () => get<{ results: { type: string; id: string; title: string; subtitle?: string; to?: string }[] }>(`/api/search?q=${encodeURIComponent(dq)}`),
    enabled: dq.length >= 2,
    staleTime: 15_000,
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); input.current?.focus(); setOpen(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const hits = useMemo<Hit[]>(() => {
    const needle = q.trim().toLocaleLowerCase("tr");
    if (!needle) return [];
    const pages: Hit[] = NAV_PAGES.filter((p) => (!p.perm || perms.has(p.perm)))
      .map((p) => ({ kind: "page" as const, key: `page:${p.to}`, title: t(p.key), subtitle: t(`nav.group.${p.group}`), to: p.to }))
      .filter((h) => h.title.toLocaleLowerCase("tr").includes(needle) || (h.subtitle ?? "").toLocaleLowerCase("tr").includes(needle))
      .slice(0, 6);
    const rest: Hit[] = (remote.data?.results ?? []).map((r) => r.type === "person"
      ? { kind: "person" as const, key: `person:${r.id}`, title: r.title, subtitle: "Kişi — sohbet aç", userId: r.id }
      : { kind: "record" as const, key: `${r.type}:${r.id}`, title: r.title, subtitle: [TYPE_LABEL[r.type] ?? r.type, r.subtitle].filter(Boolean).join(" · "), to: r.to });
    return [...pages, ...rest];
  }, [q, perms, remote.data, t]);

  function choose(h: Hit | undefined) {
    if (!h) return;
    if (h.kind === "person" && h.userId) openChat(h.userId, h.title);
    else if (h.to) nav(h.to);
    setQ(""); setOpen(false); setSel(0); input.current?.blur();
  }

  return (
    <div className="gsearch" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false); }}>
      <input ref={input} type="search" aria-label="Ara" placeholder="Ara: sayfa, kişi, kayıt… (Ctrl+K)" value={q}
        onFocus={() => setOpen(true)}
        onChange={(e) => { setQ(e.target.value); setOpen(true); setSel(0); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, Math.max(hits.length - 1, 0))); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
          else if (e.key === "Enter") { e.preventDefault(); choose(hits[sel]); }
          else if (e.key === "Escape") { setOpen(false); input.current?.blur(); }
        }} />
      {open && q.trim() ? (
        <div className="gsearch-pop" role="listbox" aria-label="Arama sonuçları">
          {hits.map((h, i) => (
            <button key={h.key} type="button" role="option" aria-selected={i === sel} className={i === sel ? "sel" : ""}
              onMouseEnter={() => setSel(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(h)}>
              <span className={`gsearch-kind ${h.kind}`}>{h.kind === "page" ? "Sayfa" : h.kind === "person" ? "Kişi" : "Kayıt"}</span>
              <span className="gsearch-text"><b>{h.title}</b>{h.subtitle ? <small>{h.subtitle}</small> : null}</span>
            </button>
          ))}
          {!hits.length && !remote.isFetching ? <div className="muted gsearch-empty">{q.trim().length < 2 ? "Kişi ve kayıt aramak için en az 2 karakter" : "Sonuç yok"}</div> : null}
          {remote.isFetching ? <div className="muted gsearch-empty">Aranıyor…</div> : null}
        </div>
      ) : null}
    </div>
  );
}
