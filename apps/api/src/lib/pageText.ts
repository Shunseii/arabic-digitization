// Shared steps for replacing a page's transcription: keep a copy of the text
// being replaced (history), and refresh the page's search documents.

import { buildPageDocs, deleteDocsByFile, upsertDocs } from "./meili";

export type TextChange = "edit" | "ocr";

// R2 key for a saved earlier version. Lives under the book's prefix so
// deleting the book clears its history too.
export const historyKey = ({
  bookId,
  fileId,
  at,
}: {
  bookId: string;
  fileId: string;
  at: number;
}) =>
  `books/${bookId}/text-history/${fileId}/${at}-${crypto.randomUUID().slice(0, 8)}.md`;

export const historyPrefix = ({
  bookId,
  fileId,
}: {
  bookId: string;
  fileId: string;
}) => `books/${bookId}/text-history/${fileId}/`;

export interface SavedRevision {
  id: number;
  key: string;
}

// Save `previous` as an earlier version of the page before `next` replaces it.
// Does nothing (returns null) when the text is unchanged.
export async function saveRevision({
  env,
  bookId,
  fileId,
  previous,
  next,
  change,
  model = null,
  note = null,
}: {
  env: Env;
  bookId: string;
  fileId: string;
  previous: string;
  next: string;
  change: TextChange;
  model?: string | null;
  note?: string | null;
}): Promise<SavedRevision | null> {
  if (previous === next) return null;
  const at = Date.now();
  const key = historyKey({ bookId, fileId, at });
  await env.BUCKET.put(key, previous, {
    httpMetadata: { contentType: "text/markdown; charset=utf-8" },
  });
  const row = await env.DB.prepare(
    `INSERT INTO text_revisions (file_id, book_id, change, model, note, prev_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  )
    .bind(fileId, bookId, change, model, note, key, at)
    .first<{ id: number }>();
  if (!row) throw new Error(`could not record revision for ${fileId}`);
  return { id: row.id, key };
}

// Undo saveRevision, for when the change it was saved for didn't happen.
export async function discardRevision({
  env,
  revision,
}: {
  env: Env;
  revision: SavedRevision;
}): Promise<void> {
  await env.DB.prepare("DELETE FROM text_revisions WHERE id = ?")
    .bind(revision.id)
    .run();
  await env.BUCKET.delete(revision.key);
}

// Replace a page's search documents with ones built from `text`. Best-effort:
// a Meili outage (or unconfigured MEILI_*) must not fail the write; the page
// is safe in R2/D1 and POST /api/search/reindex re-syncs anything missed.
export async function indexPage({
  env,
  fileId,
  text,
}: {
  env: Env;
  fileId: string;
  text: string;
}): Promise<void> {
  try {
    await indexPageOrThrow({ env, fileId, text });
  } catch (err) {
    console.error(`search index update failed for ${fileId}: ${err}`);
  }
}

// indexPage without the catch, for callers that report the failure themselves.
export async function indexPageOrThrow({
  env,
  fileId,
  text,
}: {
  env: Env;
  fileId: string;
  text: string;
}): Promise<void> {
  if (!env.MEILI_URL || !env.MEILI_KEY) return;
  const row = await env.DB.prepare(
    `SELECT f.book_id, f.page_number, f.role, b.title AS book_title, b.work_id,
            w.name AS work_name, w.author
       FROM files f
       JOIN books b ON b.id = f.book_id
       LEFT JOIN works w ON w.id = b.work_id
      WHERE f.file_id = ?`,
  )
    .bind(fileId)
    .first<{
      book_id: string;
      page_number: number | null;
      role: string | null;
      book_title: string;
      work_id: string | null;
      work_name: string | null;
      author: string | null;
    }>();
  if (!row) return;

  // Tag names live on the work (denormalized onto every chunk for faceting).
  let tags: string[] = [];
  if (row.work_id) {
    const { results } = await env.DB.prepare(
      `SELECT t.name FROM work_tags wt JOIN tags t ON wt.tag_id = t.id
        WHERE wt.work_id = ?`,
    )
      .bind(row.work_id)
      .all<{ name: string }>();
    tags = results.map((r) => r.name);
  }

  // Clear this page's prior chunks first — new text can produce a different
  // chunk count, so upsert alone would leave stale `file_id#N` docs behind.
  await deleteDocsByFile({ env, fileId });
  await upsertDocs({
    env,
    docs: buildPageDocs({
      file_id: fileId,
      book_id: row.book_id,
      book_title: row.book_title,
      work_id: row.work_id,
      work_name: row.work_name,
      author: row.author,
      tags,
      page_number: row.page_number,
      role: row.role,
      text,
    }),
  });
}
