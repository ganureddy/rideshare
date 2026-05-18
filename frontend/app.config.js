// Dynamic Expo config — overrides app.json. Reads env at build time so the
// same JS bundle can target dev/staging/prod by changing environment vars.
//
// IMPORTANT: env vars override but never *clobber* the static values in
// app.json.  EAS Cloud builds only see files tracked by git — your local
// `.env` is `.gitignore`d, so the cloud build never sees it.  We previously
// had `apiBaseUrl: process.env.X || "http://10.0.2.2:8000"`, which silently
// replaced the production URL from app.json with the Android emulator
// loopback on every cloud build → every API call on a real phone failed
// with "Network Error".  The fix: only set `apiBaseUrl` from env when
// it's actually defined.  For cloud builds the canonical place to put
// these values is `eas.json::build.<profile>.env`.
//
// Locally:  `cp .env.example .env` and `npx expo start --clear`.
// Cloud:    set them in `eas.json` (see this repo) or via `eas secret:create`.

try { require("dotenv").config(); } catch (e) {}

/** @type {(ctx: { config: any }) => any} */
module.exports = ({ config }) => {
  const androidKey = process.env.ANDROID_GOOGLE_MAPS_API_KEY;
  const iosKey = process.env.IOS_GOOGLE_MAPS_API_KEY;
  const apiBaseUrl = process.env.RIDESHARE_API_BASE;
  const websocketUrl = process.env.RIDESHARE_WS_URL || process.env.RIDESHARE_API_BASE;

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
      ...(apiBaseUrl ? { apiBaseUrl } : {}),
      ...(websocketUrl ? { websocketUrl } : {})
    }
  };
};
