import React from "react";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { useAuth } from "@/auth/AuthContext";
import { LoginScreen } from "@/screens/Login";
import { SearchScreen } from "@/screens/Search";
import { SearchResultsScreen } from "@/screens/SearchResults";
import { RideDetailScreen } from "@/screens/RideDetail";
import { PublishScreen } from "@/screens/Publish";
import { TripsScreen } from "@/screens/Trips";
import { ProfileScreen } from "@/screens/Profile";
import { TrackingScreen } from "@/screens/Tracking";
import { colors } from "@/theme";

export type RootStackParamList = {
  Login: undefined;
  Tabs: undefined;
  SearchResults: { origin?: any; destination?: any; date?: string; seats?: number };
  RideDetail: { rideId: string };
  Tracking: { rideId: string; role?: "driver" | "passenger" };
};

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator();

function Tabs() {
  return (
    <Tab.Navigator
      screenOptions={{
        tabBarActiveTintColor: colors.blue,
        tabBarInactiveTintColor: colors.soft,
        headerShown: true
      }}
    >
      <Tab.Screen name="Search" component={SearchScreen} />
      <Tab.Screen name="Publish" component={PublishScreen} />
      <Tab.Screen name="Trips" component={TripsScreen} />
      <Tab.Screen name="Profile" component={ProfileScreen} />
    </Tab.Navigator>
  );
}

export function RootNavigator() {
  const { user } = useAuth();
  return (
    <Stack.Navigator>
      {!user ? (
        <Stack.Screen name="Login" component={LoginScreen} options={{ headerShown: false }} />
      ) : (
        <>
          <Stack.Screen name="Tabs" component={Tabs} options={{ headerShown: false }} />
          <Stack.Screen name="SearchResults" component={SearchResultsScreen} options={{ title: "Rides" }} />
          <Stack.Screen name="RideDetail" component={RideDetailScreen} options={{ title: "Ride" }} />
          <Stack.Screen name="Tracking" component={TrackingScreen} options={{ title: "Live trip" }} />
        </>
      )}
    </Stack.Navigator>
  );
}
