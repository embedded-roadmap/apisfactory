import { useState, useSyncExternalStore, type FormEvent } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Locale, Me, Permission, Session } from "@apisfactory/shared";
import { api, auth, get, post } from "./lib/api";
import { ErrorNotice, Loading, MeContext, useT } from "./lib/ui";
import { TodayPage } from "./pages/Today";
import { ProductsPage, ProductDetailPage } from "./pages/Products";
import { BomImportPage } from "./pages/BomImport";
import { InventoryPage } from "./pages/Inventory";
import { ReceivingPage } from "./pages/Receiving";
import { SalesPage, SalesOrderPage } from "./pages/Sales";
import { PurchasingPage } from "./pages/Purchasing";
import { ImportsPage } from "./pages/Imports";
import { EventsPage } from "./pages/Events";

function useAuthState() {
  return useSyncExternalStore(auth.subscribe, auth.get);
}

export function App() {
  const { session, companyId } = useAuthState();
  const [locale, setLocale] = useState<Locale>("tr");
  if (!session) return <LoginPage />;
  if (!companyId) return <CompanyPicker session={session} />;
  return <Shell locale={locale} setLocale={setLocale} />;
}

function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const s = await api<Session>("POST", "/api/auth/login", { email, password });
      auth.set({ session: s, companyId: s.companies.length === 1 ? s.companies[0]!.id : null });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <div className="brand" style={{ color: "var(--text)", padding: 0 }}>
          <Logo /> apis<span>factory</span>
        </div>
        <h2>Giriş yap</h2>
        <ErrorNotice error={error} />
        <label className="field">
          E-posta
          <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          Parola
          <input type="password" autoComplete="current-password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <button className="primary" disabled={busy}>
          {busy ? "Giriş yapılıyor…" : "Giriş yap"}
        </button>
      </form>
    </div>
  );
}

function CompanyPicker({ session }: { session: Session }) {
  return (
    <div className="login">
      <div className="card">
        <h2>Şirket seçin</h2>
        {session.companies.length === 0 ? <div className="notice warn">Bu hesabın aktif şirket üyeliği yok.</div> : null}
        {session.companies.map((c) => (
          <button key={c.id} onClick={() => auth.set({ companyId: c.id })}>
            {c.name} <span className="mono muted">{c.code}</span>
          </button>
        ))}
        <button onClick={() => auth.clear()}>Çıkış</button>
      </div>
    </div>
  );
}

const NAV: { to: string; key: string; perm?: Permission }[] = [
  { to: "/", key: "nav.today", perm: "task.view" },
  { to: "/products", key: "nav.products", perm: "product.view" },
  { to: "/inventory", key: "nav.inventory", perm: "inventory.view" },
  { to: "/receiving", key: "nav.receiving", perm: "inventory.view" },
  { to: "/sales", key: "nav.sales", perm: "sales.view" },
  { to: "/purchasing", key: "nav.purchasing", perm: "purchase.view" },
  { to: "/imports", key: "nav.imports" },
  { to: "/events", key: "nav.events", perm: "audit.view" },
];

function Shell({ locale, setLocale }: { locale: Locale; setLocale: (l: Locale) => void }) {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ["me", auth.get().companyId], queryFn: () => get<Me>("/api/me") });
  const companies = useQuery({ queryKey: ["companies"], queryFn: () => get<{ id: string; name: string; isDemo: boolean }[]>("/api/companies") });
  const current = companies.data?.find((c) => c.id === auth.get().companyId);

  async function logout() {
    await post("/api/auth/logout").catch(() => {});
    qc.clear();
    auth.clear();
  }
  if (me.isLoading) return <div className="content"><Loading /></div>;
  if (me.error) return <div className="content"><ErrorNotice error={me.error} /><button onClick={() => auth.clear()}>Tekrar giriş yap</button></div>;
  const perms = new Set(me.data!.permissions);

  return (
    <MeContext.Provider value={{ me: me.data!, locale, setLocale }}>
      <div className="shell">
        <nav className="side" aria-label="Ana menü">
          <div className="brand">
            <Logo /> apis<span>factory</span>
          </div>
          <NavItems perms={perms} />
          <div className="spacer" />
        </nav>
        <div className="main">
          <header className="top">
            <div className="row">
              <strong>{me.data!.company.name}</strong>
              {current?.isDemo ? <span className="badge mode warn">DEMO</span> : null}
              {companies.data && companies.data.length > 1 ? (
                <select aria-label="Şirket" value={auth.get().companyId ?? ""} onChange={(e) => { qc.clear(); auth.set({ companyId: e.target.value }); }}>
                  {companies.data.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              ) : null}
            </div>
            <div className="row">
              <span className="muted">{me.data!.user.name} · {me.data!.roles.join(", ")}</span>
              <select aria-label="Dil" value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>
                <option value="tr">TR</option>
                <option value="en">EN</option>
              </select>
              <button onClick={logout}>Çıkış</button>
            </div>
          </header>
          <main className="content">
            <Routes>
              <Route path="/" element={<TodayPage />} />
              <Route path="/products" element={<ProductsPage />} />
              <Route path="/products/:id" element={<ProductDetailPage />} />
              <Route path="/products/:id/bom-import" element={<BomImportPage />} />
              <Route path="/inventory" element={<InventoryPage />} />
              <Route path="/receiving" element={<ReceivingPage />} />
              <Route path="/sales" element={<SalesPage />} />
              <Route path="/sales/:id" element={<SalesOrderPage />} />
              <Route path="/purchasing" element={<PurchasingPage />} />
              <Route path="/imports" element={<ImportsPage />} />
              <Route path="/events" element={<EventsPage />} />
              <Route path="*" element={<Navigate to="/" />} />
            </Routes>
          </main>
        </div>
      </div>
    </MeContext.Provider>
  );
}

function NavItems({ perms }: { perms: Set<string> }) {
  const t = useT();
  return (
    <>
      {NAV.filter((n) => !n.perm || perms.has(n.perm)).map((n) => (
        <NavLink key={n.to} to={n.to} end={n.to === "/"}>
          {t(n.key)}
        </NavLink>
      ))}
    </>
  );
}

export function Logo() {
  return (
    <svg width="26" height="29" viewBox="0 0 34 38" fill="none" aria-hidden="true">
      <path d="M17 1.5 32 10v18L17 36.5 2 28V10Z" stroke="#F5B301" strokeWidth="2.5" />
      <path d="M17 11.5 24.5 16v8L17 28.5 9.5 24v-8Z" fill="#F5B301" />
    </svg>
  );
}
