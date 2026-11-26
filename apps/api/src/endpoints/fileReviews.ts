import { Effect, Schema } from "effect";
import { HttpApiEndpoint, OpenApi } from "effect/http-api";
import { type EndpointHandler, WorkerContext } from "../http/context";
import { NotFound, notFound } from "../http/errors";
import { respond } from "../http/respond";
import type { PageReviewDetail } from "../review/apply";

const ReviewedEdit = Schema.Struct({
  find: Schema.String,
  replace: Schema.String,
  category: Schema.String,
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
  format: Schema.NullOr(Schema.Literals(["full_page", "edits"])).annotate({
    description:
      "full_page: Opus returned the corrected page, diffed by the server (words_*); edits: an older find-and-replace review (edits, edits_*); null: no answer was compared with the page",
  }),
  words_added: Schema.NullOr(Schema.Int).annotate({
    description: "Word diff of the correction (full_page only)",
  }),
  words_removed: Schema.NullOr(Schema.Int),
  edits_proposed: Schema.Int.annotate({
    description: "Older find-and-replace reviews only; 0 for full_page",
  }),
  edits_applied: Schema.Int,
  edits_failed: Schema.Int.annotate({
    description: "Edits whose find didn't match exactly once",
  }),
  edits: Schema.Array(ReviewedEdit).annotate({
    description: "Older find-and-replace reviews only; empty otherwise",
  }),
  chars_changed: Schema.Int,
  chars_total: Schema.Int,
  cost_usd: Schema.Number,
  revision_id: Schema.NullOr(Schema.Int).annotate({
    description:
      "The history entry this review created (GET .../text?rev=<id> is the text before it)",
  }),
});

// One page's Opus reviews, newest first, with how much each changed (a
// full-page review) or its edits (an older find-and-replace one).
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
).annotate(OpenApi.Summary, "List a file's Opus reviews and what they changed");

type PageReviewRow = Omit<
  typeof PageReview.Type,
  "format" | "words_added" | "words_removed" | "edits"
> & {
  edits: string | null;
};

type ReviewDetails = Pick<
  typeof PageReview.Type,
  "format" | "words_added" | "words_removed" | "edits"
>;

// page_reviews.edits holds the edit list of a find-and-replace review (an
// array) or the word counts of a full-page one (an object).
const readDetails = (json: string | null): ReviewDetails => {
  const none = {
    words_added: null,
    words_removed: null,
    edits: [],
  };
  if (!json) return { format: null, ...none };
  const parsed = JSON.parse(json) as
    | (typeof ReviewedEdit.Type)[]
    | PageReviewDetail;
  if (Array.isArray(parsed)) {
    return { ...none, format: "edits", edits: parsed };
  }
  return {
    ...none,
    format: "full_page",
    words_added: parsed.words_added,
    words_removed: parsed.words_removed,
  };
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
      ({ edits, ...row }) => ({ ...row, ...readDetails(edits) }),
    );
    return respond({
      endpoint: FileReviews,
      body: { success: true, file_id: params.fileId, reviews },
    });
  });
