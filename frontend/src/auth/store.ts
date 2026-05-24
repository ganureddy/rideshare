// Persisted credentials. Uses Expo SecureStore on device (Keychain / Keystore).
// Falls back to AsyncStorage on emulator/web where SecureStore is unavailable.

import * as SecureStore from "expo-secure-store";
import AsyncStorage from "@react-native-async-storage/async-storage";

export type Credentials = {
  user: string;
  mobileNo: string;
  apiKey: string;
  apiSecret: string;
};

const KEY = "rideshare.credentials.v1";

// Storage helpers wrapped so a broken native module (rare but observed
// on some Android skins) degrades to "no persisted creds" instead of
// crashing the whole AuthProvider on launch.

async function isSecureStoreAvailable(): Promise<boolean> {
  try {
    return await SecureStore.isAvailableAsync();
  } catch {
    return false;
  }
}

async function setItem(value: string) {
  try {
    if (await isSecureStoreAvailable()) {
      await SecureStore.setItemAsync(KEY, value, {
        keychainAccessible: SecureStore.WHEN_UNLOCKED
      });
    } else {
      await AsyncStorage.setItem(KEY, value);
    }
  } catch {/* persistence is best-effort; auth still works for the session */}
}

async function getItem(): Promise<string | null> {
  try {
    if (await isSecureStoreAvailable()) {
      return await SecureStore.getItemAsync(KEY);
    }
    return await AsyncStorage.getItem(KEY);
  } catch {
    return null;
  }
}

async function removeItem() {
  try {
    if (await isSecureStoreAvailable()) {
      await SecureStore.deleteItemAsync(KEY);
    } else {
      await AsyncStorage.removeItem(KEY);
    }
  } catch {/* noop */}
}

export const credentialsStore = {
  async get(): Promise<Credentials | null> {
    const raw = await getItem();
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Credentials;
    } catch {
      await removeItem();
      return null;
    }
  },
  async set(c: Credentials) {
    await setItem(JSON.stringify(c));
  },
  async clear() {
    await removeItem();
  }
};
