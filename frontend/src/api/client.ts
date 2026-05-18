// Axios wrapper that talks to Frappe's whitelisted-method endpoints.
//
// Frappe requires either:
//   1. A cookie session (Set-Cookie sid=...) from /api/method/login, OR
//   2. An Authorization: token <api_key>:<api_secret> header.
// We use (2) — the device persists the pair in SecureStore. Cleaner UX,
// no cookie-jar gotchas with React Native's fetch impl.

import axios, { AxiosInstance, AxiosRequestConfig } from "axios";
import { ENV } from "@/env";
import { credentialsStore } from "@/auth/store";

let _client: AxiosInstance | null = null;

function build(): AxiosInstance {
  const c = axios.create({
    baseURL: ENV.apiBaseUrl,
    timeout: 15000,
    headers: { "X-Frappe-Site-Name": "" }
  });
  c.interceptors.request.use(async (cfg) => {
    const creds = await credentialsStore.get();
    if (creds?.apiKey && creds?.apiSecret) {
      cfg.headers = cfg.headers || {};
      cfg.headers["Authorization"] = `token ${creds.apiKey}:${creds.apiSecret}`;
    }
    return cfg;
  });
  c.interceptors.response.use(
    (r) => r,
    (err) => {
      // Frappe wraps errors as { exc_type, exception, message, _server_messages }.
      const data = err?.response?.data;
      let message = err.message;
      if (data?._server_messages) {
        try {
          const msgs = JSON.parse(data._server_messages);
          message = JSON.parse(msgs[0]).message || message;
        } catch {/* ignore */}
      } else if (data?.message) {
        message = data.message;
      } else if (!err.response) {
        // The request never reached the server — DNS failure, wrong URL
        // baked into the build, no internet, TLS handshake error, etc.
        // Include the URL we tried so the user can see at a glance
        // whether they're hitting the right backend.
        const target = err?.config?.baseURL || ENV.apiBaseUrl;
        message = `Couldn't reach the server (${target}). Check your internet connection.`;
      }
      return Promise.reject(Object.assign(err, { message }));
    }
  );
  return c;
}

export function client(): AxiosInstance {
  if (!_client) _client = build();
  return _client;
}

// Frappe convention: POST /api/method/<dotted.path>?<form-encoded args>
// Returns the `message` payload (Frappe wraps results in `{ message: ... }`).
export async function call<T = unknown>(
  method: string,
  args: Record<string, unknown> = {},
  config: AxiosRequestConfig = {}
): Promise<T> {
  const params = new URLSearchParams();
  Object.entries(args).forEach(([k, v]) => {
    if (v === undefined || v === null) return;
    params.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  });
  const res = await client().post(`/api/method/${method}`, params.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    ...config
  });
  return (res.data?.message ?? res.data) as T;
}

// GET variant for read-mostly endpoints.
export async function getCall<T = unknown>(
  method: string,
  args: Record<string, unknown> = {}
): Promise<T> {
  const res = await client().get(`/api/method/${method}`, { params: args });
  return (res.data?.message ?? res.data) as T;
}
