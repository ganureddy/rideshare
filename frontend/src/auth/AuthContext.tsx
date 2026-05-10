import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { call } from "@/api/client";
import { credentialsStore, Credentials } from "./store";

type Profile = {
  full_name?: string;
  first_name?: string;
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
  signInWithPhone: (mobile: string, fullName?: string) => Promise<{ isNew: boolean }>;
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
      async signOut() {
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
