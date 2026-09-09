import js from "@eslint/js";
import tseslint from "typescript-eslint";

/** Shared strict config. Consumers add their own `files`/`ignores` and tsconfig project. */
export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/no-unnecessary-condition": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
);
