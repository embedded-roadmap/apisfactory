# apisfactory

Elektronik ürün geliştiren ve üreten şirketler için çok şirketli üretim platformu (B2B SaaS).
Kapsamın tamamı `docs/apisfactory_Ana_Gelistirme_Promptu.md` dosyasındadır; bu depo **F0/F1 temeli + ilk dikey iş akışını** içerir.
Gerçekte ne çalıştığı ve ne kaldığı `docs/devam-notu.md` ve `docs/kapsam-izleme.md` dosyalarında yazılıdır.

## Yapı

| Klasör | İçerik |
|---|---|
| `apps/api` | Fastify + TypeScript API, PostgreSQL migration'ları, kabul testleri |
| `apps/web` | Masaüstü web uygulaması (React + Vite) |
| `apps/mobile` | Mobil uygulama (Expo / React Native): işlerim, barkodlu mal kabul, giriş kalite, stok sorgu |
| `packages/shared` | Ortak tipler, izinler, durum makineleri, doğrulama şemaları, TR/EN metinler |
| `docs` | Kapsam izleme, iş paketleri, kabul testleri, mimari, kararlar, devam notu |

## Gereksinimler

- Node.js 22+, pnpm 10 (`corepack enable`)
- PostgreSQL 16 (yerelde veya `docker compose up -d db`)

## Kurulum

```bash
pnpm install

# Veri tabanı (Docker ile):
docker compose up -d db
# Docker yoksa: scripts/db-init.sql içindeki rol ve veri tabanlarını postgres kullanıcısıyla oluşturun.

cp apps/api/.env.example apps/api/.env      # JWT_SECRET'i değiştirin
pnpm db:migrate                             # şemayı kurar (apis_owner)
pnpm db:seed                                # DEMO şirketi ve kullanıcıları
```

## Çalıştırma

```bash
pnpm dev:api          # http://localhost:4000
pnpm dev:web          # http://localhost:5173  (API'ye /api vekili)
pnpm dev:mobile       # Expo; telefonda Expo Go ile QR okutun
```

Mobil uygulamada giriş ekranındaki **Sunucu adresi** alanına bilgisayarınızın yerel ağ IP'sini yazın (ör. `http://192.168.1.20:4000`).
API'yi `CORS_ORIGIN` ve güvenlik duvarı izinleriyle yerel ağa açmanız gerekir. Kamera ile barkod okuma Expo Go'da çalışır.

### Demo kullanıcılar (parola `demo1234!`)

| E-posta | Rol |
|---|---|
| `arge@demo.apisfactory.com` | Ar-Ge |
| `uretim@demo.apisfactory.com` | Üretim sorumlusu |
| `kalite@demo.apisfactory.com` | Kalite |
| `depo@demo.apisfactory.com` | Depo |
| `satis@demo.apisfactory.com` | Satış |
| `satinalma@demo.apisfactory.com` | Satın alma |
| `muhasebe@demo.apisfactory.com` | Muhasebe |
| `teknisyen@demo.apisfactory.com` | Teknisyen |
| `yonetici@demo.apisfactory.com` | Yönetici |
| `admin@demo.apisfactory.com` | Sistem yöneticisi (iş kararı veremez) |
| `yonetici@ikinci.demo.apisfactory.com` | İkinci DEMO şirket (izolasyon kontrolü) |

Demo verisi sentetiktir ve **DEMO** olarak işaretlidir; parça kodları gerçek MPN değildir.

## Uçtan uca deneme akışı

1. **Ar-Ge** ile giriş → Ar-Ge & BOM → ürün oluştur → *BOM içe aktar* (CSV; `docs/ornek/bom.csv`) → yayımla → Rev.A aç → *Devre gönder* → Ar-Ge onayı.
2. **Üretim** ve **Kalite** kullanıcılarıyla devir onayı → revizyon *Yayımlandı* olur.
3. **Depo** ile İçe aktarım → `docs/ornek/acilis-stok.csv` → Mal kabul ile yeni lot kabul et.
   Bitmiş ürün stoğu için dosyaya revizyonla bir satır ekleyin (ör. `SENS-200,300,FG-001,BTM,A`); revizyonsuz bitmiş ürün satışa uygun sayılmaz.
4. **Kalite** ile Mal kabul → *Karar ver* (ör. 70 kabul / 30 ret) → kabul edilen kullanılabilir, reddedilen karantinada.
5. **Satış** ile sipariş taslağı (1000 adet) → uygunluk önizlemesi → *Kesinleştir* → rezervasyon, üretim ihtiyacı ve net satın alma talepleri oluşur.
6. **Satın alma** ile talepleri onayla/reddet. Tedarikçiye gönderim bu fazda **bağlı değildir**.

## Test

```bash
# PostgreSQL'de apisfactory_test veri tabanı olmalı (scripts/db-init.sql)
pnpm test          # 16 kabul testi: T01, T02, T03, T04, T05, T13, T18 ve ek kurallar
pnpm typecheck
```

## Güvenlik notları

- Şirket ayrımı PostgreSQL satır seviyesi güvenlikle (RLS) uygulanır; API her istekte üyeliği veri tabanından doğrular.
- Uygulama `apis_app` rolüyle bağlanır; olay defteri ve stok hareketlerinde UPDATE/DELETE yetkisi yoktur.
- `.env` dosyasını depoya koymayın. Üretimde `JWT_SECRET` en az 32 karakter rastgele olmalı.
- Demo parolaları yalnızca yerel geliştirme içindir.
