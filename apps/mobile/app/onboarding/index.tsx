import { useRouter } from "expo-router";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ActionBar, Button, PagePlaceholder, T } from "@/components/ui";
import { useColors } from "@/theme";

const PAGE = { width: 140, height: 190 };

const ScanArt = () => {
  const c = useColors();
  return (
    <View className="h-64 w-72 items-center justify-center">
      <View
        className="absolute"
        style={{ transform: [{ translateX: -70 }, { rotate: "-8deg" }] }}
      >
        <PagePlaceholder {...PAGE} lines={11} />
      </View>
      <View
        className="absolute"
        style={{ transform: [{ translateX: 70 }, { rotate: "8deg" }] }}
      >
        <PagePlaceholder {...PAGE} lines={11} />
      </View>
      <View className="absolute">
        <PagePlaceholder
          width={PAGE.width}
          height={PAGE.height + 10}
          lines={11}
        />
      </View>
      <View
        className="absolute rounded-2xl border-2 border-accent"
        style={{ width: PAGE.width + 18, height: PAGE.height + 20 }}
      />
      <View
        className="absolute h-0.5 rounded-full bg-accent"
        style={{
          width: PAGE.width + 36,
          top: "38%",
          shadowColor: c.accent,
          shadowOpacity: 0.6,
          shadowRadius: 8,
          shadowOffset: { width: 0, height: 4 },
          elevation: 4,
        }}
      />
    </View>
  );
};

export default function WelcomeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  return (
    <View className="flex-1 bg-bg" style={{ paddingTop: insets.top + 24 }}>
      <View className="flex-1 items-center justify-center gap-8 px-6">
        <ScanArt />
        <View className="items-center gap-3">
          <T variant="arTitle" className="text-accent">
            رقمنة
          </T>
          <T variant="display" className="text-center">
            Every page, read and searchable.
          </T>
          <T className="text-center text-ink-2">
            Scan Arabic books with your phone. Each page is transcribed with its
            tashkeel and footnotes, then searchable across your whole library.
          </T>
        </View>
      </View>
      <ActionBar>
        <Button
          label="Connect your library"
          onPress={() => router.push("/onboarding/connect")}
        />
      </ActionBar>
    </View>
  );
}
