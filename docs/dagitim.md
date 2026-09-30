# Canlıya alma (dağıtım) rehberi

Mimari (oturum 41 kararı — "veri yurt içinde kalmalı"):

| Parça | Nerede | Ne |
|---|---|---|
| Web arayüzü | **Vercel** | Yalnız statik dosyalar (HTML/JS). Veri tutmaz. |
| API + kuyruk işçisi + PostgreSQL + dosyalar | **Türkiye'deki sunucu (VPS)** | Tüm veri burada. `deploy/docker-compose.prod.yml` |

Web arayüzü API'ye `VITE_API_URL` ile bağlanır; kimlik `Authorization` başlığıyla taşınır (çerez yok), API yalnız
`CORS_ORIGIN`'deki adrese izin verir.

## 1. Sunucu

- Türkiye'de bir veri merkezinde VPS (ör. Turkcell Bulut, Radore, Natro, Turhost…). Öneri: **Ubuntu 24.04, 2 vCPU, 4 GB RAM,
  40 GB SSD**, sabit genel IP.
- Güvenlik duvarı: yalnız **22 (SSH), 80, 443** açık. Veritabanı portu dışarı açılmaz (compose yayınlamaz).
- Bu sunucunun IP'si, IP izni isteyen sağlayıcılara (Verimor SMS, Yurtiçi test ortamı) bildirilecek IP'dir.

## 2. Alan adı (DNS)

- `api.<alanadınız>` → **A kaydı** → sunucunun IP'si.
- `app.<alanadınız>` → Vercel'in vereceği kayıt (Vercel → Domains ekranı söyler).

## 3. Sunucu kurulumu

```bash
# Docker (resmî kurulum betiği)
curl -fsSL https://get.docker.com | sh
sudo ufw allow 22 && sudo ufw allow 80 && sudo ufw allow 443 && sudo ufw enable

# Kod (özel depo: GitHub'da "Deploy key" veya salt-okunur erişim belirteci ile)
git clone https://github.com/embedded-roadmap/apisfactory.git && cd apisfactory/deploy
cp env.production.example .env
nano .env        # alanları doldurun; rastgele değerler için: openssl rand -hex 32
mkdir -p backups && sudo chown 1000:1000 backups

docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml ps       # db, api, worker, caddy "running"; migrate "exited (0)"
curl https://api.<alanadınız>/health                # {"ok":true}
```

`.env` ve içindeki sırlar (özellikle `CONNECTOR_SECRET_KEY`, `BACKUP_ENCRYPTION_KEY`) sohbete, e-postaya veya depoya
yazılmaz; sunucu dışında güvenli bir parola kasasında yedeklenir.

## 4. Vercel (web arayüzü)

1. Vercel → **Add New → Project** → GitHub'daki `apisfactory` deposunu seçin.
2. **Root Directory: `apps/web`** (kurulum/derleme komutları `apps/web/vercel.json`'dan gelir).
3. **Environment Variables:** `VITE_API_URL` = `https://api.<alanadınız>` (Production).
4. Deploy → ardından **Domains**'ten `app.<alanadınız>` ekleyin.
5. Sunucudaki `.env`'de `CORS_ORIGIN=https://app.<alanadınız>` olmalı; değiştirdiyseniz:
   `docker compose -f docker-compose.prod.yml up -d api`

## 5. İlk şirket ve kullanıcı

`https://app.<alanadınız>` → giriş ekranında **"Yeni şirket oluştur"**. Kurucu kullanıcı **admin + manager** rolüyle
açılır. Distribütör/kargo/e-belge erişim bilgisi girecek kişiye Yönetim ekranından ilgili rol verilir
(Satın alma → distribütör, Muhasebe → e-belge, Depo → kargo).

## 6. Yedek

```bash
docker compose -f docker-compose.prod.yml run --rm backup      # ./backups/apisfactory-backup-<zaman>.tar.gz.enc
```

Günlük cron örneği (`crontab -e`):
`0 3 * * * cd /root/apisfactory/deploy && docker compose -f docker-compose.prod.yml run --rm backup >> backups/cron.log 2>&1`

`./backups` dizinini **başka bir diske/sunucuya** kopyalayın (aynı sunucudaki yedek, sunucu kaybında işe yaramaz).
Geri yükleme: `apps/api/scripts/restore.mjs` (bkz. betik başındaki açıklama).

## 7. Güncelleme

```bash
cd apisfactory && git pull && cd deploy
docker compose -f docker-compose.prod.yml up -d --build     # migrate önce çalışır, sonra api/worker yeniden başlar
```

## Doğrulanmamış olanlar

- İmaj bu geliştirme ortamında **derlenmedi** (Docker Hub'a erişim yok); compose dosyası `docker compose config` ile
  doğrulandı, web `VITE_API_URL` ile derlendi. İlk kurulumda `docker compose ... logs -f` ile izleyin.
