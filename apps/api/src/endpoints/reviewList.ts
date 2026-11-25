import { Effect, Schema } from "effect";
import { HttpApiEndpoint, OpenApi } from "effect/http-api";
import { type EndpointHandler, WorkerContext } from "../http/context";
import { respond } from "../http/respond";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 30;
const MAX_DAYS = 90;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const RecentReview = Schema.Struct({
  file_id: Schema.String,
  batch_id: Schema.String,
  book_id: Schema.String,
  book_title: Schema.NullOr(Schema.String),
  page_number: Schema.NullOr(Schema.Int).annotate({
    description: "Null if the page is unnumbered or was deleted since",
  }),
  created_at: Schema.Int,
  model: Schema.String,
  effort: Schema.String,
  status: Schema.String,
  edits_proposed: Schema.Int,
  edits_applied: Schema.Int,
  edits_failed: Schema.Int,
  chars_changed: Schema.Int,
  cost_usd: Schema.Number,
  revision_id: Schema.NullOr(Schema.Int).annotate({
    description:
      "The history entry this review created (GET .../text?rev=<id> is the text before it)",
  }),
});

// The newest page reviews across books (or one book), for the Usage screen's
// list of reviewed pages. The edits themselves are on GET .../files/:fileId/reviews.
export const ReviewList = HttpApiEndpoint.get("reviewList", "/api/reviews", {
  query: {
    days: Schema.optionalKey(
      Schema.Int.check(
        Schema.isGreaterThanOrEqualTo(1),
        Schema.isLessThanOrEqualTo(MAX_DAYS),
      ).annotate({
        description: `Window in days (1-${MAX_DAYS}, default ${DEFAULT_DAYS})`,
      }),
    ),
    limit: Schema.optionalKey(
      Schema.Int.check(
        Schema.isGreaterThanOrEqualTo(1),
        Schema.isLessThanOrEqualTo(MAX_LIMIT),
      ).annotate({
        description: `Most reviews to return (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT})`,
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
    reviews: Schema.Array(RecentReview).annotate({
      description: "Newest first",
    }),
  }),
}).annotate(OpenApi.Summary, "List recent page reviews");

const COLUMNS = `r.file_id, r.batch_id, r.book_id, b.title AS book_title, f.page_number,
       r.created_at, r.model, r.effort, r.status, r.edits_proposed, r.edits_applied,
       r.edits_failed, r.chars_changed, r.cost_usd, r.revision_id`;

const JOINS = `LEFT JOIN books b ON b.id = r.book_id
  LEFT JOIN files f ON f.file_id = r.file_id`;

// Each walks an index newest first and stops at the limit: the book and the
// page are one primary-key lookup per listed review.
const ALL_BOOKS_SQL = `SELECT ${COLUMNS} FROM page_reviews r ${JOINS}
  WHERE r.created_at >= ?1 ORDER BY r.created_at DESC LIMIT ?2`;
const ONE_BOOK_SQL = `SELECT ${COLUMNS} FROM page_reviews r ${JOINS}
  WHERE r.book_id = ?3 AND r.created_at >= ?1 ORDER BY r.created_at DESC LIMIT ?2`;

export const reviewList: EndpointHandler<typeof ReviewList> = ({ query }) =>
  Effect.gen(function* () {
    const { env } = yield* WorkerContext;
    const since = Date.now() - (query.days ?? DEFAULT_DAYS) * DAY_MS;
    const limit = query.limit ?? DEFAULT_LIMIT;
    const book = query.book ?? null;
    const statement =
      book === null
        ? env.DB.prepare(ALL_BOOKS_SQL).bind(since, limit)
        : env.DB.prepare(ONE_BOOK_SQL).bind(since, limit, book);
    const { results } = yield* Effect.promise(() =>
      statement.all<typeof RecentReview.Type>(),
    );
    return respond({
      endpoint: ReviewList,
      body: { success: true, since, book_id: book, reviews: results },
    });
  });
