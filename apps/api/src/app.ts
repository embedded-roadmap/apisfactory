import { workflowRoutes } from "./modules/workflow";
import { stationRoutes } from "./modules/station";
import { routingRoutes } from "./modules/routing";
import { handoverRoutes } from "./modules/handover";
import { collaborationRoutes } from "./modules/collaboration";
import { procurementRoutes } from "./modules/procurement";
import { payablesRoutes } from "./modules/payables";
import { receivablesRoutes } from "./modules/receivables";
import { collectionsRoutes } from "./modules/collections";
import { rdProjectsRoutes } from "./modules/rd-projects";
import { distributorRoutes } from "./modules/distributors";
import { supplyRiskRoutes } from "./modules/supply-risk";
import { alternateRoutes } from "./modules/alternates";
import { dispatchRoutes } from "./modules/dispatch";
import { calendarRoutes } from "./modules/calendar";
import { billingRoutes } from "./modules/billing";
import { taxProfileRoutes } from "./modules/tax-profile";
import { opsRoutes } from "./modules/ops";
import { storageRoutes } from "./modules/storage";
import { scenarioRoutes } from "./modules/scenarios";
import { subcontractRoutes } from "./modules/subcontract";
import { planningRoutes } from "./modules/planning";
import { costingRoutes } from "./modules/costing";
import { reportsRoutes } from "./modules/reports";
import { returnRoutes } from "./modules/returns";
import { packagingRoutes } from "./modules/shipping";
import { qualityRoutes } from "./modules/quality";
import { changeRoutes } from "./modules/changes";
import { leadTimeRoutes } from "./modules/leadtime";
import { capacityRoutes } from "./modules/capacity";
import { alternateResearchRoutes } from "./modules/alternate-research";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { ZodError } from "zod";
import { config } from "./config";
import { AppError, mapDbError } from "./lib/errors";
import { authenticate } from "./http/context";
import { authRoutes } from "./modules/auth";
import { setupRoutes } from "./modules/setup";
import { offlineRoutes } from "./modules/offline";
import { productRoutes } from "./modules/products";
import { importRoutes } from "./modules/imports";
import { inventoryRoutes } from "./modules/inventory";
import { salesRoutes, shippingRoutes } from "./modules/sales";
import { workRoutes } from "./modules/work";
import { productionRoutes } from "./modules/production";
import { adminRoutes } from "./modules/admin";
import { subscriptionRoutes } from "./modules/subscription";
import { companyExportRoutes } from "./modules/company-export";

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 8 * 1024 * 1024 });
  await app.register(cors, { origin: config.corsOrigin.split(","), allowedHeaders: ["authorization", "content-type", "x-company-id", "idempotency-key", "x-correlation-id"] });

  // Video ekleri JSON gövdedeki base64 alanına sığmaz (W27, oturum 37) — ham ikili gövde olarak,
  // genel 8 MB sınırının üzerinde ayrı bir bodyLimit ile kabul edilir. Gerçek boyut/süre doğrulaması
  // route içinde yapılır; bu yalnızca aktarımı mümkün kılar.
  app.addContentTypeParser(["video/mp4", "video/webm"], { parseAs: "buffer", bodyLimit: 210 * 1024 * 1024 }, (_req, body, done) => done(null, body));

  app.get("/health", async () => ({ ok: true }));

  app.addHook("preHandler", async (req) => {
    if (!req.url.startsWith("/api/")) return;
    if ((req.routeOptions.config as { public?: boolean } | undefined)?.public) return;
    req.ctx = await authenticate(req);
  });

  app.setErrorHandler((err, req, reply) => {
    const mapped = err instanceof AppError ? err : mapDbError(err);
    if (mapped) return reply.status(mapped.status).send({ error: { code: mapped.code, message: mapped.message, details: mapped.details } });
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: "bad_request", message: "Girdi doğrulanamadı", details: err.flatten() } });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: { code: "bad_request", message: (err as Error).message } });
    req.log.error(err);
    return reply.status(500).send({ error: { code: "internal", message: "Beklenmeyen hata. Kayıt tutuldu." } });
  });

  await app.register(authRoutes);
  await app.register(setupRoutes);
  await app.register(offlineRoutes);
  await app.register(productRoutes);
  await app.register(importRoutes);
  await app.register(inventoryRoutes);
  await app.register(salesRoutes);
  await app.register(workRoutes);
  await app.register(productionRoutes);
  await app.register(shippingRoutes);
  await app.register(adminRoutes);
  await app.register(subscriptionRoutes);
  await app.register(companyExportRoutes);
  await app.register(qualityRoutes);
  await app.register(changeRoutes);
  await app.register(leadTimeRoutes);
  await app.register(capacityRoutes);
  await app.register(alternateResearchRoutes);
  await app.register(packagingRoutes);
  await app.register(returnRoutes);
  await app.register(costingRoutes);
  await app.register(reportsRoutes);
  await app.register(planningRoutes);
  await app.register(workflowRoutes);
  await app.register(stationRoutes);
  await app.register(routingRoutes);
  await app.register(handoverRoutes);
  await app.register(collaborationRoutes);
  await app.register(procurementRoutes);
  await app.register(payablesRoutes);
  await app.register(receivablesRoutes);
  await app.register(collectionsRoutes);
  await app.register(rdProjectsRoutes);
  await app.register(distributorRoutes);
  await app.register(supplyRiskRoutes);
  await app.register(alternateRoutes);
  await app.register(dispatchRoutes);
  await app.register(calendarRoutes);
  await app.register(billingRoutes);
  await app.register(taxProfileRoutes);
  await app.register(opsRoutes);
  await app.register(storageRoutes);
  await app.register(scenarioRoutes);
  await app.register(subcontractRoutes);
  return app;
}
