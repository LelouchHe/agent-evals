import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: { globals: globals.node },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    // The executable fake deliberately accepts malformed protocol inputs.
    files: ["tests/helpers/fake-pi.ts"],
    rules: { "@typescript-eslint/ban-ts-comment": ["error", { "ts-nocheck": false }] },
  },
);
