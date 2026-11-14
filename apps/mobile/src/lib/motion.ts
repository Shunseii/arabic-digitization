import { Easing } from "react-native-reanimated";

/** Strong ease-out: quick to respond, gentle to settle. */
export const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);

export const DURATION = {
  /** Small state changes: a tile leaving, a badge swapping. */
  fast: 150,
  /** Layout shifts: tiles reflowing. */
  layout: 200,
  /** Value changes: progress filling. */
  progress: 250,
} as const;
