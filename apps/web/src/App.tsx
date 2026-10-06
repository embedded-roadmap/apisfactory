import { lazy, Suspense, useState, useSyncExternalStore, type ComponentType, type FormEvent } from "react";
import { Link, NavLink, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Locale, Me, Permission, Session } from "@apisfactory/shared";
import { api, auth, get, post } from "./lib/api";
import { ErrorNotice, Loading, MeContext, useT } from "./lib/ui";
import { CompanySetupPage, OnboardingPage } from "./pages/Setup";
import { OfflinePage } from "./pages/Offline";

/**
 * Sayfalar rota bazında ayrı parçalara bölünür (ilk açılışta tek büyük paket yerine yalnız gereken sayfa indirilir).
 * İstisnalar ana pakette kalır: OfflinePage (bağlantı yokken açılabilmeli — ayrı parça ağsız indirilemez) ve
 * CompanySetupPage (giriş ekranında, oturum öncesi).
 */
function lazyNamed<M extends Record<string, unknown>, K extends keyof M>(load: () => Promise<M>, name: K) {
  return lazy(() => load().then((m) => ({ default: m[name] as ComponentType<any> })));
}
const TodayPage = lazyNamed(() => import("./pages/Today"), "TodayPage");
const ProductsPage = lazyNamed(() => import("./pages/Products"), "ProductsPage");
const ProductDetailPage = lazyNamed(() => import("./pages/Products"), "ProductDetailPage");
const BomImportPage = lazyNamed(() => import("./pages/BomImport"), "BomImportPage");
const InventoryPage = lazyNamed(() => import("./pages/Inventory"), "InventoryPage");
const ReceivingPage = lazyNamed(() => import("./pages/Receiving"), "ReceivingPage");
const SalesPage = lazyNamed(() => import("./pages/Sales"), "SalesPage");
const SalesOrderPage = lazyNamed(() => import("./pages/Sales"), "SalesOrderPage");
const PurchasingPage = lazyNamed(() => import("./pages/Purchasing"), "PurchasingPage");
const ImportsPage = lazyNamed(() => import("./pages/Imports"), "ImportsPage");
const ConnectorsStatusPage = lazyNamed(() => import("./pages/Events"), "ConnectorsStatusPage");
const EventsPage = lazyNamed(() => import("./pages/Events"), "EventsPage");
const ProductionPage = lazyNamed(() => import("./pages/Production"), "ProductionPage");
const WorkOrderPage = lazyNamed(() => import("./pages/Production"), "WorkOrderPage");
const AdminPage = lazyNamed(() => import("./pages/Admin"), "AdminPage");
const PasswordPage = lazyNamed(() => import("./pages/Admin"), "PasswordPage");
const QualityPage = lazyNamed(() => import("./pages/Quality"), "QualityPage");
const StationPage = lazyNamed(() => import("./pages/Station"), "StationPage");
const RoutingPage = lazyNamed(() => import("./pages/Routing"), "RoutingPage");
const MeetingPage = lazyNamed(() => import("./pages/Meetings"), "MeetingPage");
const MeetingsPage = lazyNamed(() => import("./pages/Meetings"), "MeetingsPage");
const ChannelPage = lazyNamed(() => import("./pages/Channels"), "ChannelPage");
const ChannelsPage = lazyNamed(() => import("./pages/Channels"), "ChannelsPage");
const DirectMessagesPage = lazyNamed(() => import("./pages/DirectMessages"), "DirectMessagesPage");
const DistributorsPage = lazyNamed(() => import("./pages/Distributors"), "DistributorsPage");
const SupplyRiskPage = lazyNamed(() => import("./pages/SupplyRisk"), "SupplyRiskPage");
const AlternatesPage = lazyNamed(() => import("./pages/Alternates"), "AlternatesPage");
const CustomerInvoicePage = lazyNamed(() => import("./pages/Receivables"), "CustomerInvoicePage");
const CustomerInvoicesPage = lazyNamed(() => import("./pages/Receivables"), "CustomerInvoicesPage");
const EinvoiceConnectorsPage = lazyNamed(() => import("./pages/Receivables"), "EinvoiceConnectorsPage");
const ReceivablesAgingPage = lazyNamed(() => import("./pages/Receivables"), "ReceivablesAgingPage");
const AgingPage = lazyNamed(() => import("./pages/Payables"), "AgingPage");
const ApPolicyPage = lazyNamed(() => import("./pages/Payables"), "ApPolicyPage");
const InvoicePage = lazyNamed(() => import("./pages/Payables"), "InvoicePage");
const InvoicesPage = lazyNamed(() => import("./pages/Payables"), "InvoicesPage");
const NewInvoicePage = lazyNamed(() => import("./pages/Payables"), "NewInvoicePage");
const SubscriptionPage = lazyNamed(() => import("./pages/Subscription"), "SubscriptionPage");
const FollowupsPage = lazyNamed(() => import("./pages/Procurement"), "FollowupsPage");
const PurchaseOrderPage = lazyNamed(() => import("./pages/Procurement"), "PurchaseOrderPage");
const PurchaseOrdersPage = lazyNamed(() => import("./pages/Procurement"), "PurchaseOrdersPage");
const RfqPage = lazyNamed(() => import("./pages/Procurement"), "RfqPage");
const RfqsPage = lazyNamed(() => import("./pages/Procurement"), "RfqsPage");
const SuppliersPage = lazyNamed(() => import("./pages/Procurement"), "SuppliersPage");
const GanttPage = lazyNamed(() => import("./pages/Planning"), "GanttPage");
const OrgPage = lazyNamed(() => import("./pages/Planning"), "OrgPage");
const PlanningPage = lazyNamed(() => import("./pages/Planning"), "PlanningPage");
const TaskPage = lazyNamed(() => import("./pages/Planning"), "TaskPage");
const TeamReportPage = lazyNamed(() => import("./pages/Planning"), "TeamReportPage");
const ExecutiveReportPage = lazyNamed(() => import("./pages/Reports"), "ExecutiveReportPage");
const ReportsPage = lazyNamed(() => import("./pages/Reports"), "ReportsPage");
const DevicePage = lazyNamed(() => import("./pages/Returns"), "DevicePage");
const ReturnPage = lazyNamed(() => import("./pages/Returns"), "ReturnPage");
const ReturnsPage = lazyNamed(() => import("./pages/Returns"), "ReturnsPage");
const CargoConnectorsPage = lazyNamed(() => import("./pages/Shipping"), "CargoConnectorsPage");
const ShipmentPage = lazyNamed(() => import("./pages/Shipping"), "ShipmentPage");
const ShipmentPrintPage = lazyNamed(() => import("./pages/Shipping"), "ShipmentPrintPage");
const ShipmentsPage = lazyNamed(() => import("./pages/Shipping"), "ShipmentsPage");
const ChangePage = lazyNamed(() => import("./pages/Changes"), "ChangePage");
const ChangesPage = lazyNamed(() => import("./pages/Changes"), "ChangesPage");
const DelegationsPage = lazyNamed(() => import("./pages/Workflow"), "DelegationsPage");
const WorkflowMonitorPage = lazyNamed(() => import("./pages/Workflow"), "WorkflowMonitorPage");
const WorkflowPage = lazyNamed(() => import("./pages/Workflow"), "WorkflowPage");
const EmailChannelPage = lazyNamed(() => import("./pages/EmailChannel"), "EmailChannelPage");
const SmsChannelPage = lazyNamed(() => import("./pages/SmsChannel"), "SmsChannelPage");
const ScenariosPage = lazyNamed(() => import("./pages/Scenarios"), "ScenariosPage");
const SubcontractJobsPage = lazyNamed(() => import("./pages/Subcontract"), "SubcontractJobsPage");
const HelpPage = lazyNamed(() => import("./pages/Help"), "HelpPage");
const RdProjectPage = lazyNamed(() => import("./pages/RdProjects"), "RdProjectPage");
const RdProjectsPage = lazyNamed(() => import("./pages/RdProjects"), "RdProjectsPage");

