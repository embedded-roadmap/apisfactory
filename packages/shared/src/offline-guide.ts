/**
 * R46 — Yedek, geri yükleme ve kesintide talimat erişimi (W37 §28: "Kesintide yayımlanmış talimat ve
 * atanmış iş listesinin kontrollü çevrimdışı kopyası kullanılabilsin"). Rol rehberleri ve destek
 * politikası tek bir yerde tanımlanır — hem `/help` sayfası hem de `GET /api/offline/snapshot`
 * (indirilebilir çevrimdışı kopya) buradan okur; iki ayrı kopya birbirinden sapmasın diye.
 */

export type RoleGuide = { role: string; tasks: string[] };

export const ROLE_GUIDES: RoleGuide[] = [
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

export const IMPORT_EXPORT_NOTES: string[] = [
  "Tüm içe aktarımlar aynı üç adımı izler: dosya seç → kolon eşleştir → sunucu önizlemesi (hatalı satırlar burada görünür) → onayla.",
  "BOM ve açılış stoğu içe aktarımı gerçek hareket/kayıt oluşturur; aynı dosya aynı hedefe iki kez işlenemez.",
  "Müşteri/tedarikçi içe aktarımı ana veri güncellemesidir (upsert): kod eşleşirse günceller, yoksa yeni kayıt açar — hiçbir hareket/sipariş etkilenmez.",
  '"İçe aktarım" sayfasındaki "Geçmiş işler" tablosu her onaylanan iş için kaynak-hedef uzlaşmasını gösterir (kaynak satır sayısı = hedefte oluşan kayıt sayısı olmalı); uyuşmazlık kırmızı rozetle işaretlenir.',
  "Dışa aktarım: yetkiniz varsa (`export.run`) stok/liste ekranlarında CSV indirme düğmesi görünür.",
];

export type SupportPolicyRow = { level: string; desc: string; owner: string; escalation: string };

export const SUPPORT_POLICY: SupportPolicyRow[] = [
  { level: "Kritik", desc: "Üretim/sevkiyat durdu, veri kaybı riski, şirket izolasyonu şüphesi", owner: "Teknik lider", escalation: "Anında — sorumlu bulunamazsa yönetici" },
  { level: "Yüksek", desc: "Bir modül tamamen kullanılamıyor, yanlış hesaplama şüphesi (maliyet, stok, kalite)", owner: "İlgili modülün sahibi (bkz. iş paketi tablosu)", escalation: "Aynı iş günü içinde teknik lidere" },
  { level: "Normal", desc: "Tekil kullanıcı sorunu, arayüz sorusu, veri düzeltme talebi", owner: "Rol sahibinin yöneticisi veya ürün sahibi", escalation: "Çözülmezse bir sonraki değerlendirmede" },
  { level: "İyileştirme", desc: "Yeni özellik/rapor talebi, kullanılabilirlik önerisi", owner: "Ürün sahibi", escalation: "İş paketi listesine eklenir, önceliklendirilir" },
];

/**
 * `GET /api/offline/snapshot` (R46) bu şekli döner — kullanıcının indirip saklayabileceği, kesintide
 * kullanılabilir kontrollü bir çevrimdışı kopya: yayımlanmış talimatlar (rol rehberi + destek
 * politikası) ve o an kullanıcıya atanmış açık görev listesi. Hiçbir alan uydurulmaz; `myTasks` gerçek
 * `tasks` tablosundan, anlık bir görünüm olarak okunur.
 */
export type OfflineTask = {
  id: string;
  title: string;
  status: string;
  kind: string;
  dueDate: string | null;
  overdue: boolean;
  entityType: string;
  entityId: string;
};

export type OfflineSnapshot = {
  generatedAt: string;
  company: { id: string; name: string; code: string };
  user: { id: string; name: string; roles: string[] };
  roleGuides: RoleGuide[];
  importExportNotes: string[];
  supportPolicy: SupportPolicyRow[];
  myTasks: OfflineTask[];
};
