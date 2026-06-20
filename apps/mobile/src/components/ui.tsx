import type { FileState } from "@qiraa/shared";
import { ActivityIndicator, Text, View } from "react-native";
import { colors, statusColors, statusLabel } from "@/theme";

export const StatusDot = ({
  state,
  size = 10,
}: {
  state: FileState;
  size?: number;
}) => (
  <View
    style={{
      width: size,
      height: size,
      borderRadius: size / 2,
      backgroundColor: statusColors[state],
    }}
  />
);

export const StatusBadge = ({ state }: { state: FileState }) => (
  <View
    className="flex-row items-center gap-1.5 rounded-full px-2.5 py-1"
    style={{ backgroundColor: `${statusColors[state]}22` }}
  >
    <StatusDot state={state} size={6} />
    <Text
      className="text-xs font-semibold"
      style={{ color: statusColors[state] }}
    >
      {statusLabel[state]}
    </Text>
  </View>
);

export const Loading = () => (
  <View className="flex-1 items-center justify-center">
    <ActivityIndicator color={colors.accent} />
  </View>
);

export const Centered = ({ children }: { children: React.ReactNode }) => (
  <View className="flex-1 items-center justify-center gap-3 px-8">
    {children}
  </View>
);
