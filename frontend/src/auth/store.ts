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

async function setItem(value: string) {
  if (await SecureStore.isAvailableAsync()) {
    await SecureStore.setItemAsync(KEY, value, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED
    });
  } else {
    await AsyncStorage.setItem(KEY, value);
  }
}

async function getItem(): Promise<string | null> {
  if (await SecureStore.isAvailableAsync()) {
    return SecureStore.getItemAsync(KEY);
  }
  return AsyncStorage.getItem(KEY);
}

async function removeItem() {
  if (await SecureStore.isAvailableAsync()) {
    await SecureStore.deleteItemAsync(KEY);
  } else {
    await AsyncStorage.removeItem(KEY);
  }
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
