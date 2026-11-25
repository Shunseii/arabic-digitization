import type { FileState } from "@qiraa/shared";
import type { Tone } from "@/components/ui";

export const statusTone: Record<FileState, Tone> = {
  captured: "neutral",
  queued: "accent",
  processing: "accent",
  rate_limited: "warn",
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

// TEMP(migration): old palette names still used by routes not yet redesigned.
export const colors = {
  accent: "var(--accent)",
  textSecondary: "var(--ink-2)",
  textMuted: "var(--ink-3)",
  hairline: "var(--line)",
  border: "var(--line)",
  ink: "var(--ink)",
  surface: "var(--surface)",
  surfaceAlt: "var(--surface-2)",
  bg: "var(--bg)",
  accentInk: "var(--on-accent)",
  accentSoft: "var(--accent-soft)",
} as const;
export const statusColors: Record<FileState, string> = statusLabel;
