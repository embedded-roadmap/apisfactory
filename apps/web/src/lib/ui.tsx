import { createContext, useContext, type ReactNode } from "react";
import { DEFAULT_ROLES, t as translate, type Locale, type Me, type Permission } from "@apisfactory/shared";
import { Link } from "react-router-dom";
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
  rejected: "bad", cancelled: "bad", quarantine: "bad", error: "bad", suspended: "bad", aborted: "bad",
  in_progress: "warn", paused: "warn", test_failed: "bad", rework: "warn", passed: "ok", scrapped: "bad", completed: "ok", done: "ok", shipped: "ok", in_process: "", on_hold: "bad", out_of_service: "bad", implemented: "ok", active: "ok", preparing: "warn", packed: "warn", delivered: "ok", problem: "bad", received: "warn", inspected: "warn", decided: "warn", closed: "ok", returned: "warn", in_repair: "warn", quarantined: "bad", blocked: "bad",
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
      {e.details && typeof e.details === "object" && Array.isArray((e.details as any).escalateToRoles) ? (
        <div>
          {(e.details as any).approverLimit && (e.details as any).approverLimit !== "unlimited" ? `Onay limitiniz: ${(e.details as any).approverLimit}. ` : ""}
          {(e.details as any).escalateToRoles.length ? `Onay yetkisi olan rol: ${(e.details as any).escalateToRoles.join(", ")} — onları bekleyen görev açıldı.` : ""}
        </div>
      ) : null}
      {e.details && typeof e.details === "object" && (e.details as any).fieldErrors ? (
        <ul>
          {Object.entries((e.details as any).fieldErrors as Record<string, string[]>).flatMap(([f, msgs]) => msgs.map((m) => <li key={f + m}><span className="mono">{f}</span>: {m}</li>))}
          {(((e.details as any).formErrors as string[] | undefined) ?? []).map((m) => <li key={m}>{m}</li>)}
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

/**
 * Yetki yoksa düğmeyi sessizce gizlemek yerine hangi rolün gerektiğini söyler. Rol adları varsayılan rol şablonundan
 * gelir (şirket rolleri özelleştirdiyse yol gösterici niteliktedir). Rol yönetebilen kullanıcıya ekrana bağlantı verir.
 */
export function NeedRole({ perm, what }: { perm: Permission; what: string }) {
  const can = useCan();
  if (can(perm)) return null;
  const names = Object.values(DEFAULT_ROLES).filter((r) => r.permissions.includes(perm)).map((r) => r.name.tr);
  return (
    <div className="notice" role="note">
      {what} için {names.length ? <>şu rollerden biri gerekir: <b>{names.join(", ")}</b>.</> : "yetkiniz yok."}{" "}
      {can("admin.roles") ? <Link to="/admin">Kullanıcılar & roller ekranından ekleyebilirsiniz.</Link> : "Şirket yöneticinizden isteyin."}
    </div>
  );
}
