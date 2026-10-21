import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  { ignores: ["node_modules/**", ".event-calendar/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["bin/**", "src/**", "test/**"],
    languageOptions: { globals: globals.node },
  },
  {
    // Leading-underscore names mark intentionally unused bindings (rest-omit destructuring, unused callback params).
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },
  {
    // Tests read untyped JSON response bodies and error objects; `any` casts are scoped to test code only.
    files: ["test/**"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  {
    files: ["gui/**/*.js"],
    languageOptions: { sourceType: "module", globals: globals.browser },
  },
);
