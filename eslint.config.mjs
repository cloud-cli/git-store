/** @type {import("eslint").Linter.Config} */
export default {
  ignores: ["node_modules/**", "data/**"],
  files: ["**/*.js"],
  languageOptions: {
    ecmaVersion: "latest",
    sourceType: "commonjs",
    globals: {
      browser: true,
      es2021: true,
      node: true,
      process: true,
      setTimeout: true,
      console: true,
      __dirname: true,
      Buffer: true,
    },
  },
  rules: {
    "curly": ["error", "multi-line"],
    "eqeqeq": "error",
    "indent": ["error", 2],
    "quotes": ["error", "single"],
    "semi": ["error", "always"],
    "no-unused-vars": ["warn", { "argsIgnorePattern": "^_" }],
    "no-console": "warn",
    "no-undef": "error",
    "no-return-assign": "error",
    "no-bitwise": "warn",
  },
};
