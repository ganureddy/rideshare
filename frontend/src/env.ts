import Constants from "expo-constants";

type Extra = { apiBaseUrl: string; websocketUrl: string };

const extra = (Constants.expoConfig?.extra ?? {}) as Partial<Extra>;

export const ENV = {
  apiBaseUrl: extra.apiBaseUrl || "http://10.0.2.2:8000", // Android emulator default
  websocketUrl: extra.websocketUrl || extra.apiBaseUrl || "http://10.0.2.2:9000"
};
