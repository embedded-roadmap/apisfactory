/** API yanıt tipleri: web ve mobil istemci aynı sözleşmeyi kullanır. */
import type { Permission } from "./permissions";
import type { LocationType, RevisionState, SalesOrderState } from "./states";

export type ApiError = { error: { code: string; message: string; details?: unknown } };

export type Session = {
  token: string;
  user: { id: string; email: string; name: string };
  companies: { id: string; name: string; code: string }[];
};

export type Me = {
  user: { id: string; email: string; name: string };
  company: { id: string; name: string; code: string };
  roles: string[];
  permissions: Permission[];
};

export type Item = {
  id: string;
  code: string;
  name: string;
  kind: "component" | "product" | "subassembly";
  manufacturer: string | null;
  mpn: string | null;
  unit: string;
};

export type ProductSummary = {
  id: string;
  code: string;
  name: string;
  itemId: string;
  revisions: { id: string; rev: string; status: RevisionState; bomVersionId: string | null }[];
};

export type HandoverApproval = { area: "rd" | "production" | "quality"; decision: "approve" | "reject"; by: string; at: string; note: string | null };

export type RevisionDetail = {
  id: string;
  productId: string;
  rev: string;
  status: RevisionState;
  bomVersionId: string | null;
  releasedAt: string | null;
  firmwareVersion?: string | null;
  firmwareSha256?: string | null;
  approvals: HandoverApproval[];
  missingApprovals: ("rd" | "production" | "quality")[];
};

export type BomLine = {
  id: string;
  lineNo: number;
  itemId: string;
  itemCode: string;
  manufacturer: string | null;
  mpn: string | null;
  description: string | null;
  qtyPer: string;
  refdes: string | null;
  dnp: boolean;
};

export type BomVersion = { id: string; productId: string; versionNo: number; status: "draft" | "published" | "archived"; lines: BomLine[] };

export type BomDiff = {
  added: BomLine[];
  removed: BomLine[];
  changed: { key: string; before: BomLine; after: BomLine; fields: ("qtyPer" | "mpn" | "dnp")[] }[];
};

export type ImportPreviewRow = {
  row: number;
  status: "ok" | "new_item" | "ambiguous" | "error";
  messages: string[];
  values: Record<string, string>;
};

export type ImportPreview = {
  jobId: string;
  fileHash: string;
  duplicateOf: string | null;
  rows: ImportPreviewRow[];
  summary: { total: number; ok: number; newItems: number; ambiguous: number; errors: number };
};

export type StockBalance = {
  itemId: string;
  itemCode: string;
  itemName: string;
  lotId: string;
  lotNo: string;
  locationId: string;
  locationCode: string;
  locationType: LocationType;
  qty: string;
};

export type ItemAvailability = {
  itemId: string;
  physical: string;
  usable: string;
  reserved: string;
  available: string;
  inspection: string;
  quarantine: string;
  subcontractor: string;
  openPurchase: string;
};

export type SalesOrder = {
  id: string;
  code: string;
  customerId: string;
  customerName: string;
  status: SalesOrderState;
  requestedDate: string;
  lines: { id: string; productRevisionId: string; productCode: string; rev: string; qty: string; unitPrice?: string | null; currency: string }[];
};

export type ConfirmResult = {
  orderId: string;
  status: SalesOrderState;
  alreadyConfirmed: boolean;
  lines: {
    lineId: string;
    reservedQty: string;
    productionNeedQty: string;
    materials: { itemId: string; itemCode: string; grossQty: string; reservedQty: string; openPurchaseQty: string; netQty: string; purchaseRequestId: string | null }[];
  }[];
};

export type Task = {
  id: string;
  title: string;
  status: "open" | "done";
  assigneeRole: string | null;
  entityType: string;
  entityId: string;
  createdAt: string;
};

export type BusinessEvent = {
  id: string;
  entityType: string;
  entityId: string;
  eventType: string;
  actorName: string | null;
  actorKind: "human" | "import" | "api" | "automation";
  reason: string | null;
  before: unknown;
  after: unknown;
  correlationId: string | null;
  createdAt: string;
};
