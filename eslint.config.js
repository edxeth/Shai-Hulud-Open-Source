import simpleImportSort from "eslint-plugin-simple-import-sort";

export default [
  // Global ignores MUST be alone in their own object to apply project-wide.
  {
    ignores: [
      "dist/**",
      "build/**",
      "coverage/**",
      "node_modules/**",
      "**/*.d.ts",
    ],
  },

  // Actual lint config for TS/TSX files.
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: (await import("@typescript-eslint/parser")).default,
    },
    plugins: { "simple-import-sort": simpleImportSort },
    rules: {
      "simple-import-sort/imports": "error",
      "simple-import-sort/exports": "error",
    },
  },
];
