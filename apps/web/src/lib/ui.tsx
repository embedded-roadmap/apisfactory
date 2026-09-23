import { createContext, useContext, type ReactNode } from "react";
import { t as translate, type Locale, type Me, type Permission } from "@apisfactory/shared";
import { ApiError } from "./api";

export const MeContext = createContext<{ me: Me | null; locale: Locale; setLocale: (l: Locale) => void }>({ me: null, locale: "tr", setLocale: () => {} });

export function useMe() {
  return useContext(MeContext);
}

export function useT() {
  const { locale } = useMe();
  return (key: string) => translate(locale, key);
}

export function useCan() {
  const { me } = useMe();
  return (p: Permission) => !!me?.permissions.includes(p);
}

const STATE_TONE: Record<string, string> = {
  released: "ok", published: "ok", firm: "ok", approved: "ok", accepted: "ok", stock: "ok", finished: "ok", ok: "ok",
  handover_review: "warn", pilot: "warn", pending: "warn", open: "warn", incoming_inspection: "warn", partial: "warn", availability_review: "warn", new_item: "warn", ambiguous: "warn",
  rejected: "bad", cancelled: "bad", quarantine: "bad", error: "bad", suspended: "bad",
  in_progress: "warn", paused: "warn", test_failed: "bad", rework: "warn", passed: "ok", scrapped: "bad", completed: "ok", done: "ok", shipped: "ok", in_process: "", on_hold: "bad", out_of_service: "bad", implemented: "ok", active: "ok",
};

/** Durum rozeti: renk tek başına bilgi taşımaz, metin her zaman yazılır (prompt §25). */
export function StateBadge({ value, prefix = "state" }: { value: string; prefix?: string }) {
  const t = useT();
  const label = t(`${prefix}.${value}`);
  return <span className={`badge ${STATE_TONE[value] ?? ""}`}>{label.startsWith(`${prefix}.`) ? value : label}</span>;
}

export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error as ApiError;
  const msg = e.status === 403 ? "Bu işlem için yetkiniz yok." : e.message;
  return (
    <div className="notice bad" role="alert">
      <strong>{msg}</strong>
      {e.code && e.status !== 403 ? <span className="mono"> ({e.code})</span> : null}
      {e.details && typeof e.details === "object" && "lines" in (e.details as object) ? (
        <ul>
          {((e.details as any).lines as any[]).map((l) => (
            <li key={l.lineId}>
              {l.product}: {l.status}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function Loading() {
  const t = useT();
  return <div className="muted" aria-busy="true">{t("common.loading")}</div>;
}

export function Empty({ children }: { children?: ReactNode }) {
  const t = useT();
  return <div className="muted" style={{ padding: 16 }}>{children ?? t("common.empty")}</div>;
}

export function PageHeader({ title, actions, sub }: { title: string; actions?: ReactNode; sub?: ReactNode }) {
  return (
    <div className="row between">
      <div className="stack" style={{ gap: 4 }}>
        <h1>{title}</h1>
        {sub ? <div className="muted">{sub}</div> : null}
      </div>
      <div className="row">{actions}</div>
    </div>
  );
}

export const fmt = (v: string | number | null | undefined) =>
  v == null ? "—" : Number(v).toLocaleString("tr-TR", { maximumFractionDigits: 6 });
export const fmtDate = (v: string | null | undefined) => (v ? new Date(v).toLocaleString("tr-TR") : "—");
