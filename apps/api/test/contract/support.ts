// Seeding and inspection helpers for the HTTP contract tests.

import type { Harness } from "./harness";
import type { Operation } from "./worker";

export const JSON_HEADERS = { "content-type": "application/json" };

export function postJson({
  h,
  path,
  body,
  method = "POST",
}: {
  h: Harness;
  path: string;
  body?: unknown;
  method?: string;
}): Promise<Response> {
  return h.api(path, {
    method,
    headers: JSON_HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function seedBook({
  h,
  id,
  title = `Book ${id}`,
  createdAt = Date.now(),
  workId = null,
  paused = false,
  ocrInstructions = null,
  ocrEngine = null,
}: {
  h: Harness;
  id: string;
  title?: string;
  createdAt?: number;
  workId?: string | null;
  paused?: boolean;
  ocrInstructions?: string | null;
  ocrEngine?: "inkling" | "claude" | null;
}): Promise<void> {
  await h.sql([
    {
      sql: "INSERT INTO books (id, title, created_at, work_id, paused, ocr_instructions, ocr_engine) VALUES (?, ?, ?, ?, ?, ?, ?)",
      params: [
        id,
        title,
        createdAt,
        workId,
        paused ? 1 : 0,
        ocrInstructions,
        ocrEngine,
      ],
    },
  ]);
}

export async function seedWork({
  h,
  id,
  name = `Work ${id}`,
  author = null,
  createdAt = Date.now(),
  tags = [],
}: {
  h: Harness;
  id: string;
  name?: string;
  author?: string | null;
  createdAt?: number;
  tags?: string[];
}): Promise<void> {
  await h.sql([
    {
      sql: "INSERT INTO works (id, name, author, created_at) VALUES (?, ?, ?, ?)",
      params: [id, name, author, createdAt],
    },
    ...tags.flatMap((tag) => [
      {
        sql: "INSERT INTO tags (id, name) VALUES (?, ?) ON CONFLICT(name) DO NOTHING",
        params: [`tag-${tag}`, tag],
      },
      {
        sql: "INSERT INTO work_tags (work_id, tag_id) SELECT ?, id FROM tags WHERE name = ?",
        params: [id, tag],
      },
    ]),
  ]);
}

export interface SeedFile {
  fileId: string;
  state?: string;
  page?: number | null;
  role?: string | null;
  orderHint?: number | null;
  text?: string | null;
  scan?: Uint8Array;
  scanType?: string;
  preview?: string | null;
  error?: string | null;
  updatedAt?: number;
  textEditedAt?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  ocrModel?: string | null;
}

export const scanKey = ({
  bookId,
  fileId,
}: {
  bookId: string;
  fileId: string;
}) => `books/${bookId}/scans/${fileId}`;
export const textKey = ({
  bookId,
  fileId,
}: {
  bookId: string;
  fileId: string;
}) => `books/${bookId}/text/${fileId}.md`;

export function fileRowStatements({
  bookId,
  files,
}: {
  bookId: string;
  files: SeedFile[];
}): { sql: string; params: unknown[] }[] {
  return files.map((f) => ({
    sql: `INSERT INTO files (file_id, book_id, r2_key, state, text_key, page_number, role, order_hint,
            preview, error, created_at, updated_at, text_edited_at, input_tokens, output_tokens, ocr_model)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      f.fileId,
      bookId,
      scanKey({ bookId, fileId: f.fileId }),
      f.state ?? (f.text == null ? "queued" : "done"),
      f.text == null ? null : textKey({ bookId, fileId: f.fileId }),
      f.page ?? null,
      f.role ?? null,
      f.orderHint ?? null,
      f.preview ?? null,
      f.error ?? null,
      f.updatedAt ?? 1_000,
      f.updatedAt ?? 1_000,
      f.textEditedAt ?? null,
      f.inputTokens ?? null,
      f.outputTokens ?? null,
      f.ocrModel ?? null,
    ],
  }));
}

export async function seedFiles({
  h,
  bookId,
  files,
}: {
  h: Harness;
  bookId: string;
  files: SeedFile[];
}): Promise<void> {
  const statements = fileRowStatements({ bookId, files });
  for (let i = 0; i < statements.length; i += 50) {
    await h.sql(statements.slice(i, i + 50));
  }
  for (const f of files) {
    if (f.scan) {
      await h.putObject({
        key: scanKey({ bookId, fileId: f.fileId }),
        body: f.scan,
        contentType: f.scanType ?? "image/jpeg",
      });
    }
    if (f.text != null) {
      await h.putObject({
        key: textKey({ bookId, fileId: f.fileId }),
        body: f.text,
        contentType: "text/markdown; charset=utf-8",
      });
    }
  }
}

export interface OpCounts {
  // D1 statements, however they were sent; d1RoundTrips counts a batch once.
  d1Queries: number;
  d1RoundTrips: number;
  d1RowsRead: number;
  d1RowsWritten: number;
  r2Reads: number;
  r2Writes: number;
  kvReads: number;
  kvWrites: number;
  queueSends: number;
  workflowCreates: number;
}

export function countOps(operations: Operation[]): OpCounts {
  const count = (kinds: Operation["kind"][]) =>
    operations.filter((o) => kinds.includes(o.kind)).length;
  return {
    d1Queries: operations.reduce(
      (n, o) =>
        n +
        (o.kind === "d1.query"
          ? 1
          : o.kind === "d1.batch"
            ? (o.statements ?? 1)
            : 0),
      0,
    ),
    d1RoundTrips: count(["d1.query", "d1.batch"]),
    d1RowsRead: operations.reduce((n, o) => n + (o.rowsRead ?? 0), 0),
    d1RowsWritten: operations.reduce((n, o) => n + (o.rowsWritten ?? 0), 0),
    r2Reads: count(["r2.get", "r2.head", "r2.list"]),
    r2Writes: count(["r2.put", "r2.delete"]),
    kvReads: count(["kv.get"]),
    kvWrites: count(["kv.put"]),
    queueSends: count(["queue.send"]),
    workflowCreates: count(["workflow.create"]),
  };
}

// Runs `request` with the operation log cleared first, and returns the
// response plus every binding operation and queue message it caused.
export async function measured({
  h,
  request,
}: {
  h: Harness;
  request: () => Promise<Response>;
}): Promise<{
  response: Response;
  counts: OpCounts;
  operations: Operation[];
  messages: unknown[];
}> {
  await h.ops();
  const response = await request();
  await response.arrayBuffer().catch(() => undefined);
  const { operations, messages } = await h.ops();
  return { response, counts: countOps(operations), operations, messages };
}

export interface WideEvent {
  route?: string;
  book_id?: string;
  file_id?: string;
  status?: number;
  path?: string;
  method?: string;
  raw: string;
}

// evlog pretty-prints wide events in development (util.inspect style); pull
// out the fields the contract cares about.
export function wideEvents(lines: string[]): WideEvent[] {
  const field = (raw: string, name: string) =>
    new RegExp(`^ {2}${name}: '([^']*)'`, "m").exec(raw)?.[1];
  return lines
    .filter((raw) => /^ {2}service: 'arabic-digitization'/m.test(raw))
    .map((raw) => {
      const status = /^ {2}status: (\d+)/m.exec(raw)?.[1];
      return {
        route: field(raw, "route"),
        book_id: field(raw, "book_id"),
        file_id: field(raw, "file_id"),
        path: field(raw, "path"),
        method: field(raw, "method"),
        status: status === undefined ? undefined : Number(status),
        raw,
      };
    });
}

export const JPEG_BYTES = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x02,
  0x03, 0x04, 0xff, 0xd9,
]);
