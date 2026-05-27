// Metro bundler config.
//
// SDK 50+ requires us to extend `expo/metro-config` so that Expo's
// asset resolver, package-exports handling, and CSS/SVG transformers
// are wired up.  Without this, expo-doctor flags it and resolution
// edge-cases (e.g. our `@/`-aliased imports under deep node_modules)
// can silently fall back to the bare RN defaults.
//
// We keep the file minimal — the `@/` -> `./src` alias is handled by
// `babel-plugin-module-resolver` in `babel.config.js`, which Metro
// runs as part of the Expo transformer chain, so we don't need to
// duplicate the alias in resolver.extraNodeModules.

const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

module.exports = config;
