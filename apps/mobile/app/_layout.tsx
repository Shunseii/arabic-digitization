import "../global.css";
import { Inter_400Regular } from "@expo-google-fonts/inter/400Regular";
import { Inter_500Medium } from "@expo-google-fonts/inter/500Medium";
import { Inter_600SemiBold } from "@expo-google-fonts/inter/600SemiBold";
import { Inter_700Bold } from "@expo-google-fonts/inter/700Bold";
import { Newsreader_600SemiBold } from "@expo-google-fonts/newsreader/600SemiBold";
import { NotoNaskhArabic_400Regular } from "@expo-google-fonts/noto-naskh-arabic/400Regular";
import { NotoNaskhArabic_500Medium } from "@expo-google-fonts/noto-naskh-arabic/500Medium";
import { NotoNaskhArabic_700Bold } from "@expo-google-fonts/noto-naskh-arabic/700Bold";
import { QueryClientProvider } from "@tanstack/react-query";
import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ConfigProvider } from "@/lib/config-context";
import { queryClient } from "@/lib/query";
import { useOtaUpdates } from "@/lib/updates";
import { themeVars, useColors, useIsDark } from "@/theme";

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const isDark = useIsDark();
  const c = useColors();
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    Newsreader_600SemiBold,
    NotoNaskhArabic_400Regular,
    NotoNaskhArabic_500Medium,
    NotoNaskhArabic_700Bold,
  });
  useOtaUpdates();

  useEffect(() => {
    if (fontsLoaded || fontError) SplashScreen.hideAsync();
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <View style={[{ flex: 1 }, isDark ? themeVars.dark : themeVars.light]}>
        <SafeAreaProvider>
          <QueryClientProvider client={queryClient}>
            <ConfigProvider>
              <StatusBar style={isDark ? "light" : "dark"} />
              <Stack
                screenOptions={{
                  headerShown: false,
                  contentStyle: { backgroundColor: c.bg },
                  animation: "slide_from_right",
                }}
              >
                <Stack.Screen name="(tabs)" />
                <Stack.Screen name="onboarding" />
                <Stack.Screen
                  name="new-book"
                  options={{ presentation: "modal" }}
                />
                <Stack.Screen name="scan" />
                <Stack.Screen name="book/[id]" />
                <Stack.Screen name="work/[id]" />
                <Stack.Screen
                  name="work/edit/[id]"
                  options={{ presentation: "modal" }}
                />
                <Stack.Screen name="reader/[bookId]/[fileId]" />
              </Stack>
            </ConfigProvider>
          </QueryClientProvider>
        </SafeAreaProvider>
      </View>
    </GestureHandlerRootView>
  );
}
