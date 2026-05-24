import React from "react";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
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
import { RideBookingsScreen } from "@/screens/RideBookings";
import { MyLocationScreen } from "@/screens/MyLocation";
import { EditProfileScreen } from "@/screens/EditProfile";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { colors } from "@/theme";

// Wraps a screen component in an ErrorBoundary so a crash on, say,
// RideDetail surfaces a red diagnostic screen INSIDE the navigator
// rather than killing the whole app.  React Navigation will re-mount
// the inner component on retry.
function withBoundary<P>(Component: React.ComponentType<P>, label: string) {
  const Wrapped = (props: P) => (
    <ErrorBoundary label={label}>
      <Component {...(props as any)} />
    </ErrorBoundary>
  );
  Wrapped.displayName = `Boundary(${label})`;
  return Wrapped;
}

const SafeLoginScreen        = withBoundary(LoginScreen,        "Login");
const SafeSearchScreen       = withBoundary(SearchScreen,       "Search");
const SafeSearchResultsScreen = withBoundary(SearchResultsScreen, "SearchResults");
const SafeRideDetailScreen   = withBoundary(RideDetailScreen,   "RideDetail");
const SafePublishScreen      = withBoundary(PublishScreen,      "Publish");
const SafeTripsScreen        = withBoundary(TripsScreen,        "Trips");
const SafeProfileScreen      = withBoundary(ProfileScreen,      "Profile");
const SafeTrackingScreen     = withBoundary(TrackingScreen,     "Tracking");
const SafeChatListScreen     = withBoundary(ChatListScreen,     "Chats");
const SafeChatThreadScreen   = withBoundary(ChatThreadScreen,   "ChatThread");
const SafeRideBookingsScreen = withBoundary(RideBookingsScreen, "RideBookings");
const SafeMyLocationScreen   = withBoundary(MyLocationScreen,   "MyLocation");
const SafeEditProfileScreen  = withBoundary(EditProfileScreen,  "EditProfile");

export type RideSort = "departure" | "price_asc" | "price_desc" | "duration";

export type RootStackParamList = {
  Login: undefined;
  Tabs: undefined;
  SearchResults: {
    origin?: City | null;
    destination?: City | null;
    /** YYYY-MM-DD; when omitted, the backend lists all upcoming dates. */
    date?: string;
    seats?: number;
    sort?: RideSort;
    /** 1 to limit to instant-bookable rides. */
    instantOnly?: number;
    /** 1 to limit to women-only rides. */
    womenOnly?: number;
    /** Inclusive upper bound on price_per_seat. */
    maxPrice?: number;
  };
  RideDetail: { rideId: string };
  RideBookings: { rideId: string };
  Tracking: { rideId: string; role?: "driver" | "passenger"; bookingId?: string };
  ChatThread: { threadId: string };
  MyLocation: { role?: "driver" | "person" } | undefined;
  EditProfile: undefined;
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
  // Phones with gesture navigation have a non-zero bottom safe-area inset.
  // Without padding for it the tab bar slides under the home indicator and
  // the labels become unreadable / un-tappable — which is exactly what made
  // the menu look invisible after the first build.  We grow the bar by the
  // inset so the icons + labels always sit comfortably above the system bar.
  const insets = useSafeAreaInsets();

  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        tabBarActiveTintColor: colors.text,
        tabBarInactiveTintColor: colors.mute,
        tabBarShowLabel: true,
        tabBarHideOnKeyboard: true,
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: "700",
          letterSpacing: -0.1,
          marginBottom: 4
        },
        tabBarItemStyle: { paddingTop: 4 },
        tabBarStyle: {
          backgroundColor: colors.card,
          borderTopColor: colors.border,
          borderTopWidth: 1,
          height: 64 + insets.bottom,
          paddingTop: 8,
          paddingBottom: 8 + insets.bottom
        },
        headerShown: false,
        tabBarIcon: ({ focused, color, size }) => {
          const set = ICONS[route.name as keyof typeof ICONS];
          if (!set) return null;
          return (
            <Ionicons
              name={focused ? set.active : set.inactive}
              size={size ?? 24}
              color={color}
            />
          );
        }
      })}
    >
      <Tab.Screen name="Search" component={SafeSearchScreen} options={{ title: "Search" }} />
      <Tab.Screen
        name="Publish"
        component={SafePublishScreen}
        options={{ title: "Publish Ride", tabBarLabelStyle: { fontSize: 10, fontWeight: "700" } }}
      />
      <Tab.Screen name="Trips" component={SafeTripsScreen} options={{ title: "Trips" }} />
      <Tab.Screen name="Chats" component={SafeChatListScreen} options={{ title: "Chats" }} />
      <Tab.Screen name="Profile" component={SafeProfileScreen} options={{ title: "Profile" }} />
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
        <Stack.Screen name="Login" component={SafeLoginScreen} options={{ headerShown: false }} />
      ) : (
        <>
          <Stack.Screen name="Tabs" component={Tabs} options={{ headerShown: false }} />
          <Stack.Screen name="SearchResults" component={SafeSearchResultsScreen} options={{ title: "Rides" }} />
          <Stack.Screen name="RideDetail" component={SafeRideDetailScreen} options={{ title: "Ride" }} />
          <Stack.Screen
            name="RideBookings"
            component={SafeRideBookingsScreen}
            options={{ headerShown: false }}
          />
          <Stack.Screen name="Tracking" component={SafeTrackingScreen} options={{ headerShown: false }} />
          <Stack.Screen
            name="ChatThread"
            component={SafeChatThreadScreen}
            options={{ headerShown: false }}
          />
          <Stack.Screen
            name="MyLocation"
            component={SafeMyLocationScreen}
            options={{ headerShown: false }}
          />
          <Stack.Screen
            name="EditProfile"
            component={SafeEditProfileScreen}
            options={{ headerShown: false }}
          />
        </>
      )}
    </Stack.Navigator>
  );
}
