import { Feather } from "@expo/vector-icons";
import { Tabs } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "@/theme";

export default function TabsLayout() {
  const insets = useSafeAreaInsets();
  const c = useColors();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: c.bg },
        tabBarStyle: {
          backgroundColor: c.surface,
          borderTopColor: c.line,
          height: 64 + insets.bottom,
          paddingTop: 8,
          paddingBottom: insets.bottom,
        },
        tabBarActiveTintColor: c.ink,
        tabBarInactiveTintColor: c.ink3,
        tabBarLabelStyle: { fontSize: 11, fontFamily: "Inter_500Medium" },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Library",
          tabBarIcon: ({ color, size }) => (
            <Feather name="book-open" color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="search"
        options={{
          title: "Search",
          tabBarIcon: ({ color, size }) => (
            <Feather name="search" color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="activity"
        options={{
          title: "Activity",
          tabBarIcon: ({ color, size }) => (
            <Feather name="activity" color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          tabBarIcon: ({ color, size }) => (
            <Feather name="settings" color={color} size={size} />
          ),
        }}
      />
    </Tabs>
  );
}
