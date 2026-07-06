import type { FileState } from "@qiraa/shared";

/** Design tokens — mirrors apps/../design.pen (dark OLED + manuscript gold). */
export const colors = {
  bg: "#0C0D10",
  surface: "#14161B",
  surfaceAlt: "#1C1F26",
  border: "#282C34",
  hairline: "#20242B",
  ink: "#F4F2EC",
  textSecondary: "#9D9A92",
  textMuted: "#65635D",
  accent: "#E3A63C",
  accentInk: "#14110A",
  accentSoft: "#2A2114",
} as const;

export const statusColors: Record<FileState, string> = {
  captured: "#7C786E",
  queued: "#7C786E",
  processing: "#5C8DF0",
  rate_limited: "#5C8DF0",
  done: "#46B97D",
  needs_review: "#C77DFF",
  approved: "#46B97D",
  failed: "#EE6A4D",
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
