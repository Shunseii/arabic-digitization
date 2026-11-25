// When the review Workflow checks a submitted batch's status: every minute
// for the first hour after submission (most batches end within it), every 10
// minutes until 3 hours, then hourly until 26 hours by wall-clock time (a
// batch ends within 24; past 26 the Workflow gives up). 95 checks at most.
// Sleeps cost no CPU; each check is one step.
//
// Kept apart from the Workflow class (which imports cloudflare:workers) so
// tests can drive it with a fake step.

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

export const POLL_DEADLINE_MS = 26 * HOUR_MS;

const SCHEDULE: readonly { until: number; everyMs: number }[] = [
  { until: HOUR_MS, everyMs: MINUTE_MS },
  { until: 3 * HOUR_MS, everyMs: 10 * MINUTE_MS },
  { until: POLL_DEADLINE_MS, everyMs: HOUR_MS },
];

// How long to wait after a check at `lastCheckAt`, or null once the deadline
// has passed. A wait never runs past the deadline.
export function nextWaitMs({
  submittedAt,
  lastCheckAt,
}: {
  submittedAt: number;
  lastCheckAt: number;
}): number | null {
  const elapsed = lastCheckAt - submittedAt;
  const remaining = POLL_DEADLINE_MS - elapsed;
  if (remaining <= 0) return null;
  const everyMs =
    SCHEDULE.find((phase) => elapsed < phase.until)?.everyMs ?? HOUR_MS;
  return Math.min(everyMs, remaining);
}

// The part of WorkflowStep the loop uses.
export interface PollStep {
  sleep: (name: string, durationMs: number) => Promise<void>;
}

export interface PollCheck {
  ended: boolean;
  // When the check step ran (its own clock), so the loop's timing comes from
  // step results and replays the same way.
  checkedAt: number;
}

// Sleep, check, repeat until a check sees the batch ended or the deadline
// passes. Returns the last check (null if none ran) and how many ran.
export async function pollUntilEnded<C extends PollCheck>({
  step,
  submittedAt,
  check,
}: {
  step: PollStep;
  submittedAt: number;
  // Runs check-<index> as a step; `previous` is the check before it.
  check: (request: { index: number; previous: C | null }) => Promise<C>;
}): Promise<{ last: C | null; checks: number }> {
  let last: C | null = null;
  let lastCheckAt = submittedAt;
  for (let index = 0; ; index++) {
    const waitMs = nextWaitMs({ submittedAt, lastCheckAt });
    if (waitMs === null) return { last, checks: index };
    await step.sleep(`wait-${index}`, waitMs);
    last = await check({ index, previous: last });
    lastCheckAt = last.checkedAt;
    if (last.ended) return { last, checks: index + 1 };
  }
}
