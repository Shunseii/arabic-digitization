import { useRouter } from "expo-router";
import type { ReactNode } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ActionBar, IconButton, T } from "@/components/ui";

const StepIndicator = ({ step, total }: { step: number; total: number }) => (
  <View className="flex-row gap-1.5">
    {Array.from({ length: total }, (_, i) => (
      <View
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed step segments
        key={i}
        className={`h-1 flex-1 rounded-full ${i < step ? "bg-accent" : "bg-surface-2"}`}
      />
    ))}
  </View>
);

/** Numbered onboarding step: back button, progress, heading, form, actions. */
export const OnboardingStep = ({
  step,
  total,
  eyebrow,
  title,
  body,
  children,
  actions,
}: {
  step: number;
  total: number;
  eyebrow: string;
  title: string;
  body: string;
  children: ReactNode;
  actions: ReactNode;
}) => {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  return (
    <KeyboardAvoidingView
      className="flex-1 bg-bg"
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        className="flex-1"
        contentContainerStyle={{
          paddingTop: insets.top + 12,
          paddingHorizontal: 24,
          paddingBottom: 24,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <View className="mb-4 self-start">
          <IconButton icon="chevron-left" onPress={() => router.back()} />
        </View>
        <StepIndicator step={step} total={total} />
        <View className="mt-5 gap-1.5">
          <T variant="overline" className="text-accent">
            {eyebrow}
          </T>
          <T variant="title">{title}</T>
          <T className="text-ink-2">{body}</T>
        </View>
        <View className="mt-6 gap-4">{children}</View>
      </ScrollView>
      <ActionBar>{actions}</ActionBar>
    </KeyboardAvoidingView>
  );
};
