import { DEFAULT_ROLES } from "@apisfactory/shared";
import { PageHeader } from "../lib/ui";

/**
 * W41 — Eğitim, yardım ve destek (kullanıcının devam talimatı §10). Eğitim tamamen ertelenmez: rol
 * bazlı görev odaklı kısa rehberler, yetki matrisi (gerçek rol tanımlarından üretilir, uydurulmaz),
 * içe/dışa aktarma ve AI önerisi inceleme yönergeleri, hatalı işlem düzeltme rehberi, destek talebi
 * politikası ve canlı geçiş kontrol listesi şimdiden hazırlanır. Pilot sonunda ekran görüntüleri ve
 * gerçek prosedürlerle güncellenecektir (devam talimatı §10) — bu sayfa o güncellemenin yerini alır.
 */

type RoleGuide = { role: string; tasks: string[] };

const ROLE_GUIDES: RoleGuide[] = [
  {
    role: "Satış",
    tasks: [
      '"Satış & Termin" sayfasından yeni sipariş oluşturun; kalem/miktar/istenen tarih girin.',
      "Sistem, stok ve açık üretime göre gerçekçi bir termin önerir; siparişi onaylamadan önce bu tahmini müşteriyle paylaşın.",
      "İptal edilen siparişte rezervasyon otomatik serbest kalır — elle stok düzeltmesi gerekmez.",
      '"İçe aktarım" sayfasından toplu müşteri listesi yükleyebilirsiniz (kod eşleşirse ad güncellenir).',
      "Yönetici raporunda (yetkiniz varsa) kendi bölgenizin tahsilat/gecikme durumunu izleyin.",
    ],
  },
  {
    role: "Muhasebe",
    tasks: [
      '"Borçlar & ödeme" ve "Alacaklar & tahsilat" sayfalarından fatura/ödeme kayıtlarını girin ve izleyin.',
      "E-fatura/e-arşiv bağlayıcısı şu an yalnızca TEST modundadır — gerçek gönderim için sağlayıcı seçimi ve API erişimi şirket kararına bağlıdır.",
      "Maliyet alanları (`field.cost.view`) yalnızca bu izne sahip rollere gösterilir; hassas fiyat/maliyet bilgisi diğer rollerden gizlidir.",
      "Dış hizmet (fason) ve iade tamiri maliyetleri iş emrine bağlıysa maliyete otomatik yansır; elle düzeltme gerekmez.",
    ],
  },
  {
    role: "Satın alma",
    tasks: [
      '"Satın alma" sayfasından talep → RFQ → sipariş akışını yürütün; tedarikçi teklif/karşı teklifleri sistemde tutulur.',
      "Sipariş onay limiti, gönderim aşamasında da kontrol edilir — limit üstü sipariş otomatik yükseltmeye düşer.",
      '"İçe aktarım" sayfasından toplu tedarikçi listesi yükleyebilirsiniz (kod eşleşirse ad/iletişim/teslim süresi güncellenir).',
      "Tedarikçi performansı (teslim gecikmesi, giriş kalite ret oranı) yönetici raporunda görünür.",
    ],
  },
  {
    role: "Üretim / Teknisyen",
    tasks: [
      '"Üretim" sayfasından iş emrini başlatın/tamamlayın; operasyon süresi otomatik biriktirilir (hızlı tıklanan operasyon uyarı olarak işaretlenir, süre uydurulmaz).',
      "Cihaz testinde ekipman zorunludur; hizmet dışı veya kalibrasyonu geçmiş ekipmanla test kaydı reddedilir.",
      "MSL'li (nem hassas) bir kalemin paketi açıldıysa kullanım süresi (floor life) başlar; süresi dolmadan kurutma (bake-out) çevrimi başlatıp tamamlayarak sayaç sıfırlanabilir — raf ömrü bundan etkilenmez.",
      "Test başarısız olursa cihaz otomatik yeniden işlemeye düşer; ilk geçiş başarısı (FPY) bu durumu korur, yükseltilmez.",
    ],
  },
  {
    role: "Ar-Ge",
    tasks: [
      '"Ar-Ge & BOM" sayfasından ürün/revizyon oluşturun; BOM\'u CSV olarak içe aktarabilir veya elle girebilirsiniz.',
      "BOM yalnızca taslaktan yayımlanabilir ve dizilecek en az bir satır gerektirir.",
      "Revizyon değişikliği bir değişiklik talebi (ECR) ile onaylanır; onaysız revizyon üretime geçmez.",
      "Onaylı alternatif kalemler, orijinali stokta yokken üretimde otomatik önerilir.",
    ],
  },
  {
    role: "Kalite",
    tasks: [
      '"Kalite & Ekipman" sayfasından ekipman/kalibrasyon kaydını, test planlarını ve kurutma (bake-out) reçetelerini yönetin.',
      "Giriş kalite kararı (kabul/ret/kısmi kabul) mal kabul akışını doğrudan etkiler.",
      "Kurutma reçetesi tanımlarken kaynak (üretici datasheet/prosedür referansı) zorunludur — sistem sıcaklık/süre değeri önermez, siz üreticinin belirttiği değeri girersiniz.",
      "Yönetici raporundaki bulguları inceleyip onay/red/erteleme kararı verebilirsiniz (yetkiniz varsa).",
    ],
  },
  {
    role: "Depo",
    tasks: [
      '"Depo & Lot" sayfasından mal kabul, lot/SKT girişi, paket açılışı ve FIFO/FEFO\'ya göre çıkış önerisini kullanın.',
      "Süresi geçmiş veya yakında dolacak lot seçilirse uyarı gösterilir; işlem engellenmez ama bilinçli seçim istenir.",
      '"İçe aktarım" sayfasından açılış stoğunu toplu yükleyin — miktar doğrudan yazılmaz, "opening" hareketi oluşur; aynı dosya iki kez işlenmez.',
      "Kurutma çevrimini başlatma/tamamlama üretim/teknisyen yetkisi gerektirir; depo yalnızca geçmişi görüntüler.",
    ],
  },
  {
    role: "Yönetici",
    tasks: [
      '"Yönetici raporu" sayfasından fire/kârlılık/tedarikçi/stok/kapasite/revizyon etkisi/tahsilat bulgularını inceleyin.',
      "Rapordaki sayısal bulgular her zaman gerçek verilerden kural tabanlı hesaplanır; bir AI/LLM sağlayıcısı bağlanmadıkça yorum katmanı \"kullanılamıyor\" olarak dürüstçe işaretlenir.",
      "Bir bulguyu onayladığınızda görev otomatik açılır; ölçen kişi kendi ölçümünü doğrulayamaz (bağımsız doğrulama zorunludur).",
      '"Görev & Plan" sayfasından ekip Gantt/kapasite görünümünü, "Akış & onay" sayfasından bekleyen onayları ve vekâletleri yönetin.',
    ],
  },
];

