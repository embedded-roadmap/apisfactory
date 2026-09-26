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
  "item.storage.manage",
  // Satış ve sevkiyat
  "sales.view",
  "sales.create",
  "sales.confirm",
  "sales.cancel",
  "shipment.view",
  "shipment.create",
  "shipment.deliver",
  "customer.address.manage",
  "rma.view",
  "rma.create",
  "rma.decide",
  "cost.manage",
  "lot.cost.record",
  "report.view",
  "task.manage",
  "org.manage",
  "team.report.view",
  "workflow.manage",
  "delegation.manage",
  "purchase.request.create",
  "subcontract.manage",
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
  "purchase.order.manage",
  "supplier.manage",
  // Borçlar (tedarikçi faturası)
  "invoice.view",
  "invoice.manage",
  "invoice.approve",
  "payment.record",
  // Alacaklar (müşteri faturası, tahsilat kaydı, kredi)
  "receivable.view",
  "receivable.manage",
  "credit.override",
  // Genel
  "task.view",
  "audit.view",
  "export.run",
  // Yönetici raporları ve stratejik AI önerileri (W30/W31)
  "report.suggestion.decide",
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
  | "accounting"
  | "subcontractor";

/**
 * Varsayılan rol şablonları. Şirket bunları kopyalayıp düzenleyebilir.
 * Kural: teknik sistem yöneticisi ("admin") iş kararlarını otomatik onaylayamaz (prompt §5).
 */
export const DEFAULT_ROLES: Record<RoleCode, { name: { tr: string; en: string }; permissions: Permission[] }> = {
  admin: {
    name: { tr: "Sistem yöneticisi", en: "System administrator" },
    permissions: ["admin.users", "admin.roles", "audit.view", "task.view", "org.manage", "delegation.manage"],
  },
  manager: {
    name: { tr: "Yönetici", en: "Manager" },
    permissions: [
      "product.view", "bom.view", "inventory.view", "sales.view", "purchase.view", "production.view", "shipment.view",
      "task.view", "audit.view", "export.run", "field.cost.view", "field.price.view", "change.view", "rma.view", "cost.manage", "report.view",
      "task.manage", "org.manage", "team.report.view", "workflow.manage", "delegation.manage", "purchase.request.approve", "purchase.order.manage", "invoice.view", "invoice.approve", "receivable.view", "credit.override",
      "report.suggestion.decide",
    ],
  },
  rd: {
    name: { tr: "Ar-Ge", en: "R&D" },
    permissions: [
      "product.view", "product.create", "product.approve.rd", "bom.view", "bom.import", "bom.publish",
      "inventory.view", "purchase.view", "task.view", "field.cost.view",
      "quality.plan.manage", "change.view", "change.create", "change.decide", "rma.view", "task.manage", "purchase.request.create",
    ],
  },
  production: {
    name: { tr: "Üretim sorumlusu", en: "Production lead" },
    permissions: ["product.view", "product.approve.production", "bom.view", "inventory.view", "sales.view", "purchase.view", "task.view", "production.view", "production.plan", "production.execute", "change.view", "change.create", "capacity.manage", "report.view", "task.manage", "purchase.request.create", "subcontract.manage"],
  },
  technician: {
    name: { tr: "Teknisyen / operatör", en: "Technician / operator" },
    // Ticari ve mali alanlar varsayılan kapalı.
    permissions: ["product.view", "bom.view", "inventory.view", "task.view", "production.view", "production.execute", "production.test.record", "change.view", "change.create", "rma.view"],
  },
  quality: {
    name: { tr: "Kalite", en: "Quality" },
    permissions: ["product.view", "product.approve.quality", "bom.view", "inventory.view", "quality.incoming.decide", "item.storage.manage", "task.view", "production.view", "production.test.record", "quality.final.release", "quality.plan.manage", "equipment.manage", "change.view", "change.create", "rma.view", "rma.create", "rma.decide", "report.view", "task.manage", "purchase.request.create"],
  },
  warehouse: {
    name: { tr: "Depo", en: "Warehouse" },
    permissions: ["product.view", "inventory.view", "inventory.receive", "inventory.import", "item.storage.manage", "task.view", "production.view", "inventory.issue", "sales.view", "shipment.create", "shipment.view", "shipment.deliver", "rma.view"],
  },
  sales: {
    name: { tr: "Satış", en: "Sales" },
    permissions: ["product.view", "inventory.view", "sales.view", "sales.create", "sales.confirm", "sales.cancel", "shipment.view", "task.view", "field.price.view", "sales.promise", "customer.address.manage", "shipment.deliver", "rma.view", "rma.create", "report.view", "receivable.view"],
  },
  purchasing: {
    name: { tr: "Satın alma", en: "Purchasing" },
    permissions: ["product.view", "bom.view", "inventory.view", "purchase.view", "purchase.request.approve", "task.view", "field.cost.view", "lot.cost.record", "purchase.request.create", "purchase.order.manage", "supplier.manage", "invoice.view", "subcontract.manage"],
  },
  accounting: {
    name: { tr: "Muhasebe", en: "Accounting" },
    permissions: ["product.view", "sales.view", "purchase.view", "task.view", "export.run", "field.cost.view", "field.price.view", "rma.view", "cost.manage", "lot.cost.record", "report.view", "invoice.view", "invoice.manage", "invoice.approve", "payment.record", "receivable.view", "receivable.manage", "credit.override"],
  },
  // Fason üretici / dış kullanıcı: yalnız kendisine atanmış işi görür; izin listesi kasten boştur —
  // erişim genel izinlerle değil, subcontract_jobs.subcontractor_user_id eşleşmesiyle denetlenir (prompt §19).
  subcontractor: {
    name: { tr: "Fason üretici (dış kullanıcı)", en: "Subcontractor (external user)" },
    permissions: [],
  },
};

/** Vekâlet verilebilen onay izinleri. Yönetim (admin.*) ve alan izinleri vekâletle devredilemez (prompt §5). */
export const DELEGABLE_PERMISSIONS: readonly Permission[] = [
  "purchase.request.approve", "change.decide", "quality.incoming.decide", "quality.final.release", "rma.decide",
  "product.approve.rd", "product.approve.production", "product.approve.quality", "sales.confirm",
  "report.suggestion.decide",
];

/** Sistem görevi türü → onu yapmaya yetki veren izin (vekilin görev listesinde göstermek için). */
export const TASK_KIND_PERMISSION: Record<string, Permission> = {
  purchase_request_review: "purchase.request.approve",
  change_decision: "change.decide",
  incoming_inspection: "quality.incoming.decide",
  device_disposition: "quality.final.release",
  rma_inspect: "rma.decide",
  // W30/W31: yönetici rapor bulgusu incelemesi ve öneri uygulaması.
  report_finding_review: "report.suggestion.decide",
  ai_suggestion_implementation: "report.suggestion.decide",
};

/** Onay politikası türleri ve süre ölçümü yapılan görev türleri. */
export const POLICY_TASK_KIND: Record<string, string> = {
  purchase_request_review: "purchase_request",
  change_decision: "change_request",
  rma_inspect: "rma_decision",
  incoming_inspection: "incoming_inspection",
  device_disposition: "device_disposition",
};