function useAuthState() {
  return useSyncExternalStore(auth.subscribe, auth.get);
}

export function App() {
  const { session, companyId } = useAuthState();
  const [locale, setLocale] = useState<Locale>("tr");
  const [showSetup, setShowSetup] = useState(false);
  if (!session) {
    return showSetup ? <CompanySetupPage onCancel={() => setShowSetup(false)} /> : <LoginPage onCreateCompany={() => setShowSetup(true)} />;
  }
  if (!companyId) return <CompanyPicker session={session} />;
  return <Shell locale={locale} setLocale={setLocale} />;
}

function LoginPage({ onCreateCompany }: { onCreateCompany: () => void }) {
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
        <button type="button" onClick={onCreateCompany}>Yeni şirket oluştur</button>
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
  { to: "/planning", key: "nav.planning", perm: "task.view" },
  { to: "/products", key: "nav.products", perm: "product.view" },
  { to: "/rd-projects", key: "nav.rdProjects", perm: "rd.project.view" },
  { to: "/inventory", key: "nav.inventory", perm: "inventory.view" },
  { to: "/receiving", key: "nav.receiving", perm: "inventory.view" },
  { to: "/production", key: "nav.production", perm: "production.view" },
  { to: "/quality", key: "nav.quality", perm: "production.view" },
  { to: "/changes", key: "nav.changes", perm: "change.view" },
  { to: "/sales", key: "nav.sales", perm: "sales.view" },
  { to: "/shipments", key: "nav.shipments", perm: "shipment.view" },
  { to: "/returns", key: "nav.returns", perm: "rma.view" },
  { to: "/devices", key: "nav.devices", perm: "production.view" },
  { to: "/purchasing", key: "nav.purchasing", perm: "purchase.view" },
  { to: "/receivables", key: "nav.receivables", perm: "receivable.view" },
  { to: "/payables", key: "nav.payables", perm: "invoice.view" },
  { to: "/subscription", key: "nav.subscription", perm: "subscription.view" },
  { to: "/imports", key: "nav.imports" },
  { to: "/reports", key: "nav.reports", perm: "report.view" },
  { to: "/reports/executive", key: "nav.reportsExecutive", perm: "report.view" },
  { to: "/scenarios", key: "nav.scenarios", perm: "report.view" },
  { to: "/subcontract-jobs", key: "nav.subcontractJobs", perm: "subcontract.manage" },
  { to: "/workflow", key: "nav.workflow", perm: "task.view" },
  { to: "/collaboration/channels", key: "nav.channels", perm: "task.view" },
  { to: "/collaboration/direct", key: "nav.direct", perm: "task.view" },
  { to: "/events", key: "nav.events", perm: "audit.view" },
  { to: "/admin", key: "nav.admin", perm: "admin.users" },
  { to: "/help", key: "nav.help" },
  { to: "/onboarding", key: "nav.onboarding" },
];

