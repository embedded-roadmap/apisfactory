import { useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import type { Permission } from "@apisfactory/shared";
import { useT } from "../lib/ui";

export type NavPage = { to: string; key: string; perm?: Permission };
type NavGroup = { key: string; pages: NavPage[] };

/**
 * Menü ana başlıkları (kullanıcı isteği, 2026-10-07): Sohbet, Görev & Plan, Ar-Ge, Depo, Üretim, Kalite, Satış, Satın alma,
 * Muhasebe, Yönetim, Yardım. Yetkisi olmayan sayfa ve içi boş kalan başlık gösterilmez.
 */
export const NAV_GROUPS: NavGroup[] = [
  { key: "chat", pages: [
    { to: "/collaboration/direct", key: "nav.direct", perm: "task.view" },
    { to: "/collaboration/channels", key: "nav.channels", perm: "task.view" },
  ] },
  { key: "plan", pages: [
    { to: "/", key: "nav.today", perm: "task.view" },
    { to: "/planning", key: "nav.planning", perm: "task.view" },
    { to: "/workflow", key: "nav.workflow", perm: "task.view" },
  ] },
  { key: "rd", pages: [
    { to: "/products", key: "nav.products", perm: "product.view" },
    { to: "/rd-projects", key: "nav.rdProjects", perm: "rd.project.view" },
    { to: "/changes", key: "nav.changes", perm: "change.view" },
  ] },
  { key: "warehouse", pages: [
    { to: "/inventory", key: "nav.inventory", perm: "inventory.view" },
    { to: "/receiving", key: "nav.receiving", perm: "inventory.view" },
    { to: "/shipments", key: "nav.shipments", perm: "shipment.view" },
  ] },
  { key: "production", pages: [
    { to: "/production", key: "nav.production", perm: "production.view" },
    { to: "/devices", key: "nav.devices", perm: "production.view" },
    { to: "/subcontract-jobs", key: "nav.subcontractJobs", perm: "subcontract.manage" },
  ] },
  { key: "quality", pages: [
    { to: "/quality", key: "nav.quality", perm: "production.view" },
    { to: "/returns", key: "nav.returns", perm: "rma.view" },
  ] },
  { key: "sales", pages: [
    { to: "/sales", key: "nav.sales", perm: "sales.view" },
  ] },
  { key: "purchasing", pages: [
    { to: "/purchasing", key: "nav.purchasing", perm: "purchase.view" },
  ] },
  { key: "accounting", pages: [
    { to: "/receivables", key: "nav.receivables", perm: "receivable.view" },
    { to: "/payables", key: "nav.payables", perm: "invoice.view" },
    { to: "/reports", key: "nav.reports", perm: "report.view" },
  ] },
  { key: "admin", pages: [
    { to: "/reports/executive", key: "nav.reportsExecutive", perm: "report.view" },
    { to: "/scenarios", key: "nav.scenarios", perm: "report.view" },
    { to: "/admin", key: "nav.admin", perm: "admin.users" },
    { to: "/events", key: "nav.events", perm: "audit.view" },
    { to: "/subscription", key: "nav.subscription", perm: "subscription.view" },
    { to: "/imports", key: "nav.imports" },
  ] },
  { key: "help", pages: [
    { to: "/help", key: "nav.help" },
    { to: "/onboarding", key: "nav.onboarding" },
  ] },
];

/** Arama kutusu için düz sayfa listesi. */
export const NAV_PAGES: (NavPage & { group: string })[] = NAV_GROUPS.flatMap((g) => g.pages.map((p) => ({ ...p, group: g.key })));

const visible = (perms: Set<string>) => (p: NavPage) => !p.perm || perms.has(p.perm);
const matches = (pathname: string, to: string) => (to === "/" ? pathname === "/" : pathname === to || pathname.startsWith(`${to}/`));
/** Adrese en uzun eşleşen sayfa (ör. /reports/executive → Yönetici raporu, Maliyet & Metrikler değil). */
export function activePage(pathname: string): string | undefined {
  return NAV_PAGES.filter((p) => matches(pathname, p.to)).sort((a, b) => b.to.length - a.to.length)[0]?.to;
}
const STORE = "apis.nav.open";

function loadOpen(): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem(STORE) ?? "{}"); } catch { return {}; }
}

export function NavGroups({ perms }: { perms: Set<string> }) {
  const t = useT();
  const { pathname } = useLocation();
  const [open, setOpen] = useState<Record<string, boolean>>(loadOpen);
  const toggle = (k: string, current: boolean) => {
    const next = { ...open, [k]: !current };
    setOpen(next);
    try { localStorage.setItem(STORE, JSON.stringify(next)); } catch { /* tarayıcı depolaması kapalı olabilir */ }
  };
  return (
    <>
      {NAV_GROUPS.map((g) => {
        const pages = g.pages.filter(visible(perms));
        if (!pages.length) return null;
        // Bulunulan sayfanın başlığı her zaman açık; diğerleri kullanıcının son seçimine göre.
        const current = activePage(pathname);
        const here = pages.some((p) => p.to === current);
        const isOpen = here || (open[g.key] ?? false);
        return (
          <div key={g.key} className={`nav-group${here ? " here" : ""}`}>
            <button type="button" className="nav-group-head" aria-expanded={isOpen} onClick={() => toggle(g.key, isOpen)}>
              <span>{t(`nav.group.${g.key}`)}</span>
              <span aria-hidden="true" className="nav-caret">{isOpen ? "▾" : "▸"}</span>
            </button>
            {isOpen ? (
              <div className="nav-group-items">
                {pages.map((p) => <NavLink key={p.to} to={p.to} className={p.to === current ? "active" : ""} aria-current={p.to === current ? "page" : undefined}>{t(p.key)}</NavLink>)}
              </div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}
