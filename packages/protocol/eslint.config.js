import base from "@relay/eslint-config";

export default [
  ...base,
  { languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } } },
  { ignores: ["dist/**"] },
];
