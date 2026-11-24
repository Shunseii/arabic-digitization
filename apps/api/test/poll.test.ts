import { describe, expect, it } from "vitest";
import {
  CHECK_NOW_EVENT,
  MAX_NUDGED_WAKES,
  POLL_DEADLINE_MS,
  type PollStep,
  pollUntilEnded,
} from "../src/review/poll";

const MINUTE = 60_000;
const SUBMITTED_AT = 1_000_000;

// A fake Workflow step on a simulated clock. `nudgeAfterMs(index)` says when
// a check-now event arrives during wait-<index> (null: none, so it times out).
function simulate({
  nudgeAfterMs = () => null,
  endsAfterChecks = Number.POSITIVE_INFINITY,
}: {
  nudgeAfterMs?: (index: number) => number | null;
  endsAfterChecks?: number;
}) {
  let now = SUBMITTED_AT;
  const log: string[] = [];
  const waits: { name: string; kind: string; ms: number }[] = [];
  const step: PollStep = {
    waitForEvent: async (name, { type, timeout }) => {
      expect(type).toBe(CHECK_NOW_EVENT);
      waits.push({ name, kind: "event", ms: timeout });
      const index = Number(name.slice("wait-".length));
      const nudge = nudgeAfterMs(index);
      if (nudge !== null && nudge < timeout) {
        now += nudge;
        return { type };
      }
      now += timeout;
      throw new Error("timed out");
    },
    sleep: async (name, durationMs) => {
      waits.push({ name, kind: "sleep", ms: durationMs });
      now += durationMs;
    },
  };
  const run = () =>
    pollUntilEnded({
      step,
      submittedAt: SUBMITTED_AT,
      check: async ({ index, nudged, nudgedSoFar }) => {
        log.push(`check-${index}${nudged ? ` nudged#${nudgedSoFar}` : ""}`);
        return { ended: index + 1 >= endsAfterChecks, checkedAt: now };
      },
    });
  return { run, log, waits, elapsed: () => now - SUBMITTED_AT };
}

describe("pollUntilEnded", () => {
  it("keeps the old schedule when nobody nudges: 4 checks 30 minutes apart, then hourly, for 26 hours", async () => {
    const sim = simulate({});
    const outcome = await sim.run();
    expect(outcome).toMatchObject({ checks: 28, nudged: 0 });
    expect(sim.waits.map((w) => w.ms)).toEqual([
      ...Array(4).fill(30 * MINUTE),
      ...Array(24).fill(60 * MINUTE),
    ]);
    expect(sim.elapsed()).toBe(POLL_DEADLINE_MS);
    expect(sim.waits.map((w) => w.name)).toEqual(
      Array.from({ length: 28 }, (_, i) => `wait-${i}`),
    );
  });

  it("stops at the first check that sees the batch ended", async () => {
    const sim = simulate({ endsAfterChecks: 2 });
    expect(await sim.run()).toMatchObject({ checks: 2, last: { ended: true } });
  });

  it("checks early on a nudge, then waits a full interval from that check", async () => {
    const sim = simulate({
      nudgeAfterMs: (i) => (i === 0 ? 10 * MINUTE : null),
    });
    await sim.run();
    expect(sim.log.slice(0, 2)).toEqual(["check-0 nudged#1", "check-1"]);
    expect(sim.waits.slice(0, 2).map((w) => w.ms)).toEqual([
      30 * MINUTE,
      30 * MINUTE,
    ]);
    // Still stops 26 hours after submission by wall-clock time.
    expect(sim.elapsed()).toBe(POLL_DEADLINE_MS);
  });

  it("stops listening after MAX_NUDGED_WAKES, so spamming can't exhaust the step budget", async () => {
    // A nudge a minute into every wait, for the whole 26 hours.
    const sim = simulate({ nudgeAfterMs: () => MINUTE });
    const outcome = await sim.run();
    expect(outcome.nudged).toBe(MAX_NUDGED_WAKES);
    const events = sim.waits.filter((w) => w.kind === "event");
    expect(events).toHaveLength(MAX_NUDGED_WAKES);
    // After the cap the scheduled checks continue as plain sleeps until the
    // deadline: at most 28 scheduled wakes plus the nudged ones.
    expect(sim.waits[MAX_NUDGED_WAKES]?.kind).toBe("sleep");
    expect(outcome.checks).toBeLessThanOrEqual(28 + MAX_NUDGED_WAKES);
    expect(sim.elapsed()).toBe(POLL_DEADLINE_MS);
  });

  it("shortens the last wait to the deadline", async () => {
    // Nudged 25 minutes into the first wait: hourly checks then land 25
    // minutes off the hour, so the last wait is cut short.
    const sim = simulate({
      nudgeAfterMs: (i) => (i === 0 ? 25 * MINUTE : null),
    });
    await sim.run();
    expect(sim.waits.at(-1)?.ms).toBeLessThan(60 * MINUTE);
    expect(sim.elapsed()).toBe(POLL_DEADLINE_MS);
  });
});
