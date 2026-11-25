import { Effect, Schema } from "effect";
import { HttpApiEndpoint, HttpApiSchema, OpenApi } from "effect/http-api";
import { type EndpointHandler, WorkerContext } from "../http/context";
import { Conflict, conflict, NotFound, notFound } from "../http/errors";
import { respond } from "../http/respond";
import { RUNNING_STAGES, STUCK_AFTER_MS } from "../review/sweep";
import type { ReviewParams } from "../review/workflow";

// Re-run the Opus review of one page now (a one-off, through the Message
// Batches API like every review).
//
// The page is queued as asked for (requested = 1, tries reset), so the batch
// keeps it even with the book's review off, and a review run is started at
// once instead of waiting for the 3-hourly cron. The run's id is the current
// minute, so rapid clicks (on one page or several) start one run. If a run is
// already going, no second one is started: the page waits for the next run.
export const FileReview = HttpApiEndpoint.post(
  "fileReview",
  "/api/books/:bookId/files/:fileId/review",
  {
    params: { bookId: Schema.String, fileId: Schema.String },
    success: Schema.Struct({
      success: Schema.Boolean,
      queued: Schema.Boolean.annotate({
        description: "The page was newly added to the review queue",
      }),
      already_queued: Schema.Boolean.annotate({
        description: "The page was already waiting or in a running batch",
      }),
      run_started: Schema.Boolean.annotate({
        description:
          "A review run was started (or one started by an earlier click this minute exists); false means the page waits for the next run",
      }),
      instance_id: Schema.NullOr(Schema.String).annotate({
        description: "The review run's Workflow instance id, when run_started",
      }),
    }).pipe(HttpApiSchema.status(202)),
    error: [NotFound, Conflict],
  },
).annotate(OpenApi.Summary, "Re-run the Opus review of one page now");

// Same rules as the book endpoint and the batch builder: done, not blank,
// never hand-edited.
const ELIGIBLE =
  "f.file_id = ? AND f.book_id = ? AND f.state = 'done' AND (f.preview IS NULL OR f.preview <> '') AND f.text_edited_at IS NULL";

const ON_DEMAND_ID_PREFIX = "review-ondemand-";
const MINUTE_MS = 60 * 1000;

export const onDemandInstanceId = (now: number) =>
  `${ON_DEMAND_ID_PREFIX}${Math.floor(now / MINUTE_MS)}`;

interface PageRow {
  file_id: string | null;
  state: string | null;
  preview: string | null;
  text_edited_at: number | null;
  in_queue: number;
  queue_instance: string | null;
}

function ineligibleReason(page: PageRow): string | null {
  if (page.state !== "done") {
    return `Page isn't transcribed yet (state: ${page.state}); only done pages can be reviewed`;
  }
  if (page.preview === "") return "Page is blank; there is nothing to review";
  if (page.text_edited_at !== null) {
    return "Page was edited by hand; a review never overwrites a hand edit";
  }
  return null;
}

// create() throws "(instance.already_exists)" when the id is taken (until the
// instance's retention ends): an earlier click this minute started it.
const isAlreadyExists = (cause: unknown) =>
  cause instanceof Error && cause.message.includes("already_exists");

export const fileReview: EndpointHandler<typeof FileReview> = ({ params }) =>
  Effect.gen(function* () {
    const { env } = yield* WorkerContext;
    const now = Date.now();
    // One round trip. The first statement reads the state before the writes;
    // the writes only touch an eligible page (so a 409 writes nothing): a
    // waiting row becomes asked for with fresh tries, a missing one is
    // inserted, a row in a running batch is left alone. The last counts the
    // runs still going, through idx_review_batches_created (older running
    // rows are stuck and get swept by the cron).
    const [pageRows, , inserted, runningRows] = yield* Effect.promise(() =>
      env.DB.batch([
        env.DB.prepare(
          `SELECT f.file_id, f.state, f.preview, f.text_edited_at,
                  q.file_id IS NOT NULL AS in_queue, q.instance_id AS queue_instance
             FROM books b
             LEFT JOIN files f ON f.file_id = ? AND f.book_id = b.id
             LEFT JOIN review_queue q ON q.file_id = f.file_id
            WHERE b.id = ?`,
        ).bind(params.fileId, params.bookId),
        env.DB.prepare(
          `UPDATE review_queue SET requested = 1, attempts = 0
            WHERE file_id = ? AND instance_id IS NULL
              AND EXISTS (SELECT 1 FROM files f WHERE ${ELIGIBLE})`,
        ).bind(params.fileId, params.fileId, params.bookId),
        env.DB.prepare(
          `INSERT OR IGNORE INTO review_queue (file_id, book_id, queued_at, attempts, requested)
           SELECT f.file_id, f.book_id, ?, 0, 1 FROM files f WHERE ${ELIGIBLE}`,
        ).bind(now, params.fileId, params.bookId),
        env.DB.prepare(
          `SELECT COUNT(*) AS n FROM review_batches
            WHERE created_at >= ? AND stage IN (${RUNNING_STAGES.map(() => "?").join(", ")})`,
        ).bind(now - STUCK_AFTER_MS, ...RUNNING_STAGES),
      ]),
    );
    const page = pageRows?.results[0] as PageRow | undefined;
    if (!page) return yield* notFound(`Book '${params.bookId}' not found`);
    if (page.file_id === null) {
      return yield* notFound(`File '${params.fileId}' not found`);
    }
    const reason = ineligibleReason(page);
    if (reason) return yield* conflict(reason);

    const queued = (inserted?.meta.changes ?? 0) > 0;
    const inRunningBatch = page.queue_instance !== null;
    const running =
      (runningRows?.results[0] as { n: number } | undefined)?.n ?? 0;

    let instanceId: string | null = null;
    if (!inRunningBatch && running === 0) {
      const id = onDemandInstanceId(now);
      const workflowParams: ReviewParams = { reason: "manual" };
      const started = yield* Effect.promise(() =>
        env.REVIEW_WORKFLOW.create({ id, params: workflowParams }).then(
          () => true,
          (cause: unknown) => {
            if (isAlreadyExists(cause)) return true;
            // The page stays queued; the cron's next run picks it up.
            console.error(
              JSON.stringify({
                kind: "review_ondemand",
                instance_id: id,
                error: cause instanceof Error ? cause.message : String(cause),
              }),
            );
            return false;
          },
        ),
      );
      if (started) instanceId = id;
    }

    return respond({
      endpoint: FileReview,
      status: 202,
      body: {
        success: true,
        queued,
        already_queued: page.in_queue === 1,
        run_started: instanceId !== null,
        instance_id: instanceId,
      },
    });
  });