const IMPORT_EXPORT_NOTES = [
  "Tüm içe aktarımlar aynı üç adımı izler: dosya seç → kolon eşleştir → sunucu önizlemesi (hatalı satırlar burada görünür) → onayla.",
  "BOM ve açılış stoğu içe aktarımı gerçek hareket/kayıt oluşturur; aynı dosya aynı hedefe iki kez işlenemez.",
  "Müşteri/tedarikçi içe aktarımı ana veri güncellemesidir (upsert): kod eşleşirse günceller, yoksa yeni kayıt açar — hiçbir hareket/sipariş etkilenmez.",
  '"İçe aktarım" sayfasındaki "Geçmiş işler" tablosu her onaylanan iş için kaynak-hedef uzlaşmasını gösterir (kaynak satır sayısı = hedefte oluşan kayıt sayısı olmalı); uyuşmazlık kırmızı rozetle işaretlenir.',
  "Dışa aktarım: yetkiniz varsa (`export.run`) stok/liste ekranlarında CSV indirme düğmesi görünür.",
];

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

const SUPPORT_POLICY = [
  { level: "Kritik", desc: "Üretim/sevkiyat durdu, veri kaybı riski, şirket izolasyonu şüphesi", owner: "Teknik lider", escalation: "Anında — sorumlu bulunamazsa yönetici" },
  { level: "Yüksek", desc: "Bir modül tamamen kullanılamıyor, yanlış hesaplama şüphesi (maliyet, stok, kalite)", owner: "İlgili modülün sahibi (bkz. iş paketi tablosu)", escalation: "Aynı iş günü içinde teknik lidere" },
  { level: "Normal", desc: "Tekil kullanıcı sorunu, arayüz sorusu, veri düzeltme talebi", owner: "Rol sahibinin yöneticisi veya ürün sahibi", escalation: "Çözülmezse bir sonraki değerlendirmede" },
  { level: "İyileştirme", desc: "Yeni özellik/rapor talebi, kullanılabilirlik önerisi", owner: "Ürün sahibi", escalation: "İş paketi listesine eklenir, önceliklendirilir" },
];

export function HelpPage() {
  return (
    <>
      <PageHeader title="Yardım & eğitim" sub="Rol bazlı görev rehberleri, yetki matrisi, içe/dışa aktarma ve AI önerisi inceleme yönergeleri, destek politikası ve canlı geçiş kontrol listesi (W41)." />

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
