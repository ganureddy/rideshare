import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { call } from "@/api/client";
import { ENV } from "@/env";
import { unregisterPushTokenForUser } from "@/notifications/push";
import { credentialsStore, Credentials } from "./store";

type Profile = {
  full_name?: string;
  first_name?: string;
  email?: string;
  mobile_no?: string;
  user_image?: string | null;
  roles?: string[];
  is_driver?: boolean;
  is_verified_driver?: boolean;
  driver_profile?: { name?: string; is_verified?: boolean; verification_status?: string } | null;
};

type AuthState = {
  ready: boolean;
  user: string | null;
  mobileNo: string | null;
  profile: Profile | null;
  /** Quick check: does a User already exist for this phone? */
  checkPhone: (mobile: string) => Promise<{ exists: boolean; socialProvider?: string | null }>;
  signInWithPhone: (mobile: string, fullName?: string | null) => Promise<{ isNew: boolean }>;
  signInWithGoogle: () => Promise<{ ok: boolean; reason?: string }>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
};

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [creds, setCreds] = useState<Credentials | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);

  useEffect(() => {
    (async () => {
      const stored = await credentialsStore.get();
      setCreds(stored);
      if (stored) {
        try {
          const p = await call<Profile & { user: string }>("rideshare.api.auth.whoami");
          setProfile(p);
        } catch {
          // Token rejected — clear stale creds.
          await credentialsStore.clear();
          setCreds(null);
        }
      }
      setReady(true);
    })();
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      ready,
      user: creds?.user ?? null,
      mobileNo: creds?.mobileNo ?? null,
      profile,
      async checkPhone(mobile) {
        try {
          const res = await call<{ exists: boolean; social_provider?: string | null }>(
            "rideshare.api.auth.check_phone",
            { mobile_no: mobile }
          );
          return { exists: !!res?.exists, socialProvider: res?.social_provider ?? null };
        } catch (e: any) {
          // Only swallow the failure when the server actually replied
          // (and just said "no such user").  If we couldn't reach the
          // server at all (DNS failure, offline, TLS error, 5xx), surface
          // the error — otherwise we'd misroute a returning user into the
          // "create account" step and then fail loudly with the same
          // network error a moment later.
          const status = e?.response?.status;
          if (status === 400 || status === 404) {
            return { exists: false };
          }
          throw e;
        }
      },
      async signInWithPhone(mobile, fullName) {
        const res = await call<{
          user: string;
          mobile_no: string;
          is_new: boolean;
          api_key: string;
          api_secret: string;
          profile: Profile;
        }>("rideshare.api.auth.login_with_phone", {
          mobile_no: mobile,
          full_name: fullName
        });
        const next: Credentials = {
          user: res.user,
          mobileNo: res.mobile_no,
          apiKey: res.api_key,
          apiSecret: res.api_secret
        };
        await credentialsStore.set(next);
        setCreds(next);
        setProfile(res.profile);
        return { isNew: res.is_new };
      },
      async signInWithGoogle() {
        // 1. Ask the backend for a one-shot Google authorize URL configured
        //    to redirect to our mobile OAuth landing page after success.
        let authorizeUrl: string;
        try {
          const res = await call<{ authorize_url: string }>(
            "rideshare.api.auth.google_login_url",
            {}
          );
          authorizeUrl = res.authorize_url;
        } catch (e: any) {
          return {
            ok: false,
            reason:
              e?.message ??
              "Google sign-in isn't available on this server. Try phone sign-in."
          };
        }
        if (!authorizeUrl) {
          return { ok: false, reason: "Google authorize URL was empty." };
        }

        // 2. Open the system browser for the OAuth dance and wait for the
        //    Frappe callback page to deep-link us back via rideshare://.
        const returnUrl = Linking.createURL("auth/callback");
        let session: WebBrowser.WebBrowserAuthSessionResult;
        try {
          session = await WebBrowser.openAuthSessionAsync(authorizeUrl, returnUrl);
        } catch (e: any) {
          return { ok: false, reason: e?.message ?? "Couldn't open browser." };
        }
        if (session.type !== "success" || !session.url) {
          return {
            ok: false,
            reason:
              session.type === "cancel" ? "Sign-in cancelled." : "Sign-in didn't complete."
          };
        }

        // 3. Parse the deep link.  Expect either
        //    ?status=ok&code=<one-shot>  or  ?status=error&reason=...
        //    The deep link no longer carries api_key/api_secret directly
        //    — we trade the one-shot code for them via a server call.
        const parsed = Linking.parse(session.url);
        const params = (parsed.queryParams || {}) as Record<string, string>;
        if (params.status !== "ok" || !params.code) {
          return {
            ok: false,
            reason: params.reason || "We couldn't read the sign-in token."
          };
        }

        let exchanged: {
          user: string;
          mobile_no?: string;
          api_key: string;
          api_secret: string;
          profile?: Profile;
        };
        try {
          exchanged = await call("rideshare.api.auth.exchange_mobile_token", {
            code: params.code
          });
        } catch (e: any) {
          return {
            ok: false,
            reason: e?.message ?? "Sign-in token couldn't be exchanged."
          };
        }
        if (!exchanged?.api_key || !exchanged?.api_secret || !exchanged?.user) {
          return {
            ok: false,
            reason: "Server returned an incomplete sign-in payload."
          };
        }

        const next: Credentials = {
          user: exchanged.user,
          mobileNo: exchanged.mobile_no || "",
          apiKey: exchanged.api_key,
          apiSecret: exchanged.api_secret
        };
        await credentialsStore.set(next);
        setCreds(next);
        if (exchanged.profile) {
          setProfile(exchanged.profile);
        } else {
          try {
            const p = await call<Profile>("rideshare.api.auth.whoami");
            setProfile(p);
          } catch {
            setProfile(null);
          }
        }
        return { ok: true };
      },
      async signOut() {
        // Tell the server to drop our push token first — needs to happen
        // while we still hold valid credentials.
        try {
          await unregisterPushTokenForUser();
        } catch {/* best-effort */}
        try {
          await call("rideshare.api.auth.revoke_tokens");
        } catch {/* best-effort */}
        await credentialsStore.clear();
        setCreds(null);
        setProfile(null);
      },
      async refreshProfile() {
        if (!creds) return;
        const p = await call<Profile>("rideshare.api.auth.whoami");
        setProfile(p);
      }
    }),
    [ready, creds, profile]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth must be used inside AuthProvider");
  return v;
}

