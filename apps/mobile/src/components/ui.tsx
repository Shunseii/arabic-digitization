import { Feather } from "@expo/vector-icons";
import {
  BottomSheetBackdrop,
  type BottomSheetBackdropProps,
  BottomSheetModal,
  BottomSheetScrollView,
  BottomSheetTextInput,
  BottomSheetView,
} from "@gorhom/bottom-sheet";
import type { FileState } from "@qiraa/shared";
import {
  type ComponentProps,
  createContext,
  forwardRef,
  type ReactNode,
  type Ref,
  useCallback,
  useContext,
  useEffect,
  useRef,
} from "react";
import {
  ActivityIndicator,
  BackHandler,
  Modal,
  Pressable,
  Text,
  TextInput,
  type TextInputProps,
  type TextProps,
  View,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Circle } from "react-native-svg";
import {
  statusLabel,
  statusTone,
  type Tone,
  toneColor,
  useColors,
} from "@/theme";

export type IconName = ComponentProps<typeof Feather>["name"];

/* ------------------------------------------------------------------ */
/* Type scale (designs: Type scale board)                              */
/* ------------------------------------------------------------------ */

const VARIANTS = {
  display: "font-display text-[34px] leading-[38px] tracking-tight",
  title: "font-display text-2xl leading-[29px]",
  heading: "font-body-semibold text-[17px] leading-[23px]",
  body: "font-body text-[15px] leading-[22px]",
  bodyStrong: "font-body-semibold text-[15px] leading-[22px]",
  small: "font-body text-[13px] leading-[19px]",
  caption: "font-body-medium text-xs leading-4",
  overline: "font-body-semibold text-[11px] uppercase tracking-widest",
  arTitle: "font-ar-bold text-2xl leading-9",
  arBody: "font-ar text-[19px] leading-9",
  arSmall: "font-ar-medium text-[15px] leading-6",
} as const;

export type TextVariant = keyof typeof VARIANTS;

const RTL_VARIANTS: TextVariant[] = ["arTitle", "arBody", "arSmall"];

const COLOR_CLASS =
  /(^|\s)text-(ink|ink-2|ink-3|accent|on-accent|danger|ok|warn|mark|bg|surface)(\s|$)/;

export const T = ({
  variant = "body",
  className = "",
  style,
  ...rest
}: TextProps & { variant?: TextVariant; className?: string }) => {
  const rtl = RTL_VARIANTS.includes(variant);
  // Class order doesn't decide precedence in NativeWind, so drop the variant's
  // font/color when the caller overrides them instead of stacking both.
  const overridesFont = /(^|\s)font-/.test(className);
  const overridesColor = COLOR_CLASS.test(className);
  const base = VARIANTS[variant]
    .split(" ")
    .filter((cls) => !(overridesFont && cls.startsWith("font-")))
    .join(" ");
  return (
    <Text
      className={`${overridesColor ? "" : "text-ink"} ${base} ${className}`}
      style={[rtl ? { writingDirection: "rtl" } : null, style]}
      {...rest}
    />
  );
};

/* ------------------------------------------------------------------ */
/* Buttons                                                             */
/* ------------------------------------------------------------------ */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const BUTTON_BG: Record<ButtonVariant, string> = {
  primary: "bg-accent",
  secondary: "bg-surface-2",
  ghost: "bg-transparent",
  danger: "bg-danger-soft",
};

export const Button = ({
  label,
  onPress,
  variant = "primary",
  size = "md",
  icon,
  loading = false,
  disabled = false,
  className = "",
  pill = false,
}: {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  size?: "md" | "sm";
  icon?: IconName;
  loading?: boolean;
  disabled?: boolean;
  className?: string;
  pill?: boolean;
}) => {
  const c = useColors();
  const fg = {
    primary: c.onAccent,
    secondary: c.ink,
    ghost: c.accent,
    danger: c.danger,
  }[variant];
  const height = size === "md" ? "h-12 px-5" : "h-9 px-3.5";
  const iconSize = size === "md" ? 18 : 16;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      className={`flex-row items-center justify-center gap-2 ${pill ? "rounded-full" : "rounded-xl"} ${height} ${BUTTON_BG[variant]} active:opacity-80 ${className}`}
      style={{ opacity: disabled ? 0.4 : 1 }}
    >
      {loading ? (
        <ActivityIndicator size="small" color={fg} />
      ) : icon ? (
        <Feather name={icon} size={iconSize} color={fg} />
      ) : null}
      <Text
        className={`font-body-semibold ${size === "md" ? "text-[15px]" : "text-[13px]"}`}
        style={{ color: fg }}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  );
};

