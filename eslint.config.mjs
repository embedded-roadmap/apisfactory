// @ts-check
import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/dist/**", "**/build/**", "**/.expo/**", "**/coverage/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // `_` önekli argüman/değişkenler bilinçli olarak kullanılmıyor demektir.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none", ignoreRestSiblings: true },
      ],
      // pg satırları ve dış servis cevapları bilinçli olarak `any` ile karşılanıyor.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    files: ["apps/api/**/*.{ts,mjs,js}", "scripts/**/*.{js,mjs}", "*.config.{js,ts}", "apps/*/*.config.{js,ts}"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["apps/web/src/**/*.{ts,tsx}", "apps/mobile/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    files: ["apps/web/public/**/*.js"],
    languageOptions: { globals: globals.serviceworker },
  },
);
