import type { FastifyRequest } from "fastify";
import { AppError } from "./errors";
import { recordEvent } from "./records";
import { tenant } from "../http/context";

/**
 * Engellenen işlemin kendisi geri alınır ama engelin kaydı kalmalıdır (prompt §30, T12: "uyarı/engel ve olay kaydı").
 * İş kuralı ihlalinde bu hata fırlatılır; `withRejectionLog` ayrı bir işlemde olayı yazar ve HTTP hatasını döner.
 */
export class RuleRejection extends Error {
  constructor(
    public readonly error: AppError,
    public readonly event: { entityType: string; entityId: string; eventType: string; after?: unknown; reason?: string },
  ) {
    super(error.message);
  }
}

export async function withRejectionLog<T>(req: FastifyRequest, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof RuleRejection) {
      await tenant(req, null, (db, actor) => recordEvent(db, actor, e.event));
      throw e.error;
    }
    throw e;
  }
}
