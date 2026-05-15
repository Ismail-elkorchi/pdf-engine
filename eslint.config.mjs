import js from "@eslint/js";
import { createTypeScriptImportResolver } from "eslint-import-resolver-typescript";
import { importX } from "eslint-plugin-import-x";
import regexpPlugin from "eslint-plugin-regexp";
import tseslint from "typescript-eslint";

const typedFiles = ["src/**/*.ts", "jsr/**/*.ts"];
const scriptFiles = ["eslint.config.mjs", "scripts/**/*.mjs"];

const recommendedTypeChecked = tseslint.configs.recommendedTypeChecked.map((config) => ({
  ...config,
  files: typedFiles,
}));

const publicBoundaryRestrictions = [
  {
    group: ["**/private/**", "**/clusters/**", "**/research/**"],
    message: "Public pdf-engine files must not import workbench-private surfaces or evidence artifacts.",
  },
];

const publicSourceRestrictions = [
  ...publicBoundaryRestrictions,
  {
    group: ["**/dist/**"],
    message: "Public source files must not import built dist artifacts.",
  },
];

const importOrderRule = [
  "error",
  {
    groups: ["builtin", "external", "internal", "parent", "sibling", "index", "type"],
    "newlines-between": "always",
    alphabetize: {
      order: "asc",
      caseInsensitive: true,
    },
  },
];

const regexpSafetyRules = {
  "regexp/no-dupe-characters-character-class": "error",
  "regexp/no-empty-character-class": "error",
  "regexp/no-invalid-regexp": "error",
  "regexp/no-super-linear-backtracking": "error",
};

export default [
  {
    ignores: ["dist/**", "**/dist/**", "node_modules/**", "**/node_modules/**"],
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
  },
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    ...js.configs.recommended,
    languageOptions: {
      ...js.configs.recommended.languageOptions,
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        Buffer: "readonly",
        Bun: "readonly",
        console: "readonly",
        Deno: "readonly",
        fetch: "readonly",
        process: "readonly",
        TextDecoder: "readonly",
        TextEncoder: "readonly",
        URL: "readonly",
      },
    },
  },
  ...recommendedTypeChecked,
  {
    files: typedFiles,
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "import-x": importX,
      regexp: regexpPlugin,
    },
    settings: {
      "import-x/resolver-next": [
        createTypeScriptImportResolver({
          alwaysTryTypes: false,
          project: "./tsconfig.eslint.json",
        }),
      ],
    },
    rules: {
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "import-x/no-duplicates": "error",
      "import-x/no-unresolved": "error",
      "import-x/order": importOrderRule,
      ...regexpSafetyRules,
    },
  },
  {
    files: ["src/**/*.ts", "jsr/**/*.ts"],
    rules: {
      "import-x/no-nodejs-modules": "error",
      "no-restricted-imports": [
        "error",
        {
          patterns: publicSourceRestrictions,
        },
      ],
    },
  },
  {
    files: scriptFiles,
    plugins: {
      "import-x": importX,
      regexp: regexpPlugin,
    },
    rules: {
      "import-x/no-duplicates": "error",
      "import-x/order": importOrderRule,
      "no-restricted-imports": [
        "error",
        {
          patterns: publicBoundaryRestrictions,
        },
      ],
      ...regexpSafetyRules,
    },
  },
];
