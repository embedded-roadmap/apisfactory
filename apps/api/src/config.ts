function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`Ortam değişkeni eksik: ${name}`);
  return v;
}

export const config = {
  databaseUrl: required("DATABASE_URL", "postgres://apis_app:app_dev_pw@localhost:5432/apisfactory"),
  migrationDatabaseUrl: required("MIGRATION_DATABASE_URL", "postgres://apis_owner:owner_dev_pw@localhost:5432/apisfactory"),
  jwtSecret: required("JWT_SECRET", process.env.NODE_ENV === "production" ? undefined : "dev-only-secret-change-me-0123456789abcdef"),
  port: Number(process.env.PORT ?? 4000),
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
  sessionHours: Number(process.env.SESSION_HOURS ?? 12),
};

if (config.jwtSecret.length < 32) throw new Error("JWT_SECRET en az 32 karakter olmalı");
