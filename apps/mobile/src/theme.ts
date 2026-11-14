import type { FileState } from "@qiraa/shared";
import { vars } from "nativewind";
import { useColorScheme } from "react-native";

/**
 * Design tokens. Mirrors apps/mobile/src/tokens.css (the lamsa token source,
 * see designs/qiraa*.lamsa.json). Hex values here are the single source for JS
 * (icon colors, SVG); Tailwind classes read the same values via CSS variables.
 */
const light = {
  bg: "#f5f0e6",
  surface: "#fffcf6",
  surface2: "#ede5d6",
  scrim: "rgba(27, 23, 18, 0.45)",
  ink: "#1b1712",
  ink2: "#554d42",
  ink3: "#8a8173",
  line: "#e0d6c4",
  accent: "#26479a",
  accentSoft: "#e2e7f4",
  onAccent: "#ffffff",
  mark: "#b0802b",
  ok: "#2c7a52",
  okSoft: "#dcefe3",
  warn: "#a8701c",
  warnSoft: "#f6e8cf",
  danger: "#b03c2c",
  dangerSoft: "#f6dcd6",
  paper: "#fbf6ea",
  paperInk: "#9d9384",
};

const dark: typeof light = {
  bg: "#0f0e0c",
  surface: "#191714",
  surface2: "#24211c",
  scrim: "rgba(0, 0, 0, 0.6)",
  ink: "#f2ece1",
  ink2: "#b4ab9b",
  ink3: "#7b7366",
  line: "#2f2b25",
  accent: "#91a8e8",
  accentSoft: "#1d2438",
  onAccent: "#0e1324",
  mark: "#d9ad5c",
  ok: "#5cc28d",
  okSoft: "#15291e",
  warn: "#e3b25a",
  warnSoft: "#2d2412",
  danger: "#ee7c67",
  dangerSoft: "#331a15",
  paper: "#fbf6ea",
  paperInk: "#9d9384",
};

export type Palette = typeof light;
export const palettes = { light, dark };

const channels = (hex: string): string => {
  const n = Number.parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
};

const toVars = (p: Palette) =>
  vars({
    "--bg": channels(p.bg),
    "--surface": channels(p.surface),
    "--surface-2": channels(p.surface2),
    "--ink": channels(p.ink),
    "--ink-2": channels(p.ink2),
    "--ink-3": channels(p.ink3),
    "--line": channels(p.line),
    "--accent": channels(p.accent),
    "--accent-soft": channels(p.accentSoft),
    "--on-accent": channels(p.onAccent),
    "--mark": channels(p.mark),
    "--ok": channels(p.ok),
    "--ok-soft": channels(p.okSoft),
    "--warn": channels(p.warn),
    "--warn-soft": channels(p.warnSoft),
    "--danger": channels(p.danger),
    "--danger-soft": channels(p.dangerSoft),
    "--paper": channels(p.paper),
    "--paper-ink": channels(p.paperInk),
  });

export const themeVars = { light: toVars(light), dark: toVars(dark) };

export const useIsDark = (): boolean => useColorScheme() === "dark";

/** Current palette for JS-side colors (icons, SVG, native props). */
export const useColors = (): Palette => (useIsDark() ? dark : light);

export type Tone = "neutral" | "accent" | "ok" | "warn" | "danger";

export const statusTone: Record<FileState, Tone> = {
  captured: "neutral",
  queued: "neutral",
  processing: "accent",
  rate_limited: "accent",
  done: "ok",
  needs_review: "warn",
  approved: "ok",
  failed: "danger",
};

export const statusLabel: Record<FileState, string> = {
  captured: "captured",
  queued: "queued",
  processing: "processing",
  rate_limited: "retrying",
  done: "done",
  needs_review: "review",
  approved: "approved",
  failed: "failed",
};

export const toneColor = (p: Palette, tone: Tone): string =>
  tone === "neutral" ? p.ink3 : p[tone];

export const toneSoft = (p: Palette, tone: Tone): string =>
  ({
    neutral: p.surface2,
    accent: p.accentSoft,
    ok: p.okSoft,
    warn: p.warnSoft,
    danger: p.dangerSoft,
  })[tone];
