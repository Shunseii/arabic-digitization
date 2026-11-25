// GET /api/jobs, GET /api/reviews/summary and GET .../files/:fileId/reviews
// against a realistically sized library, with the D1 rows each call reads.
// Its own harness, so the 6,000 seeded files don't disturb api.test.ts.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "./harness";
import { measured } from "./support";

let h: Harness;
const NOW = Date.now();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const BOOKS = 6;
const FILES_PER_BOOK = 1000;
const OCR_RUNS = 6000;
const BATCHES = 20;
const REVIEWS_PER_BATCH = 20;

// Rows read per call, printed for the report.
const rowsRead: Record<string, number> = {};

beforeAll(async () => {
  h = await startHarness();
  await h.sql([
    {
      sql: `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${BOOKS})
            INSERT INTO books (id, title, created_at, review_enabled, paused)
            SELECT 'b' || i, 'Book ' || i, 1, i <= 2, i = 6 FROM n`,
    },
    // Book 1 is mid-OCR (queued, processing, failed), book 2 is rate
    // limited, book 6 is paused with pages waiting; the rest are done.
    {
      sql: `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${BOOKS * FILES_PER_BOOK - 1})
            INSERT INTO files (file_id, book_id, r2_key, state, text_key, preview, created_at, updated_at)
            SELECT 'f' || i, 'b' || (i / ${FILES_PER_BOOK} + 1), 'k',
                   CASE
                     WHEN i BETWEEN 900 AND 939 THEN 'queued'
                     WHEN i BETWEEN 940 AND 944 THEN 'processing'
                     WHEN i BETWEEN 945 AND 947 THEN 'failed'
                     WHEN i BETWEEN 1990 AND 1999 THEN 'rate_limited'
                     WHEN i BETWEEN 5980 AND 5999 THEN 'queued'
                     ELSE 'done' END,
                   't/' || i, 'p', 1, ${NOW - 10 * DAY} + i * 60000 FROM n`,
    },
    // OCR runs over the last ~10 days, newest in the last hour; every 50th
    // fell back to Claude, every 70th was a third delivery.
    {
      sql: `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${OCR_RUNS - 1})
            INSERT INTO ocr_runs (file_id, book_id, created_at, trigger, status, primary_engine,
                                  final_model, fell_back, fallback_reason, delivery_attempt, calls,
                                  latency_ms, input_tokens, output_tokens, cost_usd, wasted_cost_usd)
            SELECT 'f' || i, 'b' || (i % ${BOOKS} + 1), ${NOW} - (${OCR_RUNS} - i) * 140000, 'upload',
                   CASE WHEN i % 97 = 0 THEN 'failed' ELSE 'done' END, 'inkling',
                   CASE WHEN i % 50 = 0 THEN 'claude-sonnet-5-5' ELSE 'inkling-2-small' END,
                   i % 50 = 0, CASE WHEN i % 50 = 0 THEN 'rate_limit' END,
                   CASE WHEN i % 70 = 0 THEN 3 ELSE 1 END, '[]', 1000, 1000, 2000, 0.002, 0 FROM n`,
    },
    // 20 batches, one every 3 hours; the newest is still processing and the
    // one before it is applying (half its pages recorded).
    {
      sql: `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${BATCHES - 1})
            INSERT INTO review_batches (instance_id, batch_id, created_at, model, pages, stage,
                                        submitted_at, processing, succeeded, ended_at,
                                        anthropic_ended_at, checks, steps)
            SELECT 'review-' || i, 'msgbatch_' || i, ${NOW} - (${BATCHES} - i) * 3 * ${HOUR},
                   'claude-opus-5-5', ${REVIEWS_PER_BATCH},
                   CASE WHEN i = ${BATCHES - 1} THEN 'processing' ELSE 'applying' END,
                   ${NOW} - (${BATCHES} - i) * 3 * ${HOUR} + 60000,
                   CASE WHEN i = ${BATCHES - 1} THEN ${REVIEWS_PER_BATCH} ELSE 0 END,
                   CASE WHEN i = ${BATCHES - 1} THEN 0 ELSE ${REVIEWS_PER_BATCH} END,
                   -- Batch i took i + 1 minutes; polling saw it (i % 3) minutes late.
                   CASE WHEN i = ${BATCHES - 1} THEN NULL
                        ELSE ${NOW} - (${BATCHES} - i) * 3 * ${HOUR} + 60000 + (i + 1) * 60000 + (i % 3) * 60000 END,
                   CASE WHEN i = ${BATCHES - 1} THEN NULL
                        ELSE ${NOW} - (${BATCHES} - i) * 3 * ${HOUR} + 60000 + (i + 1) * 60000 END,
                   CASE WHEN i = ${BATCHES - 1} THEN NULL ELSE i + 1 END,
                   CASE WHEN i = ${BATCHES - 1} THEN NULL ELSE 2 * (i + 1) + 11 END
              FROM n`,
    },
    {
      sql: `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n
                                     WHERE i < ${(BATCHES - 1) * REVIEWS_PER_BATCH - 11})
            INSERT INTO page_reviews (file_id, batch_id, book_id, created_at, model, effort, status,
                                      edits_proposed, edits_applied, edits_failed, categories, edits,
                                      chars_changed, chars_total, input_tokens, output_tokens,
                                      cost_usd, revision_id)
            SELECT 'f' || i, 'msgbatch_' || (i / ${REVIEWS_PER_BATCH}),
                   CASE WHEN i % 2 = 0 THEN 'b1' ELSE 'b2' END,
                   ${NOW} - (${BATCHES} - i / ${REVIEWS_PER_BATCH}) * 3 * ${HOUR} + 2 * ${HOUR},
                   'claude-opus-5-5', 'low',
                   CASE WHEN i % 10 = 9 THEN 'no_changes' WHEN i % 25 = 24 THEN 'errored' ELSE 'applied' END,
                   3, 2, 1,
                   '{"tashkeel":{"proposed":2,"applied":2,"failed":0},"spelling":{"proposed":1,"applied":0,"failed":1}}',
                   '[{"find":"a","replace":"b","category":"tashkeel","applied":true}]',
                   12, 1500, 5000, 800, 0.02, i + 1 FROM n`,
    },
    // A hand edit after the review on every 20th reviewed page.
    {
      sql: `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 20 FROM n WHERE i < 360)
            INSERT INTO text_revisions (file_id, book_id, change, model, note, prev_key, created_at)
            SELECT 'f' || i, 'b1', 'edit', NULL, NULL, 'k', ${NOW} FROM n`,
    },
    // 120 days of spend for 6 books: OCR with two models every day, review
    // on books 1 and 2 (one row per day/book/kind/model, as the rollup keeps).
    {
      sql: `WITH RECURSIVE d(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM d WHERE i < 119),
                     b(j) AS (SELECT 1 UNION ALL SELECT j + 1 FROM b WHERE j < ${BOOKS})
            INSERT INTO spend_daily (day, book_id, kind, model, cost_usd, input_tokens, output_tokens, calls, pages)
            SELECT date(${NOW} / 1000, 'unixepoch', '-' || i || ' days'), 'b' || j, 'ocr',
                   'inkling-2-small', 0.25, 100000, 200000, 40, 40 FROM d, b
            UNION ALL
            SELECT date(${NOW} / 1000, 'unixepoch', '-' || i || ' days'), 'b' || j, 'ocr',
                   'claude-sonnet-5-5', 0.10, 10000, 5000, 2, 1 FROM d, b
            UNION ALL
            SELECT date(${NOW} / 1000, 'unixepoch', '-' || i || ' days'), 'b' || j, 'review',
                   'claude-opus-5-5', 1.00, 200000, 30000, 30, 30 FROM d, b WHERE j <= 2`,
    },
    // 30 dead messages; the first 10 were resolved later.
    {
      sql: `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 29)
            INSERT INTO failed_messages (kind, file_id, book_id, ref, last_error, attempts,
                                         first_failed_at, last_failed_at, resolved_at)
            SELECT CASE WHEN i % 2 = 0 THEN 'ocr' ELSE 'review_apply' END, 'f' || i, 'b1',
                   CASE WHEN i % 2 = 1 THEN 'msgbatch_' || i END, 'boom ' || i, 11,
                   ${NOW} - (30 - i) * 60000, ${NOW} - (30 - i) * 60000,
                   CASE WHEN i < 10 THEN ${NOW} END
              FROM n`,
    },
    {
      sql: `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 29)
            INSERT INTO review_queue (file_id, book_id, queued_at, attempts)
            SELECT 'f' || (1000 + i), 'b2', 1, i < 3 FROM n`,
    },
  ]);
}, 120_000);

