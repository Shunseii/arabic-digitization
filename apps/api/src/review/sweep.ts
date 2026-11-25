// Frees the pages of review batches whose Workflow instance stopped without
// finishing (a step ran out of retries and the error step failed too, or the
// instance was terminated). Run by the cron before it starts a new batch.

import { Effect } from "effect";
import type { StorageError } from "../effect/errors";
import {
  Database,
  ReviewInstances,
  statement,
  WallClock,
} from "../effect/services";
import { REVIEW_MAX_ATTEMPTS } from "./message";
import { POLL_DEADLINE_MS } from "./poll";

const HOUR_MS = 60 * 60 * 1000;
// A live instance is done polling 26 hours after submission; two more hours
// cover the steps after polling and a late start.
export const STUCK_AFTER_MS = POLL_DEADLINE_MS + 2 * HOUR_MS;
// Instances are kept 3 days on the Free plan; past a week a row this old in a
// running stage would already have been swept. Bounds the index range read.
const SWEEP_WINDOW_MS = 7 * 24 * HOUR_MS;

export const RUNNING_STAGES = [
  "preparing",
  "submitting",
  "processing",
  "ingesting",
];
// Instance states that mean it will never write its stage again. A status
// that can't be read (null) means the instance is gone.
const DEAD = new Set(["errored", "terminated", "unknown"]);

export interface SweepResult {
  checked: number;
  failed: string[];
}

export function sweepStuckBatches(): Effect.Effect<
  SweepResult,
  StorageError,
  Database | ReviewInstances | WallClock
> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const instances = yield* ReviewInstances;
    const clock = yield* WallClock;
    const now = clock.now();
    // Reads only the batches started in the window (idx_review_batches_created).
    const rows = yield* db.all<{ instance_id: string }>(
      statement(
        `SELECT instance_id FROM review_batches
          WHERE created_at >= ? AND created_at < ?
            AND stage IN (${RUNNING_STAGES.map(() => "?").join(", ")})`,
        [now - SWEEP_WINDOW_MS, now - STUCK_AFTER_MS, ...RUNNING_STAGES],
      ),
    );
    const failed: string[] = [];
    for (const { instance_id: instanceId } of rows) {
      const status = yield* instances.status(instanceId);
      if (status !== null && !DEAD.has(status)) continue;
      // Each claimed page gets its try counted; one out of tries leaves the
      // queue (it isn't reviewed until OCR queues it again).
      yield* db.batch([
        statement(
          `UPDATE review_queue SET instance_id = NULL, attempts = attempts + 1
            WHERE instance_id = ? AND attempts + 1 < ?`,
          [instanceId, REVIEW_MAX_ATTEMPTS],
        ),
        statement("DELETE FROM review_queue WHERE instance_id = ?", [
          instanceId,
        ]),
        statement(
          `UPDATE review_batches SET stage = 'failed', error = ?, ended_at = COALESCE(ended_at, ?)
            WHERE instance_id = ?`,
          [
            `Workflow instance ${status ?? "gone"}; pages released`,
            now,
            instanceId,
          ],
        ),
      ]);
      failed.push(instanceId);
    }
    return { checked: rows.length, failed };
  });
}
