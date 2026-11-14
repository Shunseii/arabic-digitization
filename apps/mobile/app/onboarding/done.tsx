import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ActionBar, Button, Card, T } from "@/components/ui";
import { useConfigState } from "@/lib/config-context";
import { useColors } from "@/theme";

const CheckItem = ({ label, done }: { label: string; done: boolean }) => {
  const c = useColors();
  return (
    <View className="flex-row items-center gap-2.5">
      <Feather
        name={done ? "check-circle" : "circle"}
        size={18}
        color={done ? c.ok : c.ink3}
      />
      <T className={done ? "" : "text-ink-3"}>{label}</T>
    </View>
  );
};

export default function DoneScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const c = useColors();
  const { config } = useConfigState();
  const searchEnabled = Boolean(config?.meiliUrl && config?.meiliKey);

  return (
    <View className="flex-1 bg-bg" style={{ paddingTop: insets.top }}>
      <View className="flex-1 justify-center gap-6 px-6">
        <View className="items-center gap-2.5">
          <View className="mb-2 size-24 items-center justify-center rounded-full bg-ok-soft">
            <Feather name="check" size={40} color={c.ok} />
          </View>
          <T variant="title" className="text-center">
            You're connected
          </T>
          <T className="text-center text-ink-2">
            Add a book and start scanning. You can change these anytime in
            Settings.
          </T>
        </View>
        <Card className="gap-3 p-4">
          <CheckItem label="API connected · key saved" done={config != null} />
          <CheckItem
            label={
              searchEnabled
                ? "Search enabled · key saved"
                : "Search not set up · add it in Settings"
            }
            done={searchEnabled}
          />
        </Card>
      </View>
      <ActionBar>
        <Button
          label="Add your first book"
          icon="plus"
          onPress={() => {
            router.replace("/");
            router.push("/new-book");
          }}
        />
        <Button
          label="Go to library"
          variant="ghost"
          onPress={() => router.replace("/")}
        />
      </ActionBar>
    </View>
  );
}
