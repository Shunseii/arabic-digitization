import { Effect, Schema } from "effect";
import { HttpApiEndpoint, OpenApi } from "effect/http-api";
import { type EndpointHandler, WorkerContext } from "../http/context";
import { respond } from "../http/respond";

// How far back the OCR activity looks: the newest RECENT_RUNS runs, and only
// those from the last day. Walking ocr_runs backwards by id reads exactly
// that many rows, with no index on created_at.
const RECENT_RUNS = 300;
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const PROBLEM_PAGES = 10;
// Newest review batches read; in-flight ones (one started every 3 hours, each
// done within ~26 hours) are always among them.
const RECENT_BATCHES = 15;
const FINISHED_BATCHES = 10;

const ACTIVE_STAGES = new Set([
  "preparing",
  "submitting",
  "processing",
  "ingesting",
]);
// Instance states that mean the Workflow stopped without writing its stage.
const DEAD_INSTANCE = new Set(["errored", "terminated"]);

const RequestCounts = Schema.Struct({
  processing: Schema.Int,
  succeeded: Schema.Int,
  errored: Schema.Int,
  expired: Schema.Int,
  canceled: Schema.Int,
});

const OcrBook = Schema.Struct({
  book_id: Schema.String,
  title: Schema.String,
  paused: Schema.Boolean,
  queued: Schema.Int,
  processing: Schema.Int,
  rate_limited: Schema.Int,
  failed: Schema.Int,
  oldest_queued_at: Schema.NullOr(Schema.Int),
  done_last_hour: Schema.Int,
  recent_runs: Schema.Int,
  fell_back: Schema.Int,
  retried: Schema.Int,
});

const ProblemPage = Schema.Struct({
  file_id: Schema.String,
  book_id: Schema.String,
  created_at: Schema.Int,
  status: Schema.String,
  final_model: Schema.NullOr(Schema.String),
  fell_back: Schema.Boolean,
  fallback_reason: Schema.NullOr(Schema.String),
  delivery_attempt: Schema.Int,
  error_type: Schema.NullOr(Schema.String),
});

const ReviewBatch = Schema.Struct({
  instance_id: Schema.String,
  batch_id: Schema.NullOr(Schema.String),
  stage: Schema.String.annotate({
    description:
      "preparing | submitting | processing | ingesting | applying | done | empty | timed_out | failed",
  }),
  instance_status: Schema.NullOr(Schema.String).annotate({
    description:
      "The Workflow instance's coarse status (running, waiting, errored, ...), for in-flight batches only",
  }),
  pages: Schema.Int,
  reviewed: Schema.Int.annotate({
    description: "Pages whose review has been recorded",
  }),
  created_at: Schema.Int,
  submitted_at: Schema.NullOr(Schema.Int),
  ended_at: Schema.NullOr(Schema.Int).annotate({
    description: "When a status check first saw the batch ended",
  }),
  anthropic_ended_at: Schema.NullOr(Schema.Int).annotate({
    description:
      "When Anthropic finished the batch (ended_at minus this is the polling lag)",
  }),
  checks: Schema.NullOr(Schema.Int).annotate({
    description: "Status checks run; set when the batch is finalized",
  }),
  steps: Schema.NullOr(Schema.Int).annotate({
    description:
      "Workflow steps used (sleeps included); set when the batch is finalized",
  }),
  request_counts: RequestCounts,
  edits_applied: Schema.Int,
  edits_failed: Schema.Int,
  errors: Schema.Int.annotate({
    description: "Pages that ended without a review (failed or retried)",
  }),
  cost_usd: Schema.Number,
  error: Schema.NullOr(Schema.String),
});

const WaitingBook = Schema.Struct({
  book_id: Schema.String,
  title: Schema.String,
  pages: Schema.Int,
  retrying: Schema.Int.annotate({
    description: "Pages waiting for another try after a server error or expiry",
  }),
});

// Running work, for the desktop Activity screen. Reads only D1 (plus the
// Workflow binding for in-flight batches): never Anthropic.
export const Jobs = HttpApiEndpoint.get("jobs", "/api/jobs", {
  success: Schema.Struct({
    success: Schema.Boolean,
    now: Schema.Int,
    ocr: Schema.Struct({
      books: Schema.Array(OcrBook),
      recent_since: Schema.Int.annotate({
        description:
          "Start of the window behind recent_runs / fell_back / retried / done_last_hour",
      }),
      problem_pages: Schema.Array(ProblemPage),
    }),
    review: Schema.Struct({
      in_flight: Schema.Array(ReviewBatch),
      waiting: Schema.Array(WaitingBook),
      recent: Schema.Array(ReviewBatch),
    }),
  }),
}).annotate(OpenApi.Summary, "Running OCR and review work");

interface StateCountRow {
  book_id: string;
  title: string;
  paused: number;
  queued: number;
  processing: number;
  rate_limited: number;
  failed: number;
}

