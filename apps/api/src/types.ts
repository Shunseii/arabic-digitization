import type { Context } from "hono";
import { z } from "zod";

export type AppContext = Context<{ Bindings: Env }>;

// A book: top-level collection of scanned files. Pages are derived at assembly
// time (locally), not stored — see migrations/0001_init_schema.sql.
export const Book = z.object({
  id: z.string(),
  title: z.string().openapi({ example: "كتاب التوحيد" }),
  created_at: z.number().int(),
  ocr_instructions: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Book-specific OCR notes appended to the global system prompt at transcription time",
    ),
});

export const BookCreateBody = z.object({
  title: z.string().min(1).openapi({ example: "كتاب التوحيد" }),
  id: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .optional()
    .describe("Optional explicit slug id; a UUID is generated if omitted"),
  ocr_instructions: z
    .string()
    .optional()
    .describe(
      "Optional book-specific OCR notes appended to the global system prompt",
    ),
});

// PATCH body: every field optional; only provided fields are updated.
export const BookUpdateBody = z
  .object({
    title: z.string().min(1).openapi({ example: "كتاب التوحيد" }),
    ocr_instructions: z
      .string()
      .nullable()
      .describe(
        "Book-specific OCR notes appended to the global system prompt; null clears them",
      ),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, {
    message: "At least one field must be provided",
  });

// File states a page-fragment moves through.
export const FileState = z.enum([
  "captured",
  "queued",
  "processing",
  "rate_limited", // transient Gemini 429/5xx — awaiting an automatic re-queue
  "done",
  "needs_review",
  "approved",
  "failed",
]);

// Book plus a count of its files broken down by state (the dashboard summary).
export const BookWithStatus = Book.extend({
  files_total: z.number().int(),
  counts: z
    .record(z.string(), z.number().int())
    .describe("File count keyed by state (only present states appear)"),
  // Aggregate OCR usage across the book's done pages; null if none have usage
  // data yet. cost_usd is null if any contributing model lacks a known price.
  usage: z
    .object({
      input_tokens: z.number().int(),
      output_tokens: z.number().int(),
      cost_usd: z.number().nullable(),
    })
    .nullable()
    .optional(),
});

// Content types we accept for an uploaded page fragment.
export const UPLOAD_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

// Per-file status row (no heavy text), for the status endpoint.
export const FileStatus = z.object({
  file_id: z.string(),
  page_number: z.number().int().nullable(),
  state: FileState,
  role: z.string().nullable(),
  order_hint: z.number().int().nullable(),
  preview: z.string().nullable(),
  error: z.string().nullable(),
  updated_at: z.number().int(),
  // OCR usage. Null for pages OCR'd before usage tracking, or not yet done.
  // cost_usd is derived (tokens x model price); null if the model has no price.
  input_tokens: z.number().int().nullable(),
  output_tokens: z.number().int().nullable(),
  cost_usd: z.number().nullable(),
});

// One file in a bulk export: metadata + the transcribed text (null if none yet).
export const ExportFile = z.object({
  file_id: z.string(),
  page_number: z.number().int().nullable(),
  role: z.string().nullable(),
  order_hint: z.number().int().nullable(),
  state: FileState,
  text: z.string().nullable(),
});

// A stored file (page fragment). Mirrors the `files` table.
export const FileRecord = z.object({
  file_id: z.string(),
  book_id: z.string(),
  r2_key: z.string(),
  state: FileState,
  text_key: z.string().nullable(),
  page_number: z.number().int().nullable(),
  role: z.string().nullable(),
  order_hint: z.number().int().nullable(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});
