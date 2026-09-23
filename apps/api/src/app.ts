import { workflowRoutes } from "./modules/workflow";
import { stationRoutes } from "./modules/station";
import { routingRoutes } from "./modules/routing";
import { handoverRoutes } from "./modules/handover";
import { collaborationRoutes } from "./modules/collaboration";
import { procurementRoutes } from "./modules/procurement";
import { planningRoutes } from "./modules/planning";
import { costingRoutes } from "./modules/costing";
import { returnRoutes } from "./modules/returns";
import { packagingRoutes } from "./modules/shipping";
import { qualityRoutes } from "./modules/quality";
import { changeRoutes } from "./modules/changes";
import { leadTimeRoutes } from "./modules/leadtime";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { ZodError } from "zod";
import { config } from "./config";
import { AppError, mapDbError } from "./lib/errors";
import { authenticate } from "./http/context";
import { authRoutes } from "./modules/auth";
import { productRoutes } from "./modules/products";
import { importRoutes } from "./modules/imports";
import { inventoryRoutes } from "./modules/inventory";
import { salesRoutes, shippingRoutes } from "./modules/sales";
import { workRoutes } from "./modules/work";
import { productionRoutes } from "./modules/production";
import { adminRoutes } from "./modules/admin";

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 8 * 1024 * 1024 });
  await app.register(cors, { origin: config.corsOrigin.split(","), allowedHeaders: ["authorization", "content-type", "x-company-id", "idempotency-key", "x-correlation-id"] });

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
  await app.register(productRoutes);
  await app.register(importRoutes);
  await app.register(inventoryRoutes);
  await app.register(salesRoutes);
  await app.register(workRoutes);
  await app.register(productionRoutes);
  await app.register(shippingRoutes);
  await app.register(adminRoutes);
  await app.register(qualityRoutes);
  await app.register(changeRoutes);
  await app.register(leadTimeRoutes);
  await app.register(packagingRoutes);
  await app.register(returnRoutes);
  await app.register(costingRoutes);
  await app.register(planningRoutes);
  await app.register(workflowRoutes);
  await app.register(stationRoutes);
  await app.register(routingRoutes);
  await app.register(handoverRoutes);
  await app.register(collaborationRoutes);
  await app.register(procurementRoutes);
  return app;
}
