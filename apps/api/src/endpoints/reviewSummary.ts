import { Effect, Schema } from "effect";
import { HttpApiEndpoint, OpenApi } from "effect/http-api";
import { type EndpointHandler, WorkerContext } from "../http/context";
import { respond } from "../http/respond";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 30;
const MAX_DAYS = 90;

// Statuses where Opus reviewed the page's text (whether or not it changed).
const REVIEWED = ["applied", "no_changes"];
// Statuses where no review came back for the page.
const NOT_REVIEWED = [
  "failed",
  "errored",
  "expired",
  "canceled",
  "invalid_output",
  "refused",
];

// Batch timing for tuning the poll schedule. Durations in ms. Percentiles
// are nearest-rank over batches that ended; checks and steps over batches
// that were finalized.
const BatchTiming = Schema.Struct({
  count: Schema.Int.annotate({
    description: "Batches started in the window (all books: batches mix books)",
  }),
  pages_avg: Schema.NullOr(Schema.Number),
  duration_ms: Schema.Struct({
    p50: Schema.NullOr(Schema.Int),
    p90: Schema.NullOr(Schema.Int),
    max: Schema.NullOr(Schema.Int),
  }).annotate({
    description: "Submission to Anthropic's ended_at",
  }),
  polling_lag_ms: Schema.Struct({
    p50: Schema.NullOr(Schema.Int),
    max: Schema.NullOr(Schema.Int),
  }).annotate({
    description: "Anthropic's ended_at to the check that saw it",
  }),
  checks: Schema.Struct({
    avg: Schema.NullOr(Schema.Number),
    max: Schema.NullOr(Schema.Int),
  }),
  steps: Schema.Struct({
    avg: Schema.NullOr(Schema.Number),
    max: Schema.NullOr(Schema.Int),
  }),
});

interface BatchTimingRow {
  count: number;
  pages_avg: number | null;
  checks_avg: number | null;
  checks_max: number | null;
  steps_avg: number | null;
  steps_max: number | null;
  duration_max: number | null;
  duration_p50: number | null;
  duration_p90: number | null;
  lag_max: number | null;
  lag_p50: number | null;
}

// One statement over the window's review_batches rows (through
// idx_review_batches_created). Nearest-rank percentile: the value at rank
// ceil(n * p / 100), as integer arithmetic.
const BATCH_TIMING_SQL = `
  WITH b AS MATERIALIZED (
         SELECT pages, checks, steps,
                anthropic_ended_at - submitted_at AS duration,
                ended_at - anthropic_ended_at AS lag
           FROM review_batches WHERE created_at >= ?1),
       d AS (SELECT duration AS v, ROW_NUMBER() OVER (ORDER BY duration) AS r,
                    COUNT(*) OVER () AS n
               FROM b WHERE duration IS NOT NULL),
       l AS (SELECT lag AS v, ROW_NUMBER() OVER (ORDER BY lag) AS r,
                    COUNT(*) OVER () AS n
               FROM b WHERE lag IS NOT NULL)
  SELECT a.*,
         (SELECT v FROM d WHERE r = (n * 50 + 99) / 100) AS duration_p50,
         (SELECT v FROM d WHERE r = (n * 90 + 99) / 100) AS duration_p90,
         (SELECT v FROM l WHERE r = (n * 50 + 99) / 100) AS lag_p50
    FROM (SELECT COUNT(*) AS count, AVG(pages) AS pages_avg,
                 AVG(checks) AS checks_avg, MAX(checks) AS checks_max,
                 AVG(steps) AS steps_avg, MAX(steps) AS steps_max,
                 MAX(duration) AS duration_max, MAX(lag) AS lag_max
            FROM b) a`;

// The Usage dashboard's review panel: totals over page_reviews in a window.
export const ReviewSummary = HttpApiEndpoint.get(
  "reviewSummary",
  "/api/reviews/summary",
  {
    query: {
      days: Schema.optionalKey(
        Schema.Int.check(
          Schema.isGreaterThanOrEqualTo(1),
          Schema.isLessThanOrEqualTo(MAX_DAYS),
        ).annotate({
          description: `Window in days (1-${MAX_DAYS}, default ${DEFAULT_DAYS}); the dashboard uses 7, 30 or 90`,
        }),
      ),
      book: Schema.optionalKey(
        Schema.String.annotate({ description: "Only this book's pages" }),
      ),
    },
    success: Schema.Struct({
      success: Schema.Boolean,
      since: Schema.Int,
      book_id: Schema.NullOr(Schema.String),
      pages_reviewed: Schema.Int.annotate({
        description: "Pages Opus reviewed (applied or no changes needed)",
      }),
      pages_changed: Schema.Int,
      pages_not_reviewed: Schema.Int.annotate({
        description:
          "Tries that ended without a review (failed, retried, refused, unreadable output)",
      }),
      pages_skipped: Schema.Int.annotate({
        description:
          "Reviews not applied because the page was hand-edited, changed or deleted meanwhile",
      }),
      by_status: Schema.Record(Schema.String, Schema.Int),
      words: Schema.Struct({
        added: Schema.Int,
        removed: Schema.Int,
      }).annotate({
        description:
          "Words the applied corrections added and removed (a word diff; reviews from before full-page answers count 0)",
      }),
      text_changed_share: Schema.NullOr(Schema.Number).annotate({
        description:
          "Characters changed by applied reviews / characters of the reviewed pages",
      }),
      cost_usd: Schema.Number,
      cost_per_page_usd: Schema.NullOr(Schema.Number).annotate({
        description: "Cost / pages reviewed",
      }),
      batches: BatchTiming,
      hand_edited_after_review: Schema.Int.annotate({
        description: "Pages changed by a review and then edited by hand",
      }),
    }),
  },
).annotate(OpenApi.Summary, "Summarize Opus reviews over a time window");

