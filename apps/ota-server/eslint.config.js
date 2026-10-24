import base from "@relay/eslint-config";

export default [
  ...base,
  { languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } } },
  // The request log and the publish/install scripts report to the terminal on purpose.
  { files: ["src/main.ts", "src/publish.ts", "src/install-service.ts"], rules: { "no-console": "off" } },
];