export const IconButton = ({
  icon,
  onPress,
  variant = "tonal",
  disabled = false,
  color,
}: {
  icon: IconName;
  onPress?: () => void;
  variant?: "plain" | "tonal" | "filled";
  disabled?: boolean;
  color?: string;
}) => {
  const c = useColors();
  const bg = { plain: "", tonal: "bg-surface-2", filled: "bg-accent" }[variant];
  const fg = color ?? (variant === "filled" ? c.onAccent : c.ink);
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
      className={`h-10 w-10 items-center justify-center rounded-full ${bg} active:opacity-70`}
      style={{ opacity: disabled ? 0.4 : 1 }}
    >
      <Feather name={icon} size={20} color={fg} />
    </Pressable>
  );
};

/* ------------------------------------------------------------------ */
/* Badges, chips, status                                               */
/* ------------------------------------------------------------------ */

const TONE_BG: Record<Tone, string> = {
  neutral: "bg-surface-2",
  accent: "bg-accent-soft",
  ok: "bg-ok-soft",
  warn: "bg-warn-soft",
  danger: "bg-danger-soft",
};

export const Dot = ({ color, size = 8 }: { color: string; size?: number }) => (
  <View
    style={{
      width: size,
      height: size,
      borderRadius: size / 2,
      backgroundColor: color,
    }}
  />
);

export const Badge = ({
  label,
  tone = "neutral",
  dot = true,
}: {
  label: string;
  tone?: Tone;
  dot?: boolean;
}) => {
  const c = useColors();
  const fg = tone === "neutral" ? c.ink2 : toneColor(c, tone);
  return (
    <View
      className={`h-[22px] flex-row items-center gap-1.5 self-start rounded-full px-2 ${TONE_BG[tone]}`}
    >
      {dot ? <Dot color={fg} size={6} /> : null}
      <Text className="font-body-medium text-xs" style={{ color: fg }}>
        {label}
      </Text>
    </View>
  );
};

export const StatusBadge = ({ state }: { state: FileState }) => (
  <Badge label={statusLabel[state]} tone={statusTone[state]} />
);

/** Dot + label + optional trailing text, used in list rows. */
export const StatusLine = ({
  state,
  trailing,
}: {
  state: FileState;
  trailing?: string;
}) => {
  const c = useColors();
  const color = toneColor(c, statusTone[state]);
  return (
    <View className="flex-row items-center gap-1.5">
      <Dot color={color} size={6} />
      <Text className="font-body-medium text-xs" style={{ color }}>
        {statusLabel[state]}
      </Text>
      {trailing ? (
        <Text className="font-body text-xs text-ink-3">{trailing}</Text>
      ) : null}
    </View>
  );
};

export const Chip = ({
  label,
  selected = false,
  removable = false,
  onPress,
  rtl = false,
}: {
  label: string;
  selected?: boolean;
  removable?: boolean;
  onPress?: () => void;
  rtl?: boolean;
}) => {
  const c = useColors();
  const tone = removable
    ? "border-accent-soft bg-accent-soft"
    : selected
      ? "border-ink bg-ink"
      : "border-line bg-surface";
  const fg = removable ? c.accent : selected ? c.bg : c.ink2;
  return (
    <Pressable
      onPress={onPress}
      className={`h-[34px] flex-row items-center gap-1.5 rounded-full border px-3.5 active:opacity-70 ${tone}`}
    >
      {selected && !removable ? (
        <Feather name="check" size={14} color={fg} />
      ) : null}
      <Text
        className={`${rtl ? "font-ar-medium" : "font-body-medium"} text-[13px]`}
        style={{ color: fg }}
        numberOfLines={1}
      >
        {label}
      </Text>
      {removable ? <Feather name="x" size={14} color={fg} /> : null}
    </Pressable>
  );
};

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

