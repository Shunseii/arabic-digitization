import { Effect, Schema } from "effect";
import { HttpApiEndpoint, OpenApi } from "effect/http-api";
import { type EndpointHandler, WorkerContext } from "../http/context";
import { NotFound, notFound } from "../http/errors";
import { respond } from "../http/respond";
import { REVIEW_CATEGORIES } from "../review/prompt";

const ReviewedEdit = Schema.Struct({
  find: Schema.String,
  replace: Schema.String,
  category: Schema.Literals(REVIEW_CATEGORIES),
  applied: Schema.Boolean.annotate({
    description:
      "False when `find` didn't match exactly once (failed to apply)",
  }),
});

const PageReview = Schema.Struct({
  batch_id: Schema.String,
  created_at: Schema.Int,
  model: Schema.String,
  effort: Schema.String,
  attempt: Schema.Int,
  status: Schema.String,
  error_type: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  edits_proposed: Schema.Int,
  edits_applied: Schema.Int,
  edits_failed: Schema.Int,
  edits: Schema.Array(ReviewedEdit),
  chars_changed: Schema.Int,
  chars_total: Schema.Int,
  cost_usd: Schema.Number,
  revision_id: Schema.NullOr(Schema.Int).annotate({
    description:
      "The history entry this review created (GET .../text?rev=<id> is the text before it)",
  }),
});

// One page's Opus reviews, newest first, with each edit and its category.
export const FileReviews = HttpApiEndpoint.get(
  "fileReviews",
  "/api/books/:bookId/files/:fileId/reviews",
  {
    params: { bookId: Schema.String, fileId: Schema.String },
    success: Schema.Struct({
      success: Schema.Boolean,
      file_id: Schema.String,
      reviews: Schema.Array(PageReview),
    }),
    error: NotFound,
  },
).annotate(OpenApi.Summary, "List a file's Opus reviews and their edits");

type PageReviewRow = Omit<typeof PageReview.Type, "edits"> & {
  edits: string | null;
};

export const fileReviews: EndpointHandler<typeof FileReviews> = ({ params }) =>
  Effect.gen(function* () {
    const { env } = yield* WorkerContext;
    const [fileRows, reviewRows] = yield* Effect.promise(() =>
      env.DB.batch([
        env.DB.prepare(
          "SELECT 1 FROM files WHERE file_id = ? AND book_id = ?",
        ).bind(params.fileId, params.bookId),
        // The primary key leads with file_id.
        env.DB.prepare(
          `SELECT batch_id, created_at, model, effort, attempt, status, error_type, error,
                  edits_proposed, edits_applied, edits_failed, edits, chars_changed,
                  chars_total, cost_usd, revision_id
             FROM page_reviews WHERE file_id = ? ORDER BY created_at DESC`,
        ).bind(params.fileId),
      ]),
    );
    if (!fileRows?.results.length) {
      return yield* notFound(`File '${params.fileId}' not found`);
    }
    const reviews = ((reviewRows?.results ?? []) as PageReviewRow[]).map(
      (row) => ({
        ...row,
        edits: row.edits
          ? (JSON.parse(row.edits) as (typeof ReviewedEdit.Type)[])
          : [],
      }),
    );
    return respond({
      endpoint: FileReviews,
      body: { success: true, file_id: params.fileId, reviews },
    });
  });