afterAll(() => {
  console.log(`D1 rows read per call: ${JSON.stringify(rowsRead, null, 2)}`);
  return h?.close();
});

async function readMeasured<T>({
  label,
  path,
}: {
  label: string;
  path: string;
}) {
  const { response, counts } = await measured({
    h,
    request: () => h.api(path),
  });
  rowsRead[label] = counts.d1RowsRead;
  expect(response.status, label).toBe(200);
  return { body: (await (await h.api(path)).json()) as T, counts };
}

describe("GET /api/jobs", () => {
  it("shows running OCR and review work without scanning the files table", async () => {
    const { body, counts } = await readMeasured<{
      ocr: {
        books: {
          book_id: string;
          paused: boolean;
          queued: number;
          processing: number;
          rate_limited: number;
          failed: number;
          oldest_queued_at: number | null;
          done_last_hour: number;
          fell_back: number;
          retried: number;
        }[];
        problem_pages: unknown[];
      };
      failed: {
        count: number;
        recent: Record<string, unknown>[];
      };
      review: {
        in_flight: {
          instance_id: string;
          stage: string;
          reviewed: number;
          pages: number;
          submitted_at: number;
          ended_at: number | null;
          request_counts: { processing: number };
        }[];
        waiting: { book_id: string; pages: number; retrying: number }[];
        recent: { instance_id: string; stage: string; edits_applied: number }[];
      };
    }>({ label: "GET /api/jobs", path: "/api/jobs" });

    const byId = new Map(body.ocr.books.map((b) => [b.book_id, b]));
    expect(byId.get("b1")).toMatchObject({
      queued: 40,
      processing: 5,
      failed: 3,
      oldest_queued_at: NOW - 10 * DAY + 900 * 60000,
    });
    expect(byId.get("b2")).toMatchObject({ rate_limited: 10, queued: 0 });
    expect(byId.get("b6")).toMatchObject({
      paused: true,
      queued: 20,
      oldest_queued_at: null,
    });
    const doneLastHour = body.ocr.books.reduce(
      (n, b) => n + b.done_last_hour,
      0,
    );
    expect(doneLastHour).toBeGreaterThan(20);
    expect(body.ocr.problem_pages.length).toBeGreaterThan(0);

    expect(body.review.in_flight.map((b) => [b.instance_id, b.stage])).toEqual([
      ["review-19", "processing"],
      ["review-18", "applying"],
    ]);
    expect(body.review.in_flight[0]).toMatchObject({
      request_counts: { processing: 20 },
      ended_at: null,
    });
    expect(body.review.in_flight[1]).toMatchObject({ reviewed: 10, pages: 20 });
    expect(body.review.recent).toHaveLength(10);
    expect(body.review.recent[0]).toMatchObject({
      anthropic_ended_at: expect.any(Number),
      checks: 18,
      steps: 47,
      instance_id: "review-17",
      stage: "done",
    });
    expect(body.review.waiting).toEqual([
      { book_id: "b2", title: "Book 2", pages: 30, retrying: 3 },
    ]);
    expect(body.failed.count).toBe(20);
    expect(body.failed.recent).toHaveLength(10);
    expect(body.failed.recent[0]).toEqual({
      id: "review_apply:f29",
      kind: "review_apply",
      file_id: "f29",
      book_id: "b1",
      book_title: "Book 1",
      page_number: null,
      ref: "msgbatch_29",
      error: "boom 29",
      attempts: 11,
      first_failed_at: NOW - 60000,
      last_failed_at: NOW - 60000,
    });
    // Far below the 6,000 files and 6,000 runs in the tables.
    expect(counts.d1RowsRead).toBeLessThan(3000);
  });
});

