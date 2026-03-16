import js from "@eslint/js";
import importPlugin from "eslint-plugin-import";
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
    group: ["**/tse-workbench/**", "**/projects/pdf-engine/**", "**/private/control/**", "**/clusters/**", "**/research/**"],
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
      import: importPlugin,
      regexp: regexpPlugin,
    },
    settings: {
      "import/resolver": {
        typescript: {
          alwaysTryTypes: false,
          project: "./tsconfig.eslint.json",
        },
      },
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
      "import/no-duplicates": "error",
      "import/no-unresolved": "error",
      "import/order": importOrderRule,
      ...regexpSafetyRules,
    },
  },
  {
    files: ["src/**/*.ts", "jsr/**/*.ts"],
    rules: {
      "import/no-nodejs-modules": "error",
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
      import: importPlugin,
      regexp: regexpPlugin,
    },
    rules: {
      "import/no-duplicates": "error",
      "import/order": importOrderRule,
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