interface StatusRow {
  status: string;
  pages: number;
  chars_changed: number;
  chars_total: number;
  cost_usd: number;
  hand_edited: number;
  words_added: number | null;
  words_removed: number | null;
}

export const reviewSummary: EndpointHandler<typeof ReviewSummary> = ({
  query,
}) =>
  Effect.gen(function* () {
    const { env } = yield* WorkerContext;
    const since = Date.now() - (query.days ?? DEFAULT_DAYS) * DAY_MS;
    const book = query.book ?? null;
    // One pass over the window's rows (idx_page_reviews_created).
    const [statusResult, timingResult] = yield* Effect.promise(() =>
      env.DB.batch([
        env.DB.prepare(
          `SELECT r.status, COUNT(*) AS pages,
                SUM(r.chars_changed) AS chars_changed,
                SUM(r.chars_total) AS chars_total, SUM(r.cost_usd) AS cost_usd,
                SUM(CASE WHEN r.status = 'applied' THEN json_extract(r.edits, '$.words_added') END) AS words_added,
                SUM(CASE WHEN r.status = 'applied' THEN json_extract(r.edits, '$.words_removed') END) AS words_removed,
                SUM(CASE WHEN r.status = 'applied' THEN EXISTS (
                      SELECT 1 FROM text_revisions t
                       WHERE t.file_id = r.file_id AND t.created_at > r.created_at
                         AND t.change = 'edit') ELSE 0 END) AS hand_edited
           FROM page_reviews r
          WHERE r.created_at >= ?1 AND (?2 IS NULL OR r.book_id = ?2)
          GROUP BY r.status`,
        ).bind(since, book),
        env.DB.prepare(BATCH_TIMING_SQL).bind(since),
      ]),
    );
    const statuses = (statusResult?.results ?? []) as StatusRow[];
    const timing = (timingResult?.results[0] ?? null) as BatchTimingRow | null;

    const count = (names: readonly string[]) =>
      statuses
        .filter((row) => names.includes(row.status))
        .reduce((n, row) => n + row.pages, 0);
    const sum = (field: keyof Omit<StatusRow, "status">) =>
      statuses.reduce((n, row) => n + (row[field] ?? 0), 0);
    const reviewed = count(REVIEWED);
    const charsTotal = statuses
      .filter((row) => REVIEWED.includes(row.status))
      .reduce((n, row) => n + row.chars_total, 0);
    const costUsd = sum("cost_usd");

    return respond({
      endpoint: ReviewSummary,
      body: {
        success: true,
        since,
        book_id: book,
        pages_reviewed: reviewed,
        pages_changed: count(["applied"]),
        pages_not_reviewed: count(NOT_REVIEWED),
        pages_skipped: count([
          "skipped_hand_edited",
          "stale",
          "conflict",
          "page_gone",
        ]),
        by_status: Object.fromEntries(
          statuses.map((row) => [row.status, row.pages]),
        ),
        words: { added: sum("words_added"), removed: sum("words_removed") },
        text_changed_share:
          charsTotal > 0 ? sum("chars_changed") / charsTotal : null,
        cost_usd: costUsd,
        cost_per_page_usd: reviewed > 0 ? costUsd / reviewed : null,
        hand_edited_after_review: sum("hand_edited"),
        batches: {
          count: timing?.count ?? 0,
          pages_avg: timing?.pages_avg ?? null,
          duration_ms: {
            p50: timing?.duration_p50 ?? null,
            p90: timing?.duration_p90 ?? null,
            max: timing?.duration_max ?? null,
          },
          polling_lag_ms: {
            p50: timing?.lag_p50 ?? null,
            max: timing?.lag_max ?? null,
          },
          checks: {
            avg: timing?.checks_avg ?? null,
            max: timing?.checks_max ?? null,
          },
          steps: {
            avg: timing?.steps_avg ?? null,
            max: timing?.steps_max ?? null,
          },
        },
      },
    });
  });
