import { Schema } from "effect";

// Which provider transcribes a book's pages first; the other is the fallback on
// a transient failure. A book with no engine set uses Inkling.
export const OcrEngine = Schema.Literals(["inkling", "claude"]);
export type OcrEngine = typeof OcrEngine.Type;

const Slug = Schema.String.check(Schema.isPattern(/^[a-z0-9-]+$/));
const NonEmptyString = Schema.String.check(Schema.isMinLength(1));

// Every PATCH body: only the provided fields are updated, and at least one
// must be provided.
const atLeastOneField = Schema.makeFilter(
  (body: object) =>
    Object.keys(body).length > 0 || "At least one field must be provided",
);

// A book: top-level collection of scanned files. Pages are derived at assembly
// time (locally), not stored — see migrations/0001_init_schema.sql.
export const Book = Schema.Struct({
  id: Schema.String,
  title: Schema.String.annotate({ examples: ["كتاب التوحيد"] }),
  created_at: Schema.Int,
  work_id: Schema.optionalKey(Schema.NullOr(Schema.String)).annotate({
    description: "The work this copy belongs to; null = ungrouped/standalone",
  }),
  ocr_instructions: Schema.optionalKey(Schema.NullOr(Schema.String)).annotate({
    description:
      "Book-specific OCR notes appended to the global system prompt at transcription time",
  }),
  ocr_engine: Schema.optionalKey(Schema.NullOr(OcrEngine)).annotate({
    description:
      "Provider that OCRs this book first (the other is the fallback); null = default (inkling)",
  }),
  paused: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      "OCR paused for this book: its pages wait in 'queued' until resumed",
  }),
});

export const BookCreateBody = Schema.Struct({
  title: NonEmptyString.annotate({ examples: ["كتاب التوحيد"] }),
  id: Schema.optionalKey(Slug).annotate({
    description: "Optional explicit slug id; a UUID is generated if omitted",
  }),
  ocr_instructions: Schema.optionalKey(Schema.String).annotate({
    description:
      "Optional book-specific OCR notes appended to the global system prompt",
  }),
  ocr_engine: Schema.optionalKey(Schema.NullOr(OcrEngine)).annotate({
    description:
      "Provider that OCRs this book first (the other is the fallback); omitted or null = default (inkling)",
  }),
  work_id: Schema.optionalKey(Schema.String).annotate({
    description:
      "Attach this copy to an existing work; if omitted a work is auto-created from the title",
  }),
  tags: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description:
      "Tags for the auto-created work (created on write); ignored when work_id is given",
  }),
});

export const BookUpdateBody = Schema.Struct({
  title: Schema.optionalKey(
    NonEmptyString.annotate({ examples: ["كتاب التوحيد"] }),
  ),
  ocr_instructions: Schema.optionalKey(Schema.NullOr(Schema.String)).annotate({
    description:
      "Book-specific OCR notes appended to the global system prompt; null clears them",
  }),
  ocr_engine: Schema.optionalKey(Schema.NullOr(OcrEngine)).annotate({
    description:
      "Provider that OCRs this book first; null resets to the default (inkling). Does not re-OCR existing pages",
  }),
  work_id: Schema.optionalKey(Schema.NullOr(Schema.String)).annotate({
    description: "Reassign this copy to a work; null unlinks it (flat)",
  }),
}).check(atLeastOneField);

// File states a page-fragment moves through.
export const FileState = Schema.Literals([
  "captured",
  "queued",
  "processing",
  "rate_limited", // transient OCR 429/5xx — awaiting an automatic re-queue
  "done",
  "needs_review",
  "approved",
  "failed",
]);
export type FileState = typeof FileState.Type;

// Aggregate OCR usage across the book's done pages; null if none have usage
// data yet. cost_usd is null if any contributing model lacks a known price.
const BookUsage = Schema.NullOr(
  Schema.Struct({
    input_tokens: Schema.Int,
    output_tokens: Schema.Int,
    cost_usd: Schema.NullOr(Schema.Number),
  }),
);

