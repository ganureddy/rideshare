import Constants from "expo-constants";

type Extra = { apiBaseUrl: string; websocketUrl: string };

const extra = (Constants.expoConfig?.extra ?? {}) as Partial<Extra>;

// When running in Expo Go on a real phone, host-loopback URLs
// ("localhost", "127.0.0.1", "10.0.2.2") point at the *phone*, not at the
// laptop running Frappe.  Re-write those to the Metro dev-server's LAN IP
// so a physical device on the same Wi-Fi as the dev machine can reach
// the backend without hand-editing .env.
//
// Caveats:
//   * Tunnel mode (`expo start --tunnel`) reports an ngrok host
//     (`*.tunnel.expo.dev`).  That's only useful for the JS bundle, not
//     for hitting Frappe on :8000, so we only rewrite when the dev host
//     looks like an RFC 1918 LAN IP.  For tunnel testing across networks
//     set RIDESHARE_API_BASE in .env to a publicly-reachable URL.
//   * Only fires inside Expo Go (executionEnvironment === "storeClient");
//     EAS builds (standalone) are left exactly as bundled.
function isLanIp(host: string): boolean {
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}

function rewriteForExpoGo(url: string | undefined): string | undefined {
  if (!url) return url;
  if (Constants.executionEnvironment !== "storeClient") return url;
  const hostUri =
    (Constants.expoConfig as any)?.hostUri ||
    (Constants as any).expoGoConfig?.debuggerHost ||
    (Constants as any).manifest2?.extra?.expoClient?.hostUri ||
    null;
  if (!hostUri) return url;
  const lanHost = String(hostUri).split(":")[0];
  if (!lanHost || !isLanIp(lanHost)) return url;
  return url.replace(
    /\/\/(localhost|127\.0\.0\.1|10\.0\.2\.2)(?=[:/]|$)/,
    `//${lanHost}`
  );
}

const apiBaseUrl = rewriteForExpoGo(extra.apiBaseUrl) || "http://10.0.2.2:8000";
const websocketUrl =
  rewriteForExpoGo(extra.websocketUrl) ||
  rewriteForExpoGo(extra.apiBaseUrl) ||
  "http://10.0.2.2:9000";

export const ENV = { apiBaseUrl, websocketUrl };
