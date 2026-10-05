import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Session } from "@apisfactory/shared";
import { api, auth, get } from "../lib/api";
import { ErrorNotice, Loading, PageHeader } from "../lib/ui";

/**
 * R39: hazır akışlarla hızlı şirket kurulumu — kendi kendine (self-serve) yeni şirket + ilk
 * yönetici hesabı. Bu form giriş ekranından ("Yeni şirket oluştur") açılır; gerçek bir
 * `POST /api/setup/company` çağrısı yapar (mock değil), başarılı olunca otomatik oturum açar.
 */
export function CompanySetupPage({ onCancel }: { onCancel: () => void }) {
  const [companyName, setCompanyName] = useState("");
  const [companyCode, setCompanyCode] = useState("");
  const [adminName, setAdminName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [founderDoesAll, setFounderDoesAll] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const s = await api<Session>("POST", "/api/setup/company", { companyName, companyCode, adminName, adminEmail, adminPassword, founderDoesAll });
      auth.set({ session: s, companyId: s.companies[0]!.id });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <h2>Yeni şirket kurulumu</h2>
        <div className="muted" style={{ marginBottom: 8 }}>
          Hazır departman, rol ve iş merkezi şablonuyla saniyeler içinde başlayın. Şirketiniz 30 günlük deneme paketiyle başlar.
        </div>
        <ErrorNotice error={error} />
        <label className="field">
          Şirket adı
          <input required minLength={2} value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
        </label>
        <label className="field">
          Şirket kodu
          <input required minLength={2} maxLength={20} placeholder="ör. ACME-1" value={companyCode} onChange={(e) => setCompanyCode(e.target.value)} />
          <span className="muted">2-20 karakter, harf/rakam/tire — sonradan değiştirilemez.</span>
        </label>
        <label className="field">
          Adınız
          <input required minLength={2} value={adminName} onChange={(e) => setAdminName(e.target.value)} />
        </label>
        <label className="field">
          E-posta
          <input type="email" autoComplete="username" required value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} />
        </label>
        <label className="field">
          Parola
          <input type="password" autoComplete="new-password" required minLength={10} value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} />
          <span className="muted">En az 10 karakter.</span>
        </label>
        <label className="row" style={{ alignItems: "flex-start", flexWrap: "nowrap", gap: 8 }}>
          <input type="checkbox" style={{ minHeight: 0, width: "auto", flex: "none", marginTop: 3 }} checked={founderDoesAll} onChange={(e) => setFounderDoesAll(e.target.checked)} />
          <span>
            Tüm işleri ben yapıyorum
            <span className="muted" style={{ display: "block" }}>
              Ar-Ge, satın alma, depo, üretim, kalite, satış ve muhasebe rolleri de size verilir. Ekibiniz varsa işareti kaldırın;
              rolleri Kullanıcılar & roller ekranından dağıtırsınız.
            </span>
          </span>
        </label>
        <button className="primary" disabled={busy}>{busy ? "Kuruluyor…" : "Şirketi oluştur"}</button>
        <button type="button" onClick={onCancel} disabled={busy}>Zaten hesabım var — giriş yap</button>
      </form>
    </div>
  );
}

type SetupStatus = {
  companyCreated: boolean;
  teamInvited: boolean;
  memberCount: number;
  departmentCount: number;
  dataImported: boolean;
  importCount: number;
  firstProductCreated: boolean;
  productCount: number;
  firstWorkOrderCreated: boolean;
};

function Step({ done, title, detail, to }: { done: boolean; title: string; detail: string; to: string }) {
  return (
    <a href={`#${to}`} className="card" style={{ display: "block", marginBottom: 8, textDecoration: "none", color: "inherit" }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <strong>{title}</strong>
        <span className={`badge ${done ? "ok" : ""}`}>{done ? "Tamamlandı" : "Bekliyor"}</span>
      </div>
      <div className="muted">{detail}</div>
    </a>
  );
}

/**
 * §25 "Başlangıç" ekran grubu — şirket kurulumu (yukarıdaki form), kullanıcı daveti, birimler/roller,
 * veri yükleme, ilk üretim rehberi. Kurulum sonrası buraya iniliyor; her adım gerçek ilerlemeyi
 * (uydurma değil, `GET /api/setup/status`'tan) gösterip ilgili mevcut ekrana yönlendirir — hiçbiri
 * yeniden icat edilmedi (/admin, /imports, /products, /help zaten var).
 */
export function OnboardingPage() {
  const q = useQuery({ queryKey: ["setup-status"], queryFn: () => get<SetupStatus>("/api/setup/status") });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNotice error={q.error} />;
  const s = q.data!;
  return (
    <>
      <PageHeader title="Başlangıç" sub="Şirketiniz hazır şablonla kuruldu — kalan adımlarla hızlıca çalışır hale getirin." />
      <Step done title="Şirket kurulumu" detail={`${s.departmentCount} varsayılan departman, roller ve iş merkezleri hazır şablonla oluşturuldu.`} to="/admin" />
      <Step done={s.teamInvited} title="Ekibinizi davet edin" detail={`${s.memberCount} üye. Roller ve izinler /admin ekranından yönetilir.`} to="/admin" />
      <Step done={s.dataImported} title="Veri yükleyin" detail={`${s.importCount} içe aktarma tamamlandı. BOM, stok, müşteri/tedarikçi ana verisi /imports'tan yüklenir.`} to="/imports" />
      <Step done={s.firstProductCreated} title="İlk ürününüzü oluşturun" detail={`${s.productCount} ürün. Ar-Ge & BOM ekranından başlayın.`} to="/products" />
      <Step done={s.firstWorkOrderCreated} title="İlk üretim rehberi" detail="Rol bazlı görev rehberleri, yetki matrisi ve canlı geçiş kontrol listesi." to="/help" />
    </>
  );
}