export const FieldLabel = ({ children }: { children: ReactNode }) => (
  <T variant="overline" className="text-ink-3">
    {children}
  </T>
);

export const TextField = ({
  label,
  helper,
  error,
  rtl = false,
  multiline = false,
  className = "",
  ...input
}: TextInputProps & {
  label?: string;
  helper?: string;
  error?: string | null;
  rtl?: boolean;
  className?: string;
}) => {
  const c = useColors();
  return (
    <View className={`gap-2 ${className}`}>
      {label ? <FieldLabel>{label}</FieldLabel> : null}
      <View
        className={`flex-row items-center gap-2 rounded-xl border bg-surface px-3.5 ${error ? "border-danger" : "border-line"} ${multiline ? "min-h-[92px] py-3" : "h-[50px]"}`}
      >
        <Input
          placeholderTextColor={c.ink3}
          multiline={multiline}
          className={`flex-1 text-ink ${rtl ? "font-ar text-[17px]" : "font-body text-[15px]"}`}
          style={[
            rtl ? { writingDirection: "rtl", textAlign: "right" } : null,
            multiline ? { textAlignVertical: "top" } : null,
          ]}
          {...input}
        />
        {error ? (
          <Feather name="alert-circle" size={18} color={c.danger} />
        ) : null}
      </View>
      {error ? (
        <T variant="caption" className="font-body text-danger">
          {error}
        </T>
      ) : helper ? (
        <T variant="caption" className="font-body text-ink-3">
          {helper}
        </T>
      ) : null}
    </View>
  );
};

const ARABIC = /[\u0600-\u06FF]/;

export const SearchField = ({
  value,
  onChangeText,
  placeholder,
  autoFocus,
  onSubmitEditing,
}: {
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  onSubmitEditing?: () => void;
}) => {
  const c = useColors();
  return (
    <View className="h-[46px] flex-row items-center gap-2.5 rounded-xl bg-surface-2 px-3.5">
      <Feather name="search" size={18} color={c.ink3} />
      <Input
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={c.ink3}
        autoFocus={autoFocus}
        autoCorrect={false}
        autoCapitalize="none"
        returnKeyType="search"
        onSubmitEditing={onSubmitEditing}
        // Naskh's tall line metrics push Latin text (and the English
        // placeholder) off the icon's centre line; only use it for Arabic.
        className={`h-full flex-1 text-ink ${ARABIC.test(value) ? "font-ar text-[16px]" : "font-body text-[15px]"}`}
        style={{
          writingDirection: "auto",
          paddingVertical: 0,
          includeFontPadding: false,
          textAlignVertical: "center",
        }}
      />
      {value ? (
        <Pressable onPress={() => onChangeText("")} hitSlop={8}>
          <Feather name="x-circle" size={18} color={c.ink3} />
        </Pressable>
      ) : null}
    </View>
  );
};

export const FLOAT_SHADOW: ViewStyle = {
  shadowColor: "#000",
  shadowOpacity: 0.12,
  shadowRadius: 16,
  shadowOffset: { width: 0, height: 6 },
  elevation: 6,
};