describe("GET /api/spend", () => {
  it("totals OCR and review spend from the daily rollup", async () => {
    const { body } = await readMeasured<{
      total_cost_usd: number;
      by_model: {
        kind: string;
        model: string;
        cost_usd: number;
        pages: number;
      }[];
      daily: { day: string; ocr_cost_usd: number; review_cost_usd: number }[];
      top_books: {
        kind: string;
        book_id: string;
        title: string;
        cost_usd: number;
      }[];
    }>({ label: "GET /api/spend?days=30", path: "/api/spend?days=30" });
    expect(body.daily).toHaveLength(30);
    expect(body.daily.at(-1)).toEqual({
      day: new Date(NOW).toISOString().slice(0, 10),
      ocr_cost_usd: expect.closeTo(BOOKS * 0.35, 9),
      review_cost_usd: expect.closeTo(2, 9),
    });
    expect(body.by_model).toEqual([
      expect.objectContaining({
        kind: "review",
        model: "claude-opus-5-5",
        pages: 30 * 2 * 30,
      }),
      expect.objectContaining({ kind: "ocr", model: "inkling-2-small" }),
      expect.objectContaining({ kind: "ocr", model: "claude-sonnet-5-5" }),
    ]);
    expect(body.total_cost_usd).toBeCloseTo(30 * (BOOKS * 0.35 + 2), 6);
    expect(body.top_books.filter((b) => b.kind === "ocr")).toHaveLength(5);
    expect(body.top_books.find((b) => b.kind === "review")).toMatchObject({
      title: expect.stringMatching(/^Book [12]$/),
    });

    await readMeasured({
      label: "GET /api/spend?days=90",
      path: "/api/spend?days=90",
    });
    const one = await readMeasured<{
      total_cost_usd: number;
      top_books: unknown[];
    }>({
      label: "GET /api/spend?days=90&book=b1",
      path: "/api/spend?days=90&book=b1",
    });
    expect(one.body.total_cost_usd).toBeCloseTo(90 * 1.35, 6);
    expect(one.body.top_books).toEqual([]);
  });

  it("splits a book's usage into OCR and review", async () => {
    const { body } = await readMeasured<{
      book: {
        usage: {
          ocr: { cost_usd: number; pages: number };
          review: { cost_usd: number; pages: number };
          total_cost_usd: number;
        };
      };
    }>({ label: "GET /api/books/:id (usage)", path: "/api/books/b1" });
    expect(body.book.usage.ocr.cost_usd).toBeCloseTo(120 * 0.35, 6);
    expect(body.book.usage.review).toMatchObject({ pages: 120 * 30 });
    expect(body.book.usage.total_cost_usd).toBeCloseTo(120 * 1.35, 6);
  });
});

