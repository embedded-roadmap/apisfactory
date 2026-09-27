import { useState } from "react";
import { Link } from "react-router-dom";
import { DEFAULT_ROLES, IMPORT_EXPORT_NOTES, ROLE_GUIDES, SUPPORT_POLICY, type OfflineSnapshot } from "@apisfactory/shared";
import { auth, get } from "../lib/api";
import { ErrorNotice, PageHeader } from "../lib/ui";
import { downloadOfflineSnapshot, readOfflineSnapshot, writeOfflineSnapshot } from "../lib/offline";

/**
 * W41 — Eğitim, yardım ve destek (kullanıcının devam talimatı §10). Eğitim tamamen ertelenmez: rol
 * bazlı görev odaklı kısa rehberler, yetki matrisi (gerçek rol tanımlarından üretilir, uydurulmaz),
 * içe/dışa aktarma ve AI önerisi inceleme yönergeleri, hatalı işlem düzeltme rehberi, destek talebi
 * politikası ve canlı geçiş kontrol listesi şimdiden hazırlanır. Pilot sonunda ekran görüntüleri ve
 * gerçek prosedürlerle güncellenecektir (devam talimatı §10) — bu sayfa o güncellemenin yerini alır.
 *
 * R46 (W37 §28): rol rehberleri ve destek politikası artık `@apisfactory/shared`'dan okunuyor — aynı
 * içerik `GET /api/offline/snapshot`'ın döndürdüğü çevrimdışı kopyayla birebir aynı kaynaktan gelir.
 */

const MISTAKE_FIXES = [
  "Yanlış açılış stoğu/BOM dosyası yüklendiyse: iş zaten onaylandıysa geri alınamaz — düzeltme satırlarını yeni bir dosyada hazırlayıp tekrar içe aktarın (upsert olmayan türlerde ek hareket olarak).",
  "Yanlış müşteri/tedarikçi kaydı: aynı kodu doğru bilgilerle tekrar içe aktarın veya ilgili sayfadan elle düzeltin — ana veri her zaman güncellenebilir.",
  "Yanlış satış siparişi: sipariş iptal edilebilir durumdaysa iptal edin (rezervasyon otomatik serbest kalır) ve doğrusunu yeniden oluşturun.",
  "Yanlış lot/SKT tarihi girildiyse: kalite/depo yetkisiyle aynı lotun tarih alanı tekrar düzenlenebilir.",
  "Yanlış ekipman/kalibrasyon kaydı: kalite yetkisiyle yeni bir kalibrasyon veya durum kaydı girin — geçmiş kayıt silinmez, üzerine yeni kayıt eklenir (denetim izi bozulmaz).",
  'Bir işlemi geri alma seçeneği arayüzde yoksa: değişikliği "işlem geçmişi" (audit log) üzerinden izleyin ve düzeltmeyi yeni, açık bir kayıtla yapın — geçmiş veri sessizce silinmez/değiştirilmez.',
];

const AI_REVIEW_GUIDE = [
  "Yönetici raporundaki her bulgu, gerçek sayılardan (fire, kârlılık, tedarikçi performansı, stok, kapasite, revizyon etkisi, tahsilat) kural tabanlı hesaplanır — bu bir AI yorumu değildir.",
  'Bir sağlayıcı (LLM) bağlanmadıkça "AI servisi bu oturumda yapılandırılmadı" notu görünür; hiçbir sayı veya neden uydurulmaz.',
  "Bir bulguyu incelerken: kanıtı (sayılar), olası nedeni/alternatifleri ve belirsizliği birlikte okuyun — sistem bir hipotezi asla \"kanıtlanmış neden\" olarak sunmaz.",
  "Onay/red/erteleme kararınızın gerekçesini girin; onaylarsanız hedef değer, ölçüm aralığı ve uygulama maliyeti kilitlenir, bir uygulama görevi açılır.",
  "Ölçüm sonrası: beklenen fayda ile gözlenen sonuç ayrı raporlanır (fark otomatik olarak tamamen AI'ya/karara atfedilmez — kur, ürün karması gibi diğer etkenler göz önünde tutulmalıdır).",
  "Ölçümü giren kişi kendi ölçümünü doğrulayamaz; bağımsız bir kişi doğrulamalı veya gerekçeyle yeniden açmalıdır.",
];