export const Segmented = <V extends string>({
  options,
  value,
  onChange,
  pill = false,
  floating = false,
}: {
  options: { value: V; label: string }[];
  value: V;
  onChange: (value: V) => void;
  pill?: boolean;
  /** Raised control over content (e.g. a bottom toolbar) instead of inset. */
  floating?: boolean;
}) => (
  <View
    className={`flex-row gap-0.5 ${floating ? "border border-line bg-surface p-1" : "bg-surface-2 p-[3px]"} ${pill ? "rounded-full" : "rounded-xl"}`}
    style={floating ? FLOAT_SHADOW : undefined}
  >
    {options.map((o) => {
      const on = o.value === value;
      return (
        <Pressable
          key={o.value}
          onPress={() => onChange(o.value)}
          className={`flex-1 items-center justify-center ${floating ? "h-10" : "h-8"} ${pill ? "rounded-full" : "rounded-lg"} ${on ? (floating ? "bg-surface-2" : "bg-surface") : ""}`}
          style={
            on && !floating
              ? {
                  shadowColor: "#000",
                  shadowOpacity: 0.06,
                  shadowRadius: 2,
                  shadowOffset: { width: 0, height: 1 },
                  elevation: 1,
                }
              : null
          }
        >
          <Text
            className={`font-body-medium text-[13px] ${on ? "text-ink" : "text-ink-2"}`}
          >
            {o.label}
          </Text>
        </Pressable>
      );
    })}
  </View>
);

/* ------------------------------------------------------------------ */
/* Progress                                                            */
/* ------------------------------------------------------------------ */

export const ProgressBar = ({
  value,
  tone = "accent",
  height = 6,
}: {
  value: number;
  tone?: Exclude<Tone, "neutral">;
  height?: number;
}) => {
  const c = useColors();
  return (
    <View
      className="w-full overflow-hidden rounded-full bg-surface-2"
      style={{ height }}
    >
      <View
        className="h-full rounded-full"
        style={{
          width: `${Math.max(0, Math.min(1, value)) * 100}%`,
          backgroundColor: c[tone],
        }}
      />
    </View>
  );
};

