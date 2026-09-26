import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://apis_app:app_dev_pw@localhost:5432/apisfactory_test",
      MIGRATION_DATABASE_URL: process.env.TEST_MIGRATION_DATABASE_URL ?? "postgres://apis_owner:owner_dev_pw@localhost:5432/apisfactory_test",
      JWT_SECRET: "test-secret-0123456789abcdef0123456789abcdef",
      // Test nesne depolaması gerçek data/objects dizinini kirletmesin diye ayrı bir yola yazılır (oturum 37).
      STORAGE_LOCAL_DIR: process.env.TEST_STORAGE_LOCAL_DIR ?? "/tmp/apisfactory-test-objects",
    },
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
