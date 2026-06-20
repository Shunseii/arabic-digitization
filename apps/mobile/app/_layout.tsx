import "../global.css";
import { QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ConfigProvider } from "@/lib/config-context";
import { queryClient } from "@/lib/query";
import { colors } from "@/theme";

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <ConfigProvider>
          <StatusBar style="light" />
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: colors.bg },
              animation: "slide_from_right",
            }}
          >
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="new-book" options={{ presentation: "modal" }} />
            <Stack.Screen name="scan" />
            <Stack.Screen name="book/[id]" />
            <Stack.Screen name="reader/[bookId]/[fileId]" />
          </Stack>
        </ConfigProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
