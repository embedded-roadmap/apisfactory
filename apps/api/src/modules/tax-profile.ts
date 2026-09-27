import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { notFound } from "../lib/errors";
import { recordEvent } from "../lib/records";
import { isValidTaxNo } from "../lib/tax-id";
import { parse, tenant } from "../http/context";

/**
 * Vergi kimliği — e-fatura/e-arşivin sağlayıcıdan bağımsız ön koşulu (dış bağımlılık maddesi 1).
 * Satıcı (şirket) ve alıcı (müşteri) için VKN/TCKN, vergi dairesi, resmi unvan. VKN/TCKN kontrol hanesiyle doğrulanır.
 */

const taxNo = z.string().trim().refine(isValidTaxNo, "Geçersiz VKN (10 hane) veya TCKN (11 hane) — kontrol hanesi tutmuyor");
const text = (max: number) => z.string().trim().min(1).max(max);

const CompanyTaxProfile = z.object({
  legalName: text(200),
  taxNo,
  taxOffice: text(100),
  addressLine: text(300),
  district: text(100).nullable().optional(),
  city: text(100),
  postalCode: z.string().trim().regex(/^[0-9]{5}$/, "Posta kodu 5 hane olmalı").nullable().optional(),
  // Kargo göndericisi için (dış bağımlılık maddesi 2) — e-belge için zorunlu değil.
  phone: z.string().trim().regex(/^\+?[0-9 ()-]{7,20}$/, "Geçersiz telefon").nullable().optional(),
});

const CustomerTaxIdentity = z.object({
  legalName: text(200),
  taxNo,
  taxOffice: text(100).nullable().optional(),
});

const companyCols = `legal_name as "legalName", tax_no as "taxNo", tax_office as "taxOffice", address_line as "addressLine",
  district, city, postal_code as "postalCode", country, phone`;

export async function taxProfileRoutes(app: FastifyInstance) {
  app.get("/api/company/tax-profile", async (req) =>
    tenant(req, "receivable.view", async (db, actor) => {
      const r = (await db.query(`select ${companyCols} from companies where id = $1`, [actor.companyId])).rows[0];
      if (!r) throw notFound("Şirket");
      return r;
    }),
  );

  app.post("/api/company/tax-profile", async (req) => {
    const input = parse(CompanyTaxProfile, req.body);
    return tenant(req, "org.manage", async (db, actor) => {
      const before = (await db.query(`select ${companyCols} from companies where id = $1 for update`, [actor.companyId])).rows[0];
      if (!before) throw notFound("Şirket");
      const r = await db.query(
        `update companies set legal_name = $2, tax_no = $3, tax_office = $4, address_line = $5, district = $6, city = $7, postal_code = $8, phone = $9
          where id = $1 returning ${companyCols}`,
        [actor.companyId, input.legalName, input.taxNo, input.taxOffice, input.addressLine, input.district ?? null, input.city, input.postalCode ?? null, input.phone ?? null],
      );
      await recordEvent(db, actor, { entityType: "company", entityId: actor.companyId, eventType: "tax_profile.updated", before, after: r.rows[0] });
      return r.rows[0];
    });
  });

  app.get("/api/customers/:id/tax-identity", async (req) =>
    tenant(req, "receivable.view", async (db) => {
      const { id } = req.params as { id: string };
      const r = (await db.query(`select id, name, legal_name as "legalName", tax_no as "taxNo", tax_office as "taxOffice" from customers where id = $1`, [id])).rows[0];
      if (!r) throw notFound("Müşteri");
      return r;
    }),
  );

  app.post("/api/customers/:id/tax-identity", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(CustomerTaxIdentity, req.body);
    return tenant(req, "receivable.manage", async (db, actor) => {
      const before = (await db.query(`select legal_name as "legalName", tax_no as "taxNo", tax_office as "taxOffice" from customers where id = $1 for update`, [id])).rows[0];
      if (!before) throw notFound("Müşteri");
      await db.query(`update customers set legal_name = $2, tax_no = $3, tax_office = $4 where id = $1`, [id, input.legalName, input.taxNo, input.taxOffice ?? null]);
      const after = { legalName: input.legalName, taxNo: input.taxNo, taxOffice: input.taxOffice ?? null };
      await recordEvent(db, actor, { entityType: "customer", entityId: id, eventType: "tax_identity.updated", before, after });
      return { id, ...after };
    });
  });
}
