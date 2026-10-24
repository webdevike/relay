import base from "../../tooling/eslint-config/index.js";

export default [
  ...base,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  { ignores: ["generated/**", "node_modules/**"] },
];
