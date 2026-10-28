import base from "@relay/eslint-config";

export default [
  ...base,
  { languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } } },
  // Vendored upstream (thesysdev/openui lang-core), kept diffable against upstream; see LICENSE-openui.
  { ignores: ["dist/**", "src/openui/lang/**"] },
];