function Shell({ locale, setLocale }: { locale: Locale; setLocale: (l: Locale) => void }) {
  const t = useT();
  // Dar ekranda menü açılır liste (bot testi: telefonda 28 öğelik yatay şerit kullanılamıyordu).
  const [menuOpen, setMenuOpen] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();
  // Rol/yetki başka yöneticice değişebilir: sekmeye dönünce tazelenir (genel ayarda kapalı).
  const me = useQuery({ queryKey: ["me", auth.get().companyId], queryFn: () => get<Me>("/api/me"), refetchOnWindowFocus: true, staleTime: 30_000 });
  const companies = useQuery({ queryKey: ["companies"], queryFn: () => get<{ id: string; name: string; isDemo: boolean }[]>("/api/companies") });
  const current = companies.data?.find((c) => c.id === auth.get().companyId);

  async function logout() {
    await post("/api/auth/logout").catch(() => {});
    qc.clear();
    // Sonraki kişi öncekinin son sayfasında (ör. /admin) açılmasın — bot testi bulgusu.
    navigate("/", { replace: true });
    auth.clear();
  }
  if (me.isLoading) return <div className="content"><Loading /></div>;
  if (me.error) {
    // R46 (W37 §28): bağlantı kesikken bile atanmış iş listesine ve talimatlara erişilebilsin diye,
    // /offline yolu normal hata ekranını atlayıp yalnızca localStorage'daki kayıtlı kopyayı gösterir —
    // bu dal hiçbir ağ isteği yapmaz.
    if (window.location.pathname === "/offline") return <div className="content"><OfflinePage /></div>;
    return (
      <div className="content">
        <ErrorNotice error={me.error} />
        <p><Link to="/offline">Çevrimdışı kopyanızı görüntüleyin</Link> (bağlantı sorunuysa, daha önce kaydettiyseniz)</p>
        <button onClick={() => auth.clear()}>Tekrar giriş yap</button>
      </div>
    );
  }
  if (me.data!.mustChangePassword) {
    // Yöneticinin verdiği geçici parolayla girildi: API de başka isteğe izin vermez (password_change_required).
    return (
      <div className="content" style={{ maxWidth: 560, margin: "0 auto" }}>
        <Suspense fallback={<Loading />}><PasswordPage forced onChanged={() => qc.invalidateQueries({ queryKey: ["me"] })} /></Suspense>
        <button onClick={logout}>Çıkış</button>
      </div>
    );
  }
  const perms = new Set(me.data!.permissions);
  // Fason/dış kullanıcı: genel menü ve günlük iş akışı yerine yalnız kendisine atanan işler (prompt §19).
  const external = me.data!.roles.includes("subcontractor");

  return (
    <MeContext.Provider value={{ me: me.data!, locale, setLocale }}>
      <div className="shell">
        <nav id="main-nav" className={`side${menuOpen ? " open" : ""}`} aria-label="Ana menü"
          onClick={(e) => { if ((e.target as HTMLElement).closest("a")) setMenuOpen(false); }}>
          <div className="brand">
            <Logo /> apis<span>factory</span>
            <button type="button" className="menu-close" aria-label="Menüyü kapat" onClick={() => setMenuOpen(false)}>✕</button>
          </div>
          {external ? <NavLink to="/" end>{t("nav.subcontractJobs")}</NavLink> : <NavItems perms={perms} />}
          <div className="spacer" />
        </nav>
        <div className="main">
          <header className="top">
            <div className="row">
              <button type="button" className="menu-toggle" aria-expanded={menuOpen} aria-controls="main-nav" onClick={() => setMenuOpen(!menuOpen)}>☰ Menü</button>
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
              <NavLink className="btn" to="/password">Parola</NavLink>
              <button onClick={logout}>Çıkış</button>
            </div>
          </header>
          <main className="content">
            <Suspense fallback={<Loading />}>
            <Routes>
              <Route path="/" element={external ? <SubcontractJobsPage /> : <TodayPage />} />
              <Route path="/subcontract-jobs" element={<SubcontractJobsPage />} />
              <Route path="/rd-projects" element={<RdProjectsPage />} />
              <Route path="/rd-projects/:id" element={<RdProjectPage />} />
              <Route path="/products" element={<ProductsPage />} />
              <Route path="/products/alternates" element={<AlternatesPage />} />
              <Route path="/products/:id" element={<ProductDetailPage />} />
              <Route path="/products/:id/bom-import" element={<BomImportPage />} />
              <Route path="/inventory" element={<InventoryPage />} />
              <Route path="/receiving" element={<ReceivingPage />} />
              <Route path="/sales" element={<SalesPage />} />
              <Route path="/sales/:id" element={<SalesOrderPage />} />
              <Route path="/purchasing" element={<PurchasingPage />} />
              <Route path="/purchasing/rfqs" element={<RfqsPage />} />
              <Route path="/purchasing/rfqs/:id" element={<RfqPage />} />
              <Route path="/purchasing/orders" element={<PurchaseOrdersPage />} />
              <Route path="/purchasing/orders/:id" element={<PurchaseOrderPage />} />
              <Route path="/purchasing/followups" element={<FollowupsPage />} />
              <Route path="/purchasing/suppliers" element={<SuppliersPage />} />
              <Route path="/purchasing/distributors" element={<DistributorsPage />} />
              <Route path="/purchasing/supply-risk" element={<SupplyRiskPage />} />
              <Route path="/receivables" element={<CustomerInvoicesPage />} />
              <Route path="/receivables/aging" element={<ReceivablesAgingPage />} />
              <Route path="/receivables/einvoice-connectors" element={<EinvoiceConnectorsPage />} />
              <Route path="/receivables/:id" element={<CustomerInvoicePage />} />
              <Route path="/payables" element={<InvoicesPage />} />
              <Route path="/subscription" element={<SubscriptionPage />} />
              <Route path="/payables/new" element={<NewInvoicePage />} />
              <Route path="/payables/aging" element={<AgingPage />} />
              <Route path="/payables/policy" element={<ApPolicyPage />} />
              <Route path="/payables/:id" element={<InvoicePage />} />
              <Route path="/imports" element={<ImportsPage />} />
              <Route path="/events" element={<EventsPage />} />
              <Route path="/events/connectors" element={<ConnectorsStatusPage />} />
              <Route path="/production" element={<ProductionPage />} />
              <Route path="/production/routings" element={<RoutingPage />} />
              <Route path="/production/:id" element={<WorkOrderPage />} />
              <Route path="/shipments" element={<ShipmentsPage />} />
              <Route path="/shipments/cargo-connectors" element={<CargoConnectorsPage />} />
              <Route path="/shipments/:id" element={<ShipmentPage />} />
              <Route path="/shipments/:id/print" element={<ShipmentPrintPage />} />
              <Route path="/returns" element={<ReturnsPage />} />
              <Route path="/returns/:id" element={<ReturnPage />} />
              <Route path="/devices" element={<DevicePage />} />
              <Route path="/devices/:serial" element={<DevicePage />} />
              <Route path="/reports" element={<ReportsPage />} />
              <Route path="/reports/executive" element={<ExecutiveReportPage />} />
              <Route path="/scenarios" element={<ScenariosPage />} />
              <Route path="/planning" element={<PlanningPage />} />
              <Route path="/planning/tasks/:id" element={<TaskPage />} />
              <Route path="/planning/gantt" element={<GanttPage />} />
              <Route path="/planning/meetings" element={<MeetingsPage />} />
              <Route path="/planning/meetings/:id" element={<MeetingPage />} />
              <Route path="/collaboration/channels" element={<ChannelsPage />} />
              <Route path="/collaboration/channels/:id" element={<ChannelPage />} />
              <Route path="/collaboration/direct" element={<DirectMessagesPage />} />
              <Route path="/collaboration/direct/:id" element={<DirectMessagesPage />} />
              <Route path="/planning/org" element={<OrgPage />} />
              <Route path="/planning/team" element={<TeamReportPage />} />
              <Route path="/quality" element={<QualityPage />} />
              <Route path="/quality/station" element={<StationPage />} />
              <Route path="/changes" element={<ChangesPage />} />
              <Route path="/changes/:id" element={<ChangePage />} />
              <Route path="/workflow" element={<WorkflowPage />} />
              <Route path="/workflow/delegations" element={<DelegationsPage />} />
              <Route path="/workflow/monitor" element={<WorkflowMonitorPage />} />
              <Route path="/workflow/email" element={<EmailChannelPage />} />
              <Route path="/workflow/sms" element={<SmsChannelPage />} />
              <Route path="/admin" element={<AdminPage />} />
              <Route path="/help" element={<HelpPage />} />
              <Route path="/onboarding" element={<OnboardingPage />} />
              <Route path="/offline" element={<OfflinePage />} />
              <Route path="/password" element={<PasswordPage />} />
              <Route path="*" element={<Navigate to="/" />} />
            </Routes>
            </Suspense>
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
