import tseslint from "typescript-eslint";

// Ban APIs that turn strings into HTML or code. The page builds everything with
// DOM methods and textContent, so archive data can never become markup.
const noHtmlInjection = {
  "no-restricted-properties": [
    "error",
    { property: "innerHTML", message: "Build DOM nodes and use textContent instead." },
    { property: "outerHTML", message: "Build DOM nodes and use textContent instead." },
    { property: "insertAdjacentHTML", message: "Build DOM nodes and use textContent instead." },
    { object: "document", property: "write", message: "Not allowed." },
    { object: "document", property: "writeln", message: "Not allowed." },
  ],
  "no-eval": "error",
  "no-implied-eval": "error",
  "no-new-func": "error",
  "no-script-url": "error",
};

export default tseslint.config(
  { ignores: ["node_modules/", "dist/", ".wrangler/", "worker-configuration.d.ts"] },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    rules: {
      ...noHtmlInjection,
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
    },
  },
  {
    files: ["public/**/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: {
        window: "readonly", document: "readonly", fetch: "readonly", URL: "readonly",
        URLSearchParams: "readonly", localStorage: "readonly", navigator: "readonly",
        history: "readonly", location: "readonly", Blob: "readonly", Intl: "readonly",
        setTimeout: "readonly", clearTimeout: "readonly", console: "readonly", AbortController: "readonly",
        Node: "readonly", Element: "readonly",
      },
    },
    rules: { ...noHtmlInjection, "no-undef": "error" },
  },
  {
    // Security tests deliberately contain hostile strings such as javascript: URLs,
    // and read loosely-typed JSON responses.
    files: ["test/**/*.test.ts"],
    rules: { "no-script-url": "off", "@typescript-eslint/no-explicit-any": "off" },
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: { process: "readonly", console: "readonly", fetch: "readonly", URL: "readonly", setTimeout: "readonly", AbortSignal: "readonly" },
    },
  },
);