interface RecentRunRow {
  book_id: string;
  title: string;
  paused: number;
  recent_runs: number;
  done_last_hour: number;
  fell_back: number;
  retried: number;
}

interface ProblemRow {
  file_id: string;
  book_id: string;
  created_at: number;
  status: string;
  final_model: string | null;
  fell_back: number;
  fallback_reason: string | null;
  delivery_attempt: number;
  error_type: string | null;
}

interface BatchRow {
  instance_id: string;
  batch_id: string | null;
  stage: string;
  pages: number;
  created_at: number;
  submitted_at: number | null;
  ended_at: number | null;
  anthropic_ended_at: number | null;
  checks: number | null;
  steps: number | null;
  processing: number;
  succeeded: number;
  errored: number;
  expired: number;
  canceled: number;
  error: string | null;
}

interface BatchReviewRow {
  batch_id: string;
  reviewed: number;
  edits_applied: number;
  edits_failed: number;
  errors: number;
  cost_usd: number;
}

async function instanceStatus({
  env,
  instanceId,
}: {
  env: Env;
  instanceId: string;
}): Promise<string | null> {
  try {
    const instance = await env.REVIEW_WORKFLOW.get(instanceId);
    return (await instance.status()).status;
  } catch {
    return null;
  }
}

export const jobs: EndpointHandler<typeof Jobs> = () =>
  Effect.gen(function* () {
    const { env } = yield* WorkerContext;
    const now = Date.now();
    const recentSince = now - RECENT_WINDOW_MS;

    const [stateRows, runRows, problemRows, batchRows, waitingRows] =
      yield* Effect.promise(() =>
        env.DB.batch([
          // Per-book counters kept by triggers (migration 0005): no files scan.
          env.DB.prepare(
            `SELECT c.book_id, b.title, b.paused,
                    SUM(CASE WHEN c.state = 'queued' THEN c.n ELSE 0 END) AS queued,
                    SUM(CASE WHEN c.state = 'processing' THEN c.n ELSE 0 END) AS processing,
                    SUM(CASE WHEN c.state = 'rate_limited' THEN c.n ELSE 0 END) AS rate_limited,
                    SUM(CASE WHEN c.state = 'failed' THEN c.n ELSE 0 END) AS failed
               FROM book_state_counts c JOIN books b ON b.id = c.book_id
              WHERE c.state IN ('queued', 'processing', 'rate_limited', 'failed') AND c.n > 0
              GROUP BY c.book_id`,
          ),
          // Aggregated first, so books are joined once per book, not per run.
          env.DB.prepare(
            `SELECT r.*, b.title, b.paused
               FROM (SELECT book_id, COUNT(*) AS recent_runs,
                            SUM(status = 'done' AND created_at > ?) AS done_last_hour,
                            SUM(fell_back) AS fell_back,
                            SUM(delivery_attempt > 1) AS retried
                       FROM (SELECT book_id, status, created_at, fell_back, delivery_attempt
                               FROM ocr_runs ORDER BY id DESC LIMIT ?)
                      WHERE created_at > ?
                      GROUP BY book_id) r
               JOIN books b ON b.id = r.book_id`,
          ).bind(now - HOUR_MS, RECENT_RUNS, recentSince),
          env.DB.prepare(
            `SELECT file_id, book_id, created_at, status, final_model, fell_back,
                    fallback_reason, delivery_attempt, error_type
               FROM (SELECT * FROM ocr_runs ORDER BY id DESC LIMIT ?)
              WHERE created_at > ?
                AND (fell_back = 1 OR delivery_attempt > 2 OR status = 'failed')
              LIMIT ?`,
          ).bind(RECENT_RUNS, recentSince, PROBLEM_PAGES),
          env.DB.prepare(
            `SELECT instance_id, batch_id, stage, pages, created_at, submitted_at,
                    ended_at, anthropic_ended_at, checks, steps, processing, succeeded,
                    errored, expired, canceled, error
               FROM review_batches ORDER BY created_at DESC LIMIT ?`,
          ).bind(RECENT_BATCHES),
          env.DB.prepare(
            `SELECT q.book_id, b.title, COUNT(*) AS pages, SUM(q.attempts > 0) AS retrying
               FROM review_queue q JOIN books b ON b.id = q.book_id
              WHERE q.instance_id IS NULL
              GROUP BY q.book_id`,
          ),
        ]),
      );
    const states = (stateRows?.results ?? []) as StateCountRow[];
    const runs = (runRows?.results ?? []) as RecentRunRow[];
    const problems = (problemRows?.results ?? []) as ProblemRow[];
    const batches = (batchRows?.results ?? []) as BatchRow[];
    const waiting = (waitingRows?.results ?? []) as {
      book_id: string;
      title: string;
      pages: number;
      retrying: number;
    }[];

    // Oldest queued page, only for books that are being OCR'd and have one
    // (the counters say which; a paused book's pages wait by design). Reads
    // those books' rows through idx_files_book_order: files has no state index
    // (dropped to save writes), and this is the one read that grows with a
    // book's size.
    const queuedBooks = states
      .filter((s) => s.queued > 0 && s.paused === 0)
      .map((s) => s.book_id);
    const oldest = new Map<string, number>();
    if (queuedBooks.length > 0) {
      const { results } = yield* Effect.promise(() =>
        env.DB.prepare(
          `SELECT book_id, MIN(updated_at) AS oldest FROM files
            WHERE book_id IN (${queuedBooks.map(() => "?").join(", ")}) AND state = 'queued'
            GROUP BY book_id`,
        )
          .bind(...queuedBooks)
          .all<{ book_id: string; oldest: number }>(),
      );
      for (const row of results) oldest.set(row.book_id, row.oldest);
    }

    const books = new Map<string, typeof OcrBook.Type>();
    const blank = (row: {
      book_id: string;
      title: string;
      paused: number;
    }) => ({
      book_id: row.book_id,
      title: row.title,
      paused: row.paused === 1,
      queued: 0,
      processing: 0,
      rate_limited: 0,
      failed: 0,
      oldest_queued_at: oldest.get(row.book_id) ?? null,
      done_last_hour: 0,
      recent_runs: 0,
      fell_back: 0,
      retried: 0,
    });
    for (const row of states) {
      books.set(row.book_id, {
        ...blank(row),
        queued: row.queued,
        processing: row.processing,
        rate_limited: row.rate_limited,
        failed: row.failed,
      });
    }
    for (const row of runs) {
      books.set(row.book_id, {
        ...(books.get(row.book_id) ?? blank(row)),
        done_last_hour: row.done_last_hour,
        recent_runs: row.recent_runs,
        fell_back: row.fell_back,
        retried: row.retried,
      });
    }

    // Each listed batch's recorded reviews, through idx_page_reviews_created
    // from the oldest listed batch on.
    const batchIds = batches
      .map((b) => b.batch_id)
      .filter((id): id is string => id !== null);
    const oldestBatch = batches.at(-1)?.created_at ?? now;
    const reviewTotals = new Map<string, BatchReviewRow>();
    if (batchIds.length > 0) {
      const { results } = yield* Effect.promise(() =>
        env.DB.prepare(
          `SELECT batch_id, COUNT(*) AS reviewed,
                  SUM(edits_applied) AS edits_applied, SUM(edits_failed) AS edits_failed,
                  SUM(status IN ('failed', 'errored', 'expired', 'canceled', 'invalid_output', 'refused')) AS errors,
                  SUM(cost_usd) AS cost_usd
             FROM page_reviews
            WHERE created_at >= ? AND batch_id IN (${batchIds.map(() => "?").join(", ")})
            GROUP BY batch_id`,
        )
          .bind(oldestBatch, ...batchIds)
          .all<BatchReviewRow>(),
      );
      for (const row of results) reviewTotals.set(row.batch_id, row);
    }

    const inFlight: (typeof ReviewBatch.Type)[] = [];
    const recent: (typeof ReviewBatch.Type)[] = [];
    for (const row of batches) {
      const totals = row.batch_id ? reviewTotals.get(row.batch_id) : undefined;
      const reviewed = totals?.reviewed ?? 0;
      const active =
        ACTIVE_STAGES.has(row.stage) ||
        (row.stage === "applying" && reviewed < row.pages);
      const status = active
        ? yield* Effect.promise(() =>
            instanceStatus({ env, instanceId: row.instance_id }),
          )
        : null;
      const stoppedEarly =
        ACTIVE_STAGES.has(row.stage) && status && DEAD_INSTANCE.has(status);
      const batch = {
        instance_id: row.instance_id,
        batch_id: row.batch_id,
        stage: stoppedEarly
          ? "failed"
          : row.stage === "applying" && !active
            ? "done"
            : row.stage,
        instance_status: status,
        pages: row.pages,
        reviewed,
        created_at: row.created_at,
        submitted_at: row.submitted_at,
        ended_at: row.ended_at,
        anthropic_ended_at: row.anthropic_ended_at,
        checks: row.checks,
        steps: row.steps,
        request_counts: {
          processing: row.processing,
          succeeded: row.succeeded,
          errored: row.errored,
          expired: row.expired,
          canceled: row.canceled,
        },
        edits_applied: totals?.edits_applied ?? 0,
        edits_failed: totals?.edits_failed ?? 0,
        errors: totals?.errors ?? 0,
        cost_usd: totals?.cost_usd ?? 0,
        error: row.error,
      };
      if (active && !stoppedEarly) inFlight.push(batch);
      else if (recent.length < FINISHED_BATCHES) recent.push(batch);
    }

    return respond({
      endpoint: Jobs,
      body: {
        success: true,
        now,
        ocr: {
          books: [...books.values()],
          recent_since: recentSince,
          problem_pages: problems.map((row) => ({
            ...row,
            fell_back: row.fell_back === 1,
          })),
        },
        review: { in_flight: inFlight, waiting, recent },
      },
    });
  });
