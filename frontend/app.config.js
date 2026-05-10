// Dynamic Expo config — overrides app.json. Reads env at build time so the
// same JS bundle can target dev/staging/prod by changing environment vars.
//
// In CI/EAS, set these via `eas secret:create`. In local dev, copy
// .env.example to .env and `npx expo start --clear`.

require("dotenv").config();

/** @type {(ctx: { config: any }) => any} */
module.exports = ({ config }) => {
  const androidKey = process.env.ANDROID_GOOGLE_MAPS_API_KEY;
  const iosKey = process.env.IOS_GOOGLE_MAPS_API_KEY;

  return {
    ...config,
    ios: {
      ...config.ios,
      ...(iosKey
        ? { config: { ...(config.ios?.config || {}), googleMapsApiKey: iosKey } }
        : {})
    },
    android: {
      ...config.android,
      ...(androidKey
        ? {
            config: {
              ...(config.android?.config || {}),
              googleMaps: { apiKey: androidKey }
            }
          }
        : {})
    },
    extra: {
      ...(config.extra || {}),
      apiBaseUrl: process.env.RIDESHARE_API_BASE || "http://10.0.2.2:8000",
      websocketUrl:
        process.env.RIDESHARE_WS_URL || process.env.RIDESHARE_API_BASE || "http://10.0.2.2:9000"
    }
  };
};
