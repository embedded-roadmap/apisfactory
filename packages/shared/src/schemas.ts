import { z } from "zod";

/** Miktar ve para değerleri daima string ondalık olarak taşınır (kayan nokta yok). */
export const Decimal = z
  .string()
  .trim()
  .regex(/^-?\d+(\.\d+)?$/, "Geçerli bir ondalık sayı olmalı (ör. 12.5)");
export const PositiveDecimal = Decimal.refine((v) => Number(v) > 0, "Sıfırdan büyük olmalı");
export const Uuid = z.string().uuid();

export const LoginInput = z.object({ email: z.string().email(), password: z.string().min(8) });

export const CreateItemInput = z.object({
  code: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  kind: z.enum(["component", "product", "subassembly"]),
  manufacturer: z.string().max(120).optional(),
  mpn: z.string().max(120).optional(),
  unit: z.string().max(16).default("pcs"),
});

export const CreateProductInput = z.object({
  code: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
});

export const CreateRevisionInput = z.object({
  rev: z.string().min(1).max(16),
  bomVersionId: Uuid.optional(),
});

export const HandoverDecisionInput = z.object({
  area: z.enum(["rd", "production", "quality"]),
  decision: z.enum(["approve", "reject"]),
  note: z.string().max(2000).optional(),
});

export const BomColumnMapping = z.object({
  mpn: z.string(),
  manufacturer: z.string().optional(),
  qty: z.string(),
  refdes: z.string().optional(),
  description: z.string().optional(),
  dnp: z.string().optional(),
  internalCode: z.string().optional(),
});
export type BomColumnMapping = z.infer<typeof BomColumnMapping>;

export const BomImportPreviewInput = z.object({
  productId: Uuid,
  fileName: z.string().min(1),
  content: z.string().min(1).max(5_000_000),
  mapping: BomColumnMapping,
  decimalSeparator: z.enum([".", ","]).default("."),
});

export const StockImportPreviewInput = z.object({
  fileName: z.string().min(1),
  content: z.string().min(1).max(5_000_000),
  mapping: z.object({ itemCode: z.string(), qty: z.string(), lotNo: z.string(), locationCode: z.string(), rev: z.string().optional(), unitCost: z.string().optional() }),
  /** Birim maliyet sütunu eşlenirse para birimi (şirket varsayılanı). */
  currency: z.string().regex(/^[A-Z]{3}$/).default("TRY"),
  decimalSeparator: z.enum([".", ","]).default("."),
});

export const GoodsReceiptInput = z.object({
  supplierName: z.string().min(1).max(200),
  purchaseOrderLineId: Uuid.optional(),
  lines: z
    .array(
      z.object({
        itemId: Uuid,
        qty: PositiveDecimal,
        lotNo: z.string().min(1).max(80),
        dateCode: z.string().max(40).optional(),
        /** Tedarikçi birim fiyatı (maliyet yetkisi gerekir); geç gelen fatura ayrıca yeni kayıt olarak girilir. */
        unitCost: z.string().regex(/^\d+(\.\d{1,6})?$/).optional(),
        currency: z.string().regex(/^[A-Z]{3}$/).optional(),
      }),
    )
    .min(1),
});

export const InspectionInput = z.object({
  acceptedQty: Decimal,
  rejectedQty: Decimal,
  note: z.string().max(2000).optional(),
});

export const CreateCustomerInput = z.object({ code: z.string().min(1).max(64), name: z.string().min(1).max(200) });

export const CreateSalesOrderInput = z.object({
  customerId: Uuid,
  requestedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  lines: z
    .array(
      z.object({
        productRevisionId: Uuid,
        qty: PositiveDecimal,
        unitPrice: Decimal.optional(),
        currency: z.string().length(3).default("TRY"),
      }),
    )
    .min(1),
});

export const PurchaseRequestDecisionInput = z.object({
  decision: z.enum(["approve", "reject"]),
  note: z.string().max(2000).optional(),
});
