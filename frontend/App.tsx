import "react-native-gesture-handler";
import React from "react";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { NavigationContainer } from "@react-navigation/native";
import * as Linking from "expo-linking";
import { AuthProvider, useAuth } from "@/auth/AuthContext";
import { RootNavigator } from "@/navigation/RootNavigator";

const linking = {
  prefixes: [Linking.createURL("/"), "rideshare://"],
  config: {
    screens: {
      Login: "auth",
      Home: "home",
      RideDetail: "ride/:rideId",
      Tracking: "track/:rideId"
    }
  }
};

function Root() {
  const { ready } = useAuth();
  if (!ready) return null; // Splash will be shown by Expo until first render
  return (
    <NavigationContainer linking={linking}>
      <RootNavigator />
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <StatusBar style="dark" />
        <Root />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
