import React from "react";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "@/auth/AuthContext";
import type { City } from "@/components/CityPicker";
import { LoginScreen } from "@/screens/Login";
import { SearchScreen } from "@/screens/Search";
import { SearchResultsScreen } from "@/screens/SearchResults";
import { RideDetailScreen } from "@/screens/RideDetail";
import { PublishScreen } from "@/screens/Publish";
import { TripsScreen } from "@/screens/Trips";
import { ProfileScreen } from "@/screens/Profile";
import { TrackingScreen } from "@/screens/Tracking";
import { ChatListScreen } from "@/screens/ChatList";
import { ChatThreadScreen } from "@/screens/ChatThread";
import { colors } from "@/theme";

export type RootStackParamList = {
  Login: undefined;
  Tabs: undefined;
  SearchResults: {
    origin?: City | null;
    destination?: City | null;
    /** YYYY-MM-DD; when omitted, the backend lists all upcoming dates. */
    date?: string;
    seats?: number;
  };
  RideDetail: { rideId: string };
  Tracking: { rideId: string; role?: "driver" | "passenger" };
  ChatThread: { threadId: string };
};

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator();

const ICONS: Record<string, { active: keyof typeof Ionicons.glyphMap; inactive: keyof typeof Ionicons.glyphMap }> = {
  Search: { active: "search", inactive: "search-outline" },
  Publish: { active: "add-circle", inactive: "add-circle-outline" },
  Trips: { active: "list", inactive: "list-outline" },
  Chats: { active: "chatbubbles", inactive: "chatbubbles-outline" },
  Profile: { active: "person", inactive: "person-outline" }
};

function Tabs() {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        tabBarActiveTintColor: colors.text,
        tabBarInactiveTintColor: colors.mute,
        tabBarShowLabel: true,
        tabBarLabelStyle: { fontSize: 11, fontWeight: "600", marginBottom: 4 },
        tabBarStyle: {
          backgroundColor: colors.card,
          borderTopColor: colors.border,
          borderTopWidth: 1,
          height: 60,
          paddingTop: 6
        },
        headerShown: false,
        tabBarIcon: ({ focused, color, size }) => {
          const set = ICONS[route.name as keyof typeof ICONS];
          if (!set) return null;
          return (
            <Ionicons
              name={focused ? set.active : set.inactive}
              size={size ?? 22}
              color={color}
            />
          );
        }
      })}
    >
      <Tab.Screen name="Search" component={SearchScreen} options={{ title: "Find" }} />
      <Tab.Screen name="Publish" component={PublishScreen} options={{ title: "Publish" }} />
      <Tab.Screen name="Trips" component={TripsScreen} options={{ title: "Trips" }} />
      <Tab.Screen name="Chats" component={ChatListScreen} options={{ title: "Chats" }} />
      <Tab.Screen name="Profile" component={ProfileScreen} options={{ title: "Account" }} />
    </Tab.Navigator>
  );
}

export function RootNavigator() {
  const { user } = useAuth();
  return (
    <Stack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: colors.card },
        headerTintColor: colors.text,
        headerTitleStyle: { fontWeight: "700", color: colors.text },
        headerShadowVisible: false,
        contentStyle: { backgroundColor: colors.bg }
      }}
    >
      {!user ? (
        <Stack.Screen name="Login" component={LoginScreen} options={{ headerShown: false }} />
      ) : (
        <>
          <Stack.Screen name="Tabs" component={Tabs} options={{ headerShown: false }} />
          <Stack.Screen name="SearchResults" component={SearchResultsScreen} options={{ title: "Rides" }} />
          <Stack.Screen name="RideDetail" component={RideDetailScreen} options={{ title: "Ride" }} />
          <Stack.Screen name="Tracking" component={TrackingScreen} options={{ headerShown: false }} />
          <Stack.Screen
            name="ChatThread"
            component={ChatThreadScreen}
            options={{ headerShown: false }}
          />
        </>
      )}
    </Stack.Navigator>
  );
}
