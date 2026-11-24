import { Effect, Schema } from "effect";
import { HttpApiEndpoint, OpenApi } from "effect/http-api";
import { type EndpointHandler, WorkerContext } from "../http/context";
import { respond } from "../http/respond";
import { REVIEW_CATEGORIES } from "../review/prompt";

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

const EditCounts = Schema.Struct({
  proposed: Schema.Int,
  applied: Schema.Int,
  failed: Schema.Int.annotate({ description: "Failed to apply" }),
});

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
      edits: EditCounts,
      by_category: Schema.Record(Schema.String, EditCounts),
      text_changed_share: Schema.NullOr(Schema.Number).annotate({
        description:
          "Characters changed by applied edits / characters of the reviewed pages",
      }),
      cost_usd: Schema.Number,
      cost_per_page_usd: Schema.NullOr(Schema.Number).annotate({
        description: "Cost / pages reviewed",
      }),
      hand_edited_after_review: Schema.Int.annotate({
        description: "Pages changed by a review and then edited by hand",
      }),
    }),
  },
).annotate(OpenApi.Summary, "Summarize Opus reviews over a time window");

interface StatusRow {
  status: string;
  pages: number;
  proposed: number;
  applied: number;
  failed: number;
  chars_changed: number;
  chars_total: number;
  cost_usd: number;
  hand_edited: number;
}

const CATEGORY_FIELDS = ["proposed", "applied", "failed"] as const;

// e.g. SUM(json_extract(r.categories, '$.tashkeel.applied')) AS tashkeel_applied
const CATEGORY_SUMS = REVIEW_CATEGORIES.flatMap((category) =>
  CATEGORY_FIELDS.map(
    (field) =>
      `SUM(json_extract(r.categories, '$.${category}.${field}')) AS ${category}_${field}`,
  ),
).join(",\n                ");

export const reviewSummary: EndpointHandler<typeof ReviewSummary> = ({
  query,
}) =>
  Effect.gen(function* () {
    const { env } = yield* WorkerContext;
    const since = Date.now() - (query.days ?? DEFAULT_DAYS) * DAY_MS;
    const book = query.book ?? null;
    // One pass over the window's rows (idx_page_reviews_created). Categories
    // are read with json_extract on their fixed keys rather than json_each,
    // which would read every row once per category.
    const { results: statuses } = yield* Effect.promise(() =>
      env.DB.prepare(
        `SELECT r.status, COUNT(*) AS pages,
                SUM(r.edits_proposed) AS proposed, SUM(r.edits_applied) AS applied,
                SUM(r.edits_failed) AS failed, SUM(r.chars_changed) AS chars_changed,
                SUM(r.chars_total) AS chars_total, SUM(r.cost_usd) AS cost_usd,
                SUM(CASE WHEN r.status = 'applied' THEN EXISTS (
                      SELECT 1 FROM text_revisions t
                       WHERE t.file_id = r.file_id AND t.created_at > r.created_at
                         AND t.change = 'edit') ELSE 0 END) AS hand_edited,
                ${CATEGORY_SUMS}
           FROM page_reviews r
          WHERE r.created_at >= ?1 AND (?2 IS NULL OR r.book_id = ?2)
          GROUP BY r.status`,
      )
        .bind(since, book)
        .all<StatusRow & Record<string, number | null>>(),
    );

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

    const categorySum = (column: string) =>
      statuses.reduce((n, row) => n + (row[column] ?? 0), 0);
    const byCategory = Object.fromEntries(
      REVIEW_CATEGORIES.map((category) => [
        category,
        {
          proposed: categorySum(`${category}_proposed`),
          applied: categorySum(`${category}_applied`),
          failed: categorySum(`${category}_failed`),
        },
      ]),
    );

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
        edits: {
          proposed: sum("proposed"),
          applied: sum("applied"),
          failed: sum("failed"),
        },
        by_category: byCategory,
        text_changed_share:
          charsTotal > 0 ? sum("chars_changed") / charsTotal : null,
        cost_usd: costUsd,
        cost_per_page_usd: reviewed > 0 ? costUsd / reviewed : null,
        hand_edited_after_review: sum("hand_edited"),
      },
    });
  });
