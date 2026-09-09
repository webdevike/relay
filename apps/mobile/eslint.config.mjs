import base from "@relay/eslint-config";

export default [
  ...base,
  { languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } } },
  { ignores: ["ios/**", "android/**", "dist/**", ".expo/**", "babel.config.js", "metro.config.js", "eslint.config.mjs", "vitest.config.ts"] },
];
