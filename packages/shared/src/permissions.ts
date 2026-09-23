/**
 * İzin kodları. Görüntüleme, oluşturma, onay, yayımlama, import/export ayrı izinlerdir (prompt §5).
 * Alan izinleri (`field.*`) maliyet/fiyat gibi hassas alanların API yanıtından çıkarılmasını belirler.
 */
export const PERMISSIONS = [
  // Ürün ve Ar-Ge
  "product.view",
  "product.create",
  "product.approve.rd",
  "product.approve.production",
  "product.approve.quality",
  "bom.view",
  "bom.import",
  "bom.publish",
  // Depo ve kalite
  "inventory.view",
  "inventory.receive",
  "inventory.import",
  "quality.incoming.decide",
  // Satış ve sevkiyat
  "sales.view",
  "sales.create",
  "sales.confirm",
  "sales.cancel",
  "shipment.view",
  "shipment.create",
  "shipment.deliver",
  "customer.address.manage",
  // Üretim ve son kalite
  "production.view",
  "production.plan",
  "production.execute",
  "production.test.record",
  "quality.final.release",
  "inventory.issue",
  "quality.plan.manage",
  "equipment.manage",
  "capacity.manage",
  // Mühendislik değişikliği
  "change.view",
  "change.create",
  "change.decide",
  "sales.promise",
  // Satın alma
  "purchase.view",
  "purchase.request.approve",
  // Genel
  "task.view",
  "audit.view",
  "export.run",
  // Yönetim (teknik yönetici). İş kararlarını KAPSAMAZ.
  "admin.users",
  "admin.roles",
  // Alan izinleri
  "field.cost.view",
  "field.price.view",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export type RoleCode =
  | "admin"
  | "manager"
  | "rd"
  | "production"
  | "technician"
  | "quality"
  | "warehouse"
  | "sales"
  | "purchasing"
  | "accounting";

/**
 * Varsayılan rol şablonları. Şirket bunları kopyalayıp düzenleyebilir.
 * Kural: teknik sistem yöneticisi ("admin") iş kararlarını otomatik onaylayamaz (prompt §5).
 */
export const DEFAULT_ROLES: Record<RoleCode, { name: { tr: string; en: string }; permissions: Permission[] }> = {
  admin: {
    name: { tr: "Sistem yöneticisi", en: "System administrator" },
    permissions: ["admin.users", "admin.roles", "audit.view", "task.view"],
  },
  manager: {
    name: { tr: "Yönetici", en: "Manager" },
    permissions: [
      "product.view", "bom.view", "inventory.view", "sales.view", "purchase.view", "production.view", "shipment.view",
      "task.view", "audit.view", "export.run", "field.cost.view", "field.price.view", "change.view",
    ],
  },
  rd: {
    name: { tr: "Ar-Ge", en: "R&D" },
    permissions: [
      "product.view", "product.create", "product.approve.rd", "bom.view", "bom.import", "bom.publish",
      "inventory.view", "purchase.view", "task.view", "field.cost.view",
      "quality.plan.manage", "change.view", "change.create", "change.decide",
    ],
  },
  production: {
    name: { tr: "Üretim sorumlusu", en: "Production lead" },
    permissions: ["product.view", "product.approve.production", "bom.view", "inventory.view", "sales.view", "purchase.view", "task.view", "production.view", "production.plan", "production.execute", "change.view", "change.create", "capacity.manage"],
  },
  technician: {
    name: { tr: "Teknisyen / operatör", en: "Technician / operator" },
    // Ticari ve mali alanlar varsayılan kapalı.
    permissions: ["product.view", "bom.view", "inventory.view", "task.view", "production.view", "production.execute", "production.test.record", "change.view", "change.create"],
  },
  quality: {
    name: { tr: "Kalite", en: "Quality" },
    permissions: ["product.view", "product.approve.quality", "bom.view", "inventory.view", "quality.incoming.decide", "task.view", "production.view", "production.test.record", "quality.final.release", "quality.plan.manage", "equipment.manage", "change.view", "change.create"],
  },
  warehouse: {
    name: { tr: "Depo", en: "Warehouse" },
    permissions: ["product.view", "inventory.view", "inventory.receive", "inventory.import", "task.view", "production.view", "inventory.issue", "sales.view", "shipment.create", "shipment.view", "shipment.deliver"],
  },
  sales: {
    name: { tr: "Satış", en: "Sales" },
    permissions: ["product.view", "inventory.view", "sales.view", "sales.create", "sales.confirm", "sales.cancel", "shipment.view", "task.view", "field.price.view", "sales.promise", "customer.address.manage", "shipment.deliver"],
  },
  purchasing: {
    name: { tr: "Satın alma", en: "Purchasing" },
    permissions: ["product.view", "bom.view", "inventory.view", "purchase.view", "purchase.request.approve", "task.view", "field.cost.view"],
  },
  accounting: {
    name: { tr: "Muhasebe", en: "Accounting" },
    permissions: ["product.view", "sales.view", "purchase.view", "task.view", "export.run", "field.cost.view", "field.price.view"],
  },
};
