# Mimari kararlar

## Genel yapı

Sınırları açık **modüler tek uygulama** (prompt §26). Erken aşamada mikroservis yok. Arka plan işleri ayrı süreçte (`apps/api/src/worker`).

```
apps/web (React)  ─┐
                   ├─ HTTPS/JSON ─> apps/api (Fastify) ─> PostgreSQL 16 (RLS)
apps/mobile (Expo)─┘                    │
                                        └─ outbox ─> worker (test bağlayıcısı)
packages/shared: tipler, izinler, durum makineleri, zod şemaları, TR/EN metinler
```

## Modül sorumlulukları ve veri sahipliği

| Modül | Dosya | Sahip olduğu tablolar |
|---|---|---|
| Kimlik ve yetki | `modules/auth.ts`, `http/context.ts` | users, sessions, memberships, roles, role_permissions, membership_roles |
| Ürün ve devir | `modules/products.ts` | items, products, product_revisions, handover_approvals, handover_rounds |
| BOM ve içe aktarım | `modules/imports.ts` | bom_versions, bom_lines, import_jobs |
| Stok ve kalite girişi | `modules/inventory.ts` | locations, lots, stock_moves, goods_receipts, goods_receipt_lines, inspections |
| Satış ve planlama | `modules/sales.ts` | customers, sales_orders, sales_order_lines, reservations, production_needs, purchase_allocations |
| Satın alma, görev, olay | `modules/work.ts` | purchase_requests, purchase_order_lines, tasks, events (okuma) |
| Ortak | `lib/records.ts` | events, outbox, idempotency_keys, counters |

## Temel kurallar ve nasıl uygulandıkları

| Kural | Uygulama |
|---|---|
| Şirket ayrımı | Tüm iş tablolarında `company_id` + PostgreSQL RLS (`FORCE`). Uygulama `apis_app` rolüyle bağlanır; her istek bir işlemde `app.company_id` ayarlar. Şirket kimliği üyelikten doğrulanır. |
| Değişmez geçmiş | `events` ve `stock_moves` tablolarında tetikleyici + UPDATE/DELETE yetkisi yok. Düzeltme yeni kayıtla. |
| Stok miktarı | Doğrudan düzenlenmez; `stock_balances` görünümü hareket defterinden türetir. Negatif bakiye tetikleyiciyle engellenir. |
| Kullanılabilirlik | Konum tipine bağlı: yalnızca `stock` ve `finished` kullanılabilir. Giriş kontrolü, karantina, fason sayılmaz. |
| Rezervasyon eşzamanlılığı | Kesinleştirmede ilgili kalem satırları `FOR UPDATE` ile sıralı kilitlenir (T03). |
| Tekrar koruması | `Idempotency-Key` başlığı + `idempotency_keys`; sipariş durumu kilidi; `production_needs` satır başına tekil; `purchase_requests` kaynak+kalem tekil. |
| Dış etkiler | Doğrudan çağrılmaz; `outbox`'a aynı işlemde yazılır. İşleyici bu fazda yalnızca test modunda. |
| Sayılar | numeric(18,6) veri tabanında; API'de string; hesaplar BigInt sabit hassasiyetle (`lib/decimal.ts`). |
| Durum geçişleri | Genel güncelleme uç noktası yok; her geçiş kendi uç noktasında ön koşul ve izinle. |
| Alan izinleri | `field.price.view` / `field.cost.view` yanıt oluşturulurken uygulanır. |

## Teknoloji seçimleri

- **Fastify 5 + TypeScript**, `pg` ile düz SQL: iş kurallarının SQL'de görünür ve test edilebilir kalması için ORM kullanılmadı.
- **PostgreSQL 16**: RLS, `FOR UPDATE`, kısıt tetikleyicileri.
- **React 19 + Vite + TanStack Query** (web), **Expo SDK 57 / React Native 0.86** (mobil). Tipler `packages/shared` üzerinden ortak.
- Sürümler kilit dosyasıyla sabitlenir (`pnpm-lock.yaml`). Expo modül sürümleri `expo/bundledNativeModules.json` ile uyumlu seçildi.

## Bilinçli olarak ertelenenler

Dosya/nesne depolama, arama, e-posta/bildirim, genel akış motoru, çevrimdışı kuyruk, MFA, yedekleme otomasyonu, gözlemlenebilirlik (metrik/izleme). Hepsi `docs/is-paketleri.md` içinde ilgili W kodlarıyla açık.