export const ProgressRing = ({
  value,
  tone = "accent",
  size = 50,
}: {
  value: number;
  tone?: Exclude<Tone, "neutral">;
  size?: number;
}) => {
  const c = useColors();
  const stroke = 4;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(1, value));
  const done = clamped >= 1;
  return (
    <View
      style={{ width: size, height: size }}
      className="items-center justify-center"
    >
      <Svg
        width={size}
        height={size}
        style={{ position: "absolute", transform: [{ rotate: "-90deg" }] }}
      >
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={c.surface2}
          strokeWidth={stroke}
          fill="none"
        />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={c[tone]}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${circumference} ${circumference}`}
          strokeDashoffset={circumference * (1 - clamped)}
        />
      </Svg>
      {done ? (
        <Feather name="check" size={18} color={c[tone]} />
      ) : (
        <Text className="font-body-bold text-[11px] text-ink">
          {Math.round(clamped * 100)}%
        </Text>
      )}
    </View>
  );
};

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

export const Card = ({
  children,
  className = "",
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: ViewStyle;
}) => (
  <View
    className={`rounded-2xl border border-line bg-surface ${className}`}
    style={style}
  >
    {children}
  </View>
);

/** Card holding divided rows (pass rows as children; each row draws its own divider). */
export const ListCard = ({ children }: { children: ReactNode }) => (
  <View className="rounded-2xl border border-line bg-surface px-4">
    {children}
  </View>
);

export const Divider = () => <View className="h-px bg-line" />;

export const ListRow = ({
  icon,
  title,
  subtitle,
  value,
  onPress,
  danger = false,
  chevron = false,
}: {
  icon?: IconName;
  title: string;
  subtitle?: string;
  value?: string;
  onPress?: () => void;
  danger?: boolean;
  chevron?: boolean;
}) => {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center gap-3 px-4 py-3 active:bg-surface-2"
    >
      {icon ? (
        <View
          className={`h-9 w-9 items-center justify-center rounded-lg ${danger ? "bg-danger-soft" : "bg-surface-2"}`}
        >
          <Feather name={icon} size={18} color={danger ? c.danger : c.ink2} />
        </View>
      ) : null}
      <View className="flex-1">
        <T className={danger ? "text-danger" : ""}>{title}</T>
        {subtitle ? (
          <T variant="small" className="text-ink-3">
            {subtitle}
          </T>
        ) : null}
      </View>
      {value ? (
        <T variant="small" className="text-ink-3">
          {value}
        </T>
      ) : null}
      {chevron ? (
        <Feather name="chevron-right" size={18} color={c.ink3} />
      ) : null}
    </Pressable>
  );
};

/** Screen header: back/close on the left, optional title, actions on the right. */
export const Header = ({
  title,
  subtitle,
  left = "chevron-left",
  onLeft,
  right,
  serif = true,
}: {
  title?: string;
  subtitle?: string;
  left?: IconName | null;
  onLeft?: () => void;
  right?: ReactNode;
  serif?: boolean;
}) => (
  <View className="flex-row items-center gap-3 px-5 pb-2.5 pt-1.5">
    {left ? <IconButton icon={left} onPress={onLeft} /> : null}
    <View className="flex-1">
      {title ? (
        <T variant={serif ? "title" : "bodyStrong"} numberOfLines={1}>
          {title}
        </T>
      ) : null}
      {subtitle ? (
        <T variant="caption" className="font-body text-ink-3">
          {subtitle}
        </T>
      ) : null}
    </View>
    {right}
  </View>
);

/** Bottom action area with a top border and safe-area padding. */
export const ActionBar = ({ children }: { children: ReactNode }) => {
  const insets = useSafeAreaInsets();
  return (
    <View
      className="gap-2.5 border-t border-line bg-surface px-6 pt-3"
      style={{ paddingBottom: insets.bottom + 12 }}
    >
      {children}
    </View>
  );
};

export const Loading = () => {
  const c = useColors();
  return (
    <View className="flex-1 items-center justify-center">
      <ActivityIndicator color={c.accent} />
    </View>
  );
};

export const EmptyState = ({
  icon,
  title,
  body,
  action,
}: {
  icon: IconName;
  title: string;
  body?: string;
  action?: ReactNode;
}) => {
  const c = useColors();
  return (
    <View className="items-center gap-2.5 px-6">
      <View className="mb-1 h-[72px] w-[72px] items-center justify-center rounded-full bg-accent-soft">
        <Feather name={icon} size={30} color={c.accent} />
      </View>
      <T variant="title" className="text-center">
        {title}
      </T>
      {body ? <T className="text-center text-ink-2">{body}</T> : null}
      {action ? <View className="mt-1.5">{action}</View> : null}
    </View>
  );
};

/** Faux scanned page, used where a real scan isn't available (art, placeholders). */
export const PagePlaceholder = ({
  width,
  height,
  lines = 9,
}: {
  width: number;
  height: number;
  lines?: number;
}) => {
  const widths = [70, 92, 88, 95, 60, 90, 84, 93, 78, 66, 90, 88];
  return (
    <View
      className="overflow-hidden rounded-md bg-paper"
      style={{
        width,
        height,
        paddingVertical: Math.max(6, height / 9),
        paddingHorizontal: Math.max(5, width / 9),
        gap: Math.max(3, height / 22),
      }}
    >
      <View
        className="self-center rounded-sm bg-paper-ink"
        style={{ width: "40%", height: Math.max(3, height / 26) }}
      />
      {Array.from({ length: lines }, (_, i) => (
        <View
          // biome-ignore lint/suspicious/noArrayIndexKey: static decoration
          key={i}
          className="self-end rounded-sm bg-paper-ink opacity-70"
          style={{
            width: `${widths[i % widths.length]}%`,
            height: Math.max(2, height / 40),
          }}
        />
      ))}
    </View>
  );
};

/* ------------------------------------------------------------------ */
/* Overlays                                                            */
/* ------------------------------------------------------------------ */

const InSheetContext = createContext(false);

/**
 * Text input that cooperates with the bottom sheet's keyboard handling when
 * rendered inside a Sheet, and is a plain TextInput elsewhere.
 */
export const Input = forwardRef<TextInput, TextInputProps>((props, ref) => {
  const inSheet = useContext(InSheetContext);
  if (inSheet)
    return (
      <BottomSheetTextInput
        ref={ref as Ref<never>}
        {...(props as ComponentProps<typeof BottomSheetTextInput>)}
      />
    );
  return <TextInput ref={ref} {...props} />;
});

/**
 * Bottom sheet (drawer) used by every screen: grab handle, title, optional
 * close. Drag down, tap the backdrop or press back to close. Set `scrollable`
 * when the content can be taller than the screen.
 */
export const Sheet = ({
  visible,
  onClose,
  title,
  children,
  showClose = true,
  scrollable = false,
  tall = false,
  stickyContent,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  showClose?: boolean;
  scrollable?: boolean;
  /** Fixed near-full height, for lists whose length changes (e.g. filtered). */
  tall?: boolean;
  /** Pinned under the title while the content scrolls (e.g. a search bar). */
  stickyContent?: ReactNode;
}) => {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const ref = useRef<BottomSheetModal>(null);

  // Keep showing the last content while the sheet animates closed, since
  // callers usually clear the state that produced it.
  const shown = useRef({ title, children, stickyContent });
  if (visible) shown.current = { title, children, stickyContent };

  // Only dismiss a sheet that was presented: dismissing a never-presented
  // BottomSheetModal leaves it stuck "dismissing", and it then never renders.
  const presented = useRef(false);
  useEffect(() => {
    if (visible) {
      presented.current = true;
      ref.current?.present();
    } else if (presented.current) {
      presented.current = false;
      ref.current?.dismiss();
    }
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [visible, onClose]);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        pressBehavior="close"
        opacity={1}
        style={[props.style, { backgroundColor: c.scrim }]}
      />
    ),
    [c.scrim],
  );

  const header = (
    <View className="flex-row items-center px-5 pb-2 pt-1">
      <T variant="heading" className="flex-1" numberOfLines={1}>
        {shown.current.title}
      </T>
      {showClose ? (
        <Pressable onPress={onClose} hitSlop={10}>
          <Feather name="x" size={20} color={c.ink2} />
        </Pressable>
      ) : null}
    </View>
  );
  const sticky = shown.current.stickyContent ? (
    <View className="px-5 pb-3">{shown.current.stickyContent}</View>
  ) : null;
  const bottomPad = { paddingBottom: insets.bottom + 12 };

  return (
    <BottomSheetModal
      ref={ref}
      stackBehavior="push"
      enableDynamicSizing={!tall}
      snapPoints={tall ? ["92%"] : undefined}
      onDismiss={() => {
        // Dismissed by drag, backdrop or back: it's already closed, so the
        // effect must not dismiss it again when `visible` turns false.
        presented.current = false;
        if (visible) onClose();
      }}
      backdropComponent={renderBackdrop}
      backgroundStyle={{
        backgroundColor: c.surface,
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
      }}
      handleIndicatorStyle={{ backgroundColor: c.line, width: 36, height: 5 }}
      topInset={insets.top + 24}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
    >
      <InSheetContext.Provider value={true}>
        {scrollable ? (
          <BottomSheetScrollView
            stickyHeaderIndices={[0]}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={bottomPad}
          >
            <View className="bg-surface">
              {header}
              {sticky}
            </View>
            {shown.current.children}
          </BottomSheetScrollView>
        ) : (
          <BottomSheetView style={bottomPad}>
            {header}
            {sticky}
            {shown.current.children}
          </BottomSheetView>
        )}
      </InSheetContext.Provider>
    </BottomSheetModal>
  );
};

/** Centered dialog for confirmations and small inputs. */
export const Dialog = ({
  visible,
  onClose,
  title,
  message,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  message?: string;
  children: ReactNode;
}) => {
  const c = useColors();
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable
        className="flex-1 justify-center px-7"
        style={{ backgroundColor: c.scrim }}
        onPress={onClose}
      >
        <Pressable
          onPress={() => {}}
          className="gap-4 rounded-3xl bg-surface p-6"
        >
          <View className="gap-1.5">
            <T variant="heading">{title}</T>
            {message ? (
              <T variant="small" className="text-ink-2">
                {message}
              </T>
            ) : null}
          </View>
          {children}
        </Pressable>
      </Pressable>
    </Modal>
  );
};
