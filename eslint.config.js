// ESLint flat config. Lint runs with --max-warnings 0 (AGENTS.md "Lint has no warning
// tier"), so every rule enforced here is effectively an error. Generated output is never
// linted (AGENTS.md "Build output is never a gate target").
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/",
      "coverage/",
      ".meridian-keys/",
      ".receipts/",
      "demo-output/",
      ".claude/",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
  {
    // Node-run tooling (this file): no type information, Node globals.
    files: ["**/*.js"],
    ...tseslint.configs.disableTypeChecked,
  },
);
