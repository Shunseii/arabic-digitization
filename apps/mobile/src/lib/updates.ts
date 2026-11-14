import * as Updates from "expo-updates";
import { useEffect } from "react";
import { Alert, AppState } from "react-native";

const checkAndOffer = async () => {
  try {
    const check = await Updates.checkForUpdateAsync();
    if (!check.isAvailable) return;
    await Updates.fetchUpdateAsync();
    Alert.alert("Update ready", "A new version of the app was downloaded.", [
      { text: "Later", style: "cancel" },
      { text: "Restart", onPress: () => Updates.reloadAsync() },
    ]);
  } catch {
    // Offline or no update server: the next launch will try again.
  }
};

/**
 * Checks EAS Update on launch and whenever the app returns to the foreground,
 * downloads a new JS bundle if one is published for this build's channel and
 * runtime version, and offers to restart into it. No-op in development.
 */
export const useOtaUpdates = () => {
  useEffect(() => {
    if (__DEV__ || !Updates.isEnabled) return;
    checkAndOffer();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") checkAndOffer();
    });
    return () => sub.remove();
  }, []);
};
