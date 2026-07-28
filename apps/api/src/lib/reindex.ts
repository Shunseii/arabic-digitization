// Rebuild Meilisearch documents from the source of truth (R2 transcriptions),
// joining in work-level fields (name/author/tags) that are denormalized onto
// every chunk. Shared by POST /api/search/reindex and the work-edit hook that
// keeps those denormalized fields fresh when a work is renamed/retagged or a
// copy is (re)assigned.

import {
  buildPageDocs,
  deleteDocsByBook,
  type SearchDoc,
  upsertDocs,
} from "./meili";

interface PageRow {
  file_id: string;
  book_id: string;
  page_number: number | null;
  role: string | null;
  text_key: string;
  book_title: string;
  work_id: string | null;
  work_name: string | null;
  author: string | null;
}

// Only pages with finished text are searchable. LEFT JOIN works so copies with
// no work (work_id NULL) still index, with null work fields.
const PAGE_SQL = `SELECT f.file_id, f.book_id, f.page_number, f.role, f.text_key,
                         b.title AS book_title, b.work_id,
                         w.name AS work_name, w.author
                    FROM files f
                    JOIN books b ON f.book_id = b.id
                    LEFT JOIN works w ON b.work_id = w.id
                   WHERE f.text_key IS NOT NULL
                     AND f.state IN ('done','needs_review','approved')`;

// Map of work_id -> tag names, for the works referenced by the given rows.
// One query regardless of page count; empty map when no rows carry a work.
async function tagsByWork({
  env,
  workIds,
}: {
  env: Env;
  workIds: string[];
}): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (workIds.length === 0) return map;
  const placeholders = workIds.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT wt.work_id, t.name
       FROM work_tags wt JOIN tags t ON wt.tag_id = t.id
      WHERE wt.work_id IN (${placeholders})`,
  )
    .bind(...workIds)
    .all<{ work_id: string; name: string }>();
  for (const r of results) {
    const list = map.get(r.work_id) ?? [];
    list.push(r.name);
    map.set(r.work_id, list);
  }
  return map;
}

// Build chunk docs for a set of page rows: pull each transcription from R2, chunk
// it, and attach denormalized work fields + tags. Skips missing/empty pages.
async function buildDocs({
  env,
  rows,
}: {
  env: Env;
  rows: PageRow[];
}): Promise<SearchDoc[]> {
  const workIds = [
    ...new Set(
      rows.map((r) => r.work_id).filter((w): w is string => w !== null),
    ),
  ];
  const tagMap = await tagsByWork({ env, workIds });

  const docs: SearchDoc[] = [];
  for (const r of rows) {
    const obj = await env.BUCKET.get(r.text_key);
    if (!obj) continue;
    const text = await obj.text();
    if (!text.trim()) continue;
    docs.push(
      ...buildPageDocs({
        file_id: r.file_id,
        book_id: r.book_id,
        book_title: r.book_title,
        work_id: r.work_id,
        work_name: r.work_name,
        author: r.author,
        tags: r.work_id ? (tagMap.get(r.work_id) ?? []) : [],
        page_number: r.page_number,
        role: r.role,
        text,
      }),
    );
  }
  return docs;
}

export interface ReindexResult {
  indexed: number;
  taskUid: number | null; // Meili upsert task; null when nothing was indexed
}

// Reindex a single book: clear its docs, rebuild from R2, upsert. The delete is
// enqueued before the upsert; Meili is FIFO so it always lands first (a page's
// chunk count can change between runs). `index` targets the live index by
// default, or a staging index while building a swap.
export async function reindexBook({
  env,
  bookId,
  index,
}: {
  env: Env;
  bookId: string;
  index?: string;
}): Promise<ReindexResult> {
  const { results } = await env.DB.prepare(`${PAGE_SQL} AND f.book_id = ?`)
    .bind(bookId)
    .all<PageRow>();
  await deleteDocsByBook({ env, bookId, index });
  const docs = await buildDocs({ env, rows: results });
  const taskUid =
    docs.length > 0 ? await upsertDocs({ env, docs, index }) : null;
  return { indexed: docs.length, taskUid };
}

// Reindex every book scoped to one work — the work-edit / (re)assign hook. Each
// book is cleared+rebuilt independently so a reassigned copy that left this work
// isn't the caller's concern (its own reindex handles it).
export async function reindexWork({
  env,
  workId,
}: {
  env: Env;
  workId: string;
}): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT id FROM books WHERE work_id = ?",
  )
    .bind(workId)
    .all<{ id: string }>();
  for (const b of results) {
    await reindexBook({ env, bookId: b.id });
  }
}
