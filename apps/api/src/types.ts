import type { AuditableLogger } from "evlog";
import type { Context } from "hono";
import { z } from "zod";

// `log` is the request's wide event (see logging.ts).
export type AppEnv = { Bindings: Env; Variables: { log: AuditableLogger } };
export type AppContext = Context<AppEnv>;

// Which provider transcribes a book's pages first; the other is the fallback on
// a transient failure. A book with no engine set uses Inkling.
export const OcrEngine = z.enum(["inkling", "claude"]);
export type OcrEngine = z.infer<typeof OcrEngine>;

// A book: top-level collection of scanned files. Pages are derived at assembly
// time (locally), not stored — see migrations/0001_init_schema.sql.
export const Book = z.object({
  id: z.string(),
  title: z.string().openapi({ example: "كتاب التوحيد" }),
  created_at: z.number().int(),
  work_id: z
    .string()
    .nullable()
    .optional()
    .describe("The work this copy belongs to; null = ungrouped/standalone"),
  ocr_instructions: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Book-specific OCR notes appended to the global system prompt at transcription time",
    ),
  ocr_engine: OcrEngine.nullable()
    .optional()
    .describe(
      "Provider that OCRs this book first (the other is the fallback); null = default (inkling)",
    ),
  paused: z
    .boolean()
    .optional()
    .describe(
      "OCR paused for this book: its pages wait in 'queued' until resumed",
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
  ocr_engine: OcrEngine.nullable()
    .optional()
    .describe(
      "Provider that OCRs this book first (the other is the fallback); omitted or null = default (inkling)",
    ),
  work_id: z
    .string()
    .optional()
    .describe(
      "Attach this copy to an existing work; if omitted a work is auto-created from the title",
    ),
  tags: z
    .array(z.string())
    .optional()
    .describe(
      "Tags for the auto-created work (created on write); ignored when work_id is given",
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
    ocr_engine: OcrEngine.nullable().describe(
      "Provider that OCRs this book first; null resets to the default (inkling). Does not re-OCR existing pages",
    ),
    work_id: z
      .string()
      .nullable()
      .describe("Reassign this copy to a work; null unlinks it (flat)"),
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
  "rate_limited", // transient OCR 429/5xx — awaiting an automatic re-queue
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

// Content types we accept for an uploaded page fragment. Raster images only:
// neither OCR provider reads PDFs (see ocr.ts).
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
  // When the text was last edited by hand (epoch ms); null if never.
  text_edited_at: z.number().int().nullable(),
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

// A tag (subject/genre). Shared across works via the work_tags join.
export const Tag = z.object({
  id: z.string(),
  name: z.string().openapi({ example: "فقه" }),
});

// A work: the abstract book. A book row is one copy of a work; copies of the
// same work share a work_id. See migrations/0003_add_works_and_tags.sql.
export const Work = z.object({
  id: z.string(),
  name: z.string().openapi({ example: "المغني" }),
  author: z.string().nullable().optional().openapi({ example: "ابن قدامة" }),
  created_at: z.number().int(),
  tags: z.array(z.string()).describe("Tag names attached to this work"),
});

// Work plus a count of its copies (the library group header).
export const WorkWithCounts = Work.extend({
  copies_total: z
    .number()
    .int()
    .describe("Number of book copies under this work"),
});

export const WorkCreateBody = z.object({
  name: z.string().min(1).openapi({ example: "المغني" }),
  author: z.string().optional(),
  tags: z
    .array(z.string())
    .optional()
    .describe("Tag names; created on write if new"),
  id: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .optional()
    .describe("Optional explicit slug id; a UUID is generated if omitted"),
});

// PATCH body: only provided fields are updated. tags replaces the full set.
export const WorkUpdateBody = z
  .object({
    name: z.string().min(1),
    author: z.string().nullable().describe("null clears the author"),
    tags: z
      .array(z.string())
      .describe(
        "Replaces the work's full tag set; tags created on write if new",
      ),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, {
    message: "At least one field must be provided",
  });

// How to treat a work's copies when the work is deleted.
export const WorkDeleteMode = z
  .enum(["unlink", "delete"])
  .describe(
    "unlink: keep copies, set their work_id NULL (flat); delete: cascade-delete every copy (D1 + R2 + Meili)",
  );

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