describe("POST /api/books/:id/review (all)", () => {
  it("queues a 1,000-page book on demand", async () => {
    const { response, counts } = await measured({
      h,
      request: () =>
        h.api("/api/books/b3/review", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ all: true }),
        }),
    });
    rowsRead["POST /api/books/:id/review {all} (1,000 pages)"] =
      counts.d1RowsRead;
    expect(response.status).toBe(200);
    const [row] = await h.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM review_queue WHERE book_id = 'b3' AND requested = 1",
    );
    expect(row?.n).toBe(FILES_PER_BOOK);
  });
});

describe("GET /api/reviews/summary", () => {
  it("totals a window of reviews by status and category", async () => {
    const { body } = await readMeasured<{
      pages_reviewed: number;
      pages_changed: number;
      pages_not_reviewed: number;
      edits: { proposed: number; applied: number; failed: number };
      by_category: Record<string, { proposed: number }>;
      text_changed_share: number;
      cost_per_page_usd: number;
      hand_edited_after_review: number;
      batches: unknown;
    }>({
      label: "GET /api/reviews/summary?days=90",
      path: "/api/reviews/summary?days=90",
    });
    // Batch timing: 19 ended batches of 1..19 minutes, lag 0-2 minutes.
    expect(body.batches).toEqual({
      count: BATCHES,
      pages_avg: REVIEWS_PER_BATCH,
      duration_ms: { p50: 10 * 60000, p90: 18 * 60000, max: 19 * 60000 },
      polling_lag_ms: { p50: 60000, max: 2 * 60000 },
      checks: { avg: 10, max: 19 },
      steps: { avg: 31, max: 49 },
    });
    const pages = (BATCHES - 1) * REVIEWS_PER_BATCH - 10;
    expect(body.pages_reviewed + body.pages_not_reviewed).toBe(pages);
    expect(body.edits.proposed).toBe(pages * 3);
    expect(body.by_category.tashkeel?.proposed).toBe(pages * 2);
    expect(body.by_category.quran).toEqual({
      proposed: 0,
      applied: 0,
      failed: 0,
    });
    expect(body.text_changed_share).toBeGreaterThan(0);
    expect(body.hand_edited_after_review).toBeGreaterThan(0);

    for (const days of [7, 30]) {
      await readMeasured({
        label: `GET /api/reviews/summary?days=${days}`,
        path: `/api/reviews/summary?days=${days}`,
      });
    }
    const oneDay = await readMeasured<{ pages_reviewed: number }>({
      label: "GET /api/reviews/summary?days=1&book=b1",
      path: "/api/reviews/summary?days=1&book=b1",
    });
    expect(oneDay.body.pages_reviewed).toBeLessThan(body.pages_reviewed);
  });
});

describe("GET /api/books/:bookId/files/:fileId/reviews", () => {
  it("lists a page's reviews with their edits", async () => {
    const { body, counts } = await readMeasured<{
      reviews: { batch_id: string; edits: unknown[] }[];
    }>({
      label: "GET .../files/:fileId/reviews",
      path: "/api/books/b1/files/f0/reviews",
    });
    expect(body.reviews).toEqual([
      expect.objectContaining({
        batch_id: "msgbatch_0",
        edits: [
          { find: "a", replace: "b", category: "tashkeel", applied: true },
        ],
      }),
    ]);
    expect(counts.d1RowsRead).toBeLessThan(5);
  });
});