export function HelpPage() {
  const companyId = auth.get().companyId!;
  const cached = readOfflineSnapshot(companyId);
  const [savedAt, setSavedAt] = useState<string | null>(cached?.savedAt ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function makeOfflineCopy() {
    setBusy(true);
    setError(null);
    try {
      const snapshot = await get<OfflineSnapshot>("/api/offline/snapshot");
      const stored = writeOfflineSnapshot(companyId, snapshot);
      downloadOfflineSnapshot(snapshot);
      setSavedAt(stored.savedAt);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="Yardım & eğitim" sub="Rol bazlı görev rehberleri, yetki matrisi, içe/dışa aktarma ve AI önerisi inceleme yönergeleri, destek politikası ve canlı geçiş kontrol listesi (W41)." />

      <section className="card">
        <h2>Kesintide erişim — çevrimdışı kopya</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Rol rehberleri, destek politikası ve size atanmış açık görev listesinin anlık bir kopyasını indirin ve bu
          tarayıcıda saklayın (R46, W37 §28). Bağlantı kesildiğinde <code>/offline</code> sayfası bu kopyayı ağa hiç
          gitmeden gösterir. Kopya yalnızca indirildiği andaki gerçek veriyi yansıtır — otomatik güncellenmez.
        </p>
        <ErrorNotice error={error} />
        <div className="row">
          <button className="primary" onClick={makeOfflineCopy} disabled={busy}>{busy ? "Hazırlanıyor…" : "Çevrimdışı kopya indir ve sakla"}</button>
          <Link className="btn" to="/offline">Kayıtlı kopyayı görüntüle</Link>
        </div>
        {savedAt ? <p className="muted">Bu tarayıcıda saklanan son kopya: {new Date(savedAt).toLocaleString("tr-TR")}</p> : <p className="muted">Bu tarayıcıda henüz saklanmış bir kopya yok.</p>}
      </section>

      <section className="card">
        <h2>Rol bazlı görev rehberleri</h2>
        <p className="muted" style={{ marginTop: 0 }}>Her rehber, o rolün sistemde gerçekten yapabildiği işlemlere dayanır — henüz uygulanmamış bir özellik burada anlatılmaz.</p>
        <div className="grid2">
          {ROLE_GUIDES.map((g) => (
            <div key={g.role} className="card" style={{ margin: 0 }}>
              <h3 style={{ marginTop: 0 }}>{g.role}</h3>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {g.tasks.map((t, i) => <li key={i}>{t}</li>)}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>Örnek eğitim şirketi</h2>
        <p>
          Yeni kullanıcılar için canlı verilerle çalışmadan önce pratik yapılabilecek bir "DEMO" işaretli örnek şirket
          bulunur (rol başına bir demo kullanıcı — satış, muhasebe, satın alma, üretim, teknisyen, Ar-Ge, kalite, depo,
          yönetici, sistem yöneticisi). Bu şirkette yapılan işlemler gerçek sipariş/ödeme/sevkiyat tetiklemez; eğitim ve
          alıştırma için güvenlidir. Demo kullanıcı parolaları kalıcı üretim parolası değildir ve yalnızca eğitim ortamı
          içindir — canlı geçişte devre dışı bırakılmalıdır (bkz. aşağıdaki canlı geçiş kontrol listesi).
        </p>
      </section>

      <section className="card">
        <h2>Yetki matrisi</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Aşağıdaki tablo, sistemdeki varsayılan rol tanımlarından (kod değişmeden) doğrudan üretilir — elle uydurulmuş
          bir özet değildir. Bir şirket bu şablonları kopyalayıp kendi ihtiyacına göre düzenleyebilir.
        </p>
        <table>
          <thead><tr><th>Rol</th><th className="num">Yetki sayısı</th><th>Ayrıntı</th></tr></thead>
          <tbody>
            {Object.entries(DEFAULT_ROLES).map(([code, r]) => (
              <tr key={code}>
                <td>{r.name.tr} <span className="muted mono">({code})</span></td>
                <td className="num">{r.permissions.length}</td>
                <td>
                  {r.permissions.length ? (
                    <details>
                      <summary className="muted">Yetki kodlarını göster</summary>
                      <span className="mono muted">{r.permissions.join(", ")}</span>
                    </details>
                  ) : (
                    <span className="muted">Genel yetki yok — erişim yalnızca kendisine atanan kayıtlarla sınırlıdır (fason/dış kullanıcı)</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>İçe/dışa aktarma yönergeleri</h2>
        <ul>{IMPORT_EXPORT_NOTES.map((n, i) => <li key={i}>{n}</li>)}</ul>
      </section>

      <section className="card">
        <h2>Video/dosya kullanımı</h2>
        <p>
          Kanal ve kayıt mesajlarına fotoğraf/PDF gibi küçük dosyalar doğrudan, video ekleri ise önce yüklenip (ilerleme
          yüzdesiyle) sunucuda gerçek tür/süre doğrulaması yapıldıktan sonra mesaja iliştirilir. Süresi/türü doğrulanamayan
          veya bozuk bir dosya reddedilir — hiçbir süre/tür bilgisi uydurulmaz. Fason iş dosyalarında da aynı yükleme akışı
          kullanılır.
        </p>
      </section>

      <section className="card">
        <h2>AI önerisi nasıl incelenir</h2>
        <ul>{AI_REVIEW_GUIDE.map((n, i) => <li key={i}>{n}</li>)}</ul>
      </section>

      <section className="card">
        <h2>Hatalı işlem düzeltme rehberi</h2>
        <ul>{MISTAKE_FIXES.map((n, i) => <li key={i}>{n}</li>)}</ul>
      </section>

      <section className="card">
        <h2>Destek talebi politikası</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Aşağıdaki öncelik/sorumlu/eskalasyon tanımı bir dahili çalışma kuralıdır; sözleşmeyle taahhüt edilmiş bir yanıt
          süresi değildir.
        </p>
        <table>
          <thead><tr><th>Öncelik</th><th>Tanım</th><th>Sorumlu</th><th>Eskalasyon</th></tr></thead>
          <tbody>
            {SUPPORT_POLICY.map((s) => (
              <tr key={s.level}><td>{s.level}</td><td>{s.desc}</td><td>{s.owner}</td><td className="muted">{s.escalation}</td></tr>
            ))}
          </tbody>
        </table>
        <p className="muted">İletişim kanalı: şirket içi görev/iş paketi takibi üzerinden (bkz. "Görev & Plan"); acil kritik durumlarda doğrudan teknik lidere ulaşılır.</p>
      </section>

      <section className="card">
        <h2>Canlı geçiş kontrol listesi</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Nihai canlı geçiş kabulü, gerçek pilot ve kritik testler tamamlanmadan verilemez (devam talimatı §10) — bu liste
          hazırlık amaçlıdır, bir onay beyanı değildir.
        </p>
        <ul>
          <li>Veri uzlaşması: içe aktarılan kayıt/miktar/tutarların kaynakla eşleştiği "İçe aktarım" sayfasındaki uzlaşma göstergesiyle doğrulanmış mı?</li>
          <li>Kullanıcı/yetki kabulü: her rol kendi ekranlarında beklenen işlemleri gerçek verilerle deneyip onaylamış mı?</li>
          <li>Entegrasyon doğrulaması: bağlı dış sağlayıcılar (e-fatura, kargo, takvim, AI) TEST modundan sağlayıcı test ortamına geçmiş mi, yoksa dürüstçe "dış bağımlılık bekliyor" mu işaretli?</li>
          <li>Yedekten dönüş denemesi yapılmış ve sonucu kayıtlı mı?</li>
          <li>Eğitim: bu sayfadaki rol rehberleri ilgili ekiple birlikte gözden geçirilmiş mi?</li>
          <li>Sorumlu atamaları: destek talebi tablosundaki roller gerçek kişilere atanmış mı?</li>
          <li>İzleme: hata/performans izleme (varsa) canlı ortama bağlanmış mı?</li>
          <li>Geri dönüş kararı: bir sorun durumunda kimin, hangi eşikte geri alma kararı vereceği net mi?</li>
        </ul>
      </section>
    </>
  );
}