// Book plus a count of its files broken down by state (the dashboard summary).
export const BookWithStatus = Schema.Struct({
  ...Book.fields,
  files_total: Schema.Int,
  counts: Schema.Record(Schema.String, Schema.Int).annotate({
    description: "File count keyed by state (only present states appear)",
  }),
  usage: Schema.optionalKey(BookUsage),
});
export type BookWithStatus = typeof BookWithStatus.Type;

// Content types we accept for an uploaded page fragment. Raster images only:
// neither OCR provider reads PDFs (see ocr.ts).
export const UPLOAD_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

// Per-file status row (no heavy text), for the status endpoint.
export const FileStatus = Schema.Struct({
  file_id: Schema.String,
  page_number: Schema.NullOr(Schema.Int),
  state: FileState,
  role: Schema.NullOr(Schema.String),
  order_hint: Schema.NullOr(Schema.Int),
  preview: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  updated_at: Schema.Int,
  // When the text was last edited by hand (epoch ms); null if never.
  text_edited_at: Schema.NullOr(Schema.Int),
  // OCR usage. Null for pages OCR'd before usage tracking, or not yet done.
  // cost_usd is derived (tokens x model price); null if the model has no price.
  input_tokens: Schema.NullOr(Schema.Int),
  output_tokens: Schema.NullOr(Schema.Int),
  cost_usd: Schema.NullOr(Schema.Number),
});
export type FileStatus = typeof FileStatus.Type;

// One file in a bulk export: metadata + the transcribed text (null if none yet).
export const ExportFile = Schema.Struct({
  file_id: Schema.String,
  page_number: Schema.NullOr(Schema.Int),
  role: Schema.NullOr(Schema.String),
  order_hint: Schema.NullOr(Schema.Int),
  state: FileState,
  text: Schema.NullOr(Schema.String),
});

// A tag (subject/genre). Shared across works via the work_tags join.
export const Tag = Schema.Struct({
  id: Schema.String,
  name: Schema.String.annotate({ examples: ["فقه"] }),
});

// A work: the abstract book. A book row is one copy of a work; copies of the
// same work share a work_id. See migrations/0003_add_works_and_tags.sql.
export const Work = Schema.Struct({
  id: Schema.String,
  name: Schema.String.annotate({ examples: ["المغني"] }),
  author: Schema.optionalKey(
    Schema.NullOr(Schema.String.annotate({ examples: ["ابن قدامة"] })),
  ),
  created_at: Schema.Int,
  tags: Schema.Array(Schema.String).annotate({
    description: "Tag names attached to this work",
  }),
});

// Work plus a count of its copies (the library group header).
export const WorkWithCounts = Schema.Struct({
  ...Work.fields,
  copies_total: Schema.Int.annotate({
    description: "Number of book copies under this work",
  }),
});

export const WorkCreateBody = Schema.Struct({
  name: NonEmptyString.annotate({ examples: ["المغني"] }),
  author: Schema.optionalKey(Schema.String),
  tags: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "Tag names; created on write if new",
  }),
  id: Schema.optionalKey(Slug).annotate({
    description: "Optional explicit slug id; a UUID is generated if omitted",
  }),
});

export const WorkUpdateBody = Schema.Struct({
  name: Schema.optionalKey(NonEmptyString),
  author: Schema.optionalKey(Schema.NullOr(Schema.String)).annotate({
    description: "null clears the author",
  }),
  tags: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description:
      "Replaces the work's full tag set; tags created on write if new",
  }),
}).check(atLeastOneField);

// How to treat a work's copies when the work is deleted.
export const WorkDeleteMode = Schema.Literals(["unlink", "delete"]).annotate({
  description:
    "unlink: keep copies, set their work_id NULL (flat); delete: cascade-delete every copy (D1 + R2 + Meili)",
});

// A stored file (page fragment). Mirrors the `files` table.
export const FileRecord = Schema.Struct({
  file_id: Schema.String,
  book_id: Schema.String,
  r2_key: Schema.String,
  state: FileState,
  text_key: Schema.NullOr(Schema.String),
  page_number: Schema.NullOr(Schema.Int),
  role: Schema.NullOr(Schema.String),
  order_hint: Schema.NullOr(Schema.Int),
  created_at: Schema.Int,
  updated_at: Schema.Int,
});
export type FileRecord = typeof FileRecord.Type;
