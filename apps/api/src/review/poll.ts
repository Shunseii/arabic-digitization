// When the review Workflow checks a submitted batch's status. Checks run on a
// schedule (every 30 minutes for the first 2 hours, then hourly), and a
// "check-now" event (POST /api/reviews/batches/:instanceId/check) wakes the
// current wait early; the wake replaces the scheduled one, and the next wait
// is a full interval from that check. Polling stops 26 hours after submission
// by wall-clock time, however many checks ran.
//
// Kept apart from the Workflow class (which imports cloudflare:workers) so
// tests can drive it with a fake step.

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

export const CHECK_NOW_EVENT = "check-now";
export const POLL_DEADLINE_MS = 26 * HOUR_MS;
const FAST_POLL_FOR_MS = 2 * HOUR_MS;
const FAST_POLL_MS = 30 * MINUTE_MS;
const SLOW_POLL_MS = HOUR_MS;
// The check endpoint refuses a nudge this soon after a check, and a check
// woken this soon after the last one (an event buffered while the previous
// check ran) skips the Anthropic call.
export const MIN_CHECK_GAP_MS = MINUTE_MS;
// Nudged wakes per batch. Past this the Workflow just sleeps, so a spammed
// button can't exhaust the instance's step budget.
export const MAX_NUDGED_WAKES = 20;

export function pollIntervalMs(sinceSubmitMs: number): number {
  return sinceSubmitMs < FAST_POLL_FOR_MS ? FAST_POLL_MS : SLOW_POLL_MS;
}

// How long to wait after a check at `lastCheckAt`, or null when the 26-hour
// deadline has passed.
export function nextWaitMs({
  submittedAt,
  lastCheckAt,
}: {
  submittedAt: number;
  lastCheckAt: number;
}): number | null {
  const remaining = submittedAt + POLL_DEADLINE_MS - lastCheckAt;
  if (remaining <= 0) return null;
  return Math.min(pollIntervalMs(lastCheckAt - submittedAt), remaining);
}

// The parts of WorkflowStep the loop uses.
export interface PollStep {
  waitForEvent: (
    name: string,
    options: { type: string; timeout: number },
  ) => Promise<unknown>;
  sleep: (name: string, durationMs: number) => Promise<void>;
}

export interface PollCheck {
  ended: boolean;
  // When the check step ran (its own clock), so the loop's timing comes from
  // step results and replays the same way.
  checkedAt: number;
}

export interface PollOutcome<C extends PollCheck> {
  last: C | null;
  checks: number;
  nudged: number;
}

export async function pollUntilEnded<C extends PollCheck>({
  step,
  submittedAt,
  check,
}: {
  step: PollStep;
  submittedAt: number;
  // Runs check-<index> as a step. `nudged`: woken by a check-now event;
  // `nudgedSoFar`: nudged wakes including this one.
  check: (request: {
    index: number;
    nudged: boolean;
    nudgedSoFar: number;
  }) => Promise<C>;
}): Promise<PollOutcome<C>> {
  let last: C | null = null;
  let lastCheckAt = submittedAt;
  let nudged = 0;
  for (let index = 0; ; index++) {
    const waitMs = nextWaitMs({ submittedAt, lastCheckAt });
    if (waitMs === null) return { last, checks: index, nudged };
    let wokenByEvent = false;
    if (nudged < MAX_NUDGED_WAKES) {
      try {
        await step.waitForEvent(`wait-${index}`, {
          type: CHECK_NOW_EVENT,
          timeout: waitMs,
        });
        wokenByEvent = true;
        nudged += 1;
      } catch {
        // Timed out: the scheduled check.
      }
    } else {
      await step.sleep(`wait-${index}`, waitMs);
    }
    last = await check({ index, nudged: wokenByEvent, nudgedSoFar: nudged });
    lastCheckAt = last.checkedAt;
    if (last.ended) return { last, checks: index + 1, nudged };
  }
}
