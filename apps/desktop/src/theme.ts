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