/**
 * Build the WebView URL for the Jinja chat page.
 *
 * Auth strategy: we mint a single-use 60s "chat session code" via the
 * REST API (over the existing token-authenticated channel), then embed
 * only that opaque code in the URL.  The Jinja view redeems the code
 * server-side, opens a cookie session for the bound user, and 302's
 * the WebView to a clean `?thread=X` URL — so the credentials never
 * persist in browser history, navigation stacks or nginx logs.
 *
 * No api_key / api_secret ever ships in the URL or as a Referer header.
 *
 * If the code mint call fails (network blip, expired session) we fall
 * back to the bare URL.  The page renders a friendly "please sign in"
 * card instead of leaking stale credentials, and the native shell shows
 * its retry button.
 */
export async function chatWebUrl(threadId: string): Promise<string> {
  const base = ENV.apiBaseUrl.replace(/\/$/, "");
  const params = new URLSearchParams({ thread: threadId });
  try {
    const res = await call<{ code?: string }>(
      "rideshare.api.chat.issue_chat_session_code",
      { thread: threadId }
    );
    if (res?.code) params.set("code", res.code);
  } catch {/* leave unauthenticated; page surfaces the error */}
  return `${base}/rideshare/m/chat?${params.toString()}`;
}

/**
 * Build a `<WebView source>` object.  Headers are intentionally empty —
 * authentication is carried in the one-shot code embedded in the URL,
 * not in an Authorization header that can stick around across redirects
 * or third-party fetches.
 */
export async function chatWebSource(threadId: string): Promise<{
  uri: string;
  headers: Record<string, string>;
}> {
  return { uri: await chatWebUrl(threadId), headers: {} };
}
