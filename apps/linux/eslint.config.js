import base from "@relay/eslint-config";

export default [
  ...base,
  { languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } } },
  // The daemon's terminal is its UI: PIN prompts and status lines go to stdout on purpose.
  { files: ["src/main.ts", "src/pairing.ts"], rules: { "no-console": "off" } },
];
