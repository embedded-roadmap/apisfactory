export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new AppError(404, "not_found", `${what} bulunamadı`);
export const forbidden = (perm?: string) =>
  new AppError(403, "forbidden", "Bu işlem için yetkiniz yok", perm ? { permission: perm } : undefined);
export const conflict = (code: string, message: string, details?: unknown) => new AppError(409, code, message, details);
export const badRequest = (message: string, details?: unknown) => new AppError(400, "bad_request", message, details);

/** Postgres tetikleyicilerinin fırlattığı iş kuralı hatalarını anlamlı HTTP hatalarına çevirir. */
export function mapDbError(err: unknown): AppError | null {
  const e = err as { code?: string; message?: string; constraint?: string };
  if (e?.code === "P0001" && e.message) {
    const [code, ...rest] = e.message.split(":");
    return new AppError(409, code ?? "rule_violation", rest.join(":").trim() || e.message);
  }
  if (e?.code === "23505") return new AppError(409, "duplicate", "Aynı kayıt zaten var", { constraint: e.constraint });
  if (e?.code === "23503") return new AppError(409, "reference", "İlişkili kayıt bulunamadı veya kullanımda", { constraint: e.constraint });
  if (e?.code === "42501") return new AppError(403, "forbidden", "Veri tabanı erişimi reddedildi");
  return null;
}
