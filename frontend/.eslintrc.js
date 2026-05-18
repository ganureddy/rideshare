// Frontend (Expo / React Native) ESLint config.
//
// The repo root .eslintrc is geared at Frappe's vanilla JS app code and
// doesn't know how to parse TypeScript/JSX.  We override it here so
// `npm run lint` works inside the mobile app without affecting the rest
// of the bench.
module.exports = {
  root: true,
  env: {
    es2022: true,
    node: true,
    "react-native/react-native": true
  },
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
    ecmaFeatures: { jsx: true }
  },
  plugins: ["@typescript-eslint", "react", "react-hooks", "react-native"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:react/recommended",
    "plugin:react-hooks/recommended"
  ],
  settings: {
    react: { version: "detect" }
  },
  ignorePatterns: [
    "node_modules/",
    "android/",
    "ios/",
    ".expo/",
    "dist/",
    "build/",
    "*.config.js",
    "babel.config.js",
    "app.config.js"
  ],
  rules: {
    // React Native uses the new JSX transform — no need to import React.
    "react/react-in-jsx-scope": "off",
    "react/prop-types": "off",
    "react/no-unescaped-entities": "off",
    "react/display-name": "off",

    // TypeScript handles unused-vars better than ESLint core.
    "no-unused-vars": "off",
    "@typescript-eslint/no-unused-vars": [
      "warn",
      { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true }
    ],

    // `any` is sometimes unavoidable when bridging Frappe's loose API
    // responses; surface it as a warning instead of an error.
    "@typescript-eslint/no-explicit-any": "off",
    "@typescript-eslint/ban-ts-comment": "off",
    "@typescript-eslint/no-empty-function": "off",
    "@typescript-eslint/no-non-null-assertion": "off",
    "@typescript-eslint/no-empty-interface": "off",
    "@typescript-eslint/no-empty-object-type": "off",

    // React Native's Metro bundler relies on `require("./asset.png")` for
    // static image assets — there's no ES-module equivalent for image
    // resolution in RN, so this rule fights the platform.
    "@typescript-eslint/no-require-imports": "off",

    "no-console": ["warn", { allow: ["warn", "error"] }],
    "react-hooks/rules-of-hooks": "error",
    "react-hooks/exhaustive-deps": "warn"
  },
  overrides: [
    {
      files: ["*.js", "*.cjs"],
      rules: {
        "@typescript-eslint/no-var-requires": "off"
      }
    }
  ]
};
