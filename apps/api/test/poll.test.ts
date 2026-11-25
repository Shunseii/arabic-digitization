import { describe, expect, it } from "vitest";
import {
  nextWaitMs,
  POLL_DEADLINE_MS,
  type PollStep,
  pollUntilEnded,
} from "../src/review/poll";
import { PREPARE_CHUNK_PAGES, REVIEW_BATCH_PAGES } from "../src/review/steps";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const SUBMITTED_AT = 1_000_000;

// The review Workflow's steps outside the poll loop, at most: select, one
// prepare per chunk, submit, record, results, release, dispatch, finalize.
const OTHER_STEPS = 1 + REVIEW_BATCH_PAGES / PREPARE_CHUNK_PAGES + 6;

// A fake step on a simulated clock: each sleep moves time on, and a check
// takes `checkMs`.
function simulate({
  endsAfterChecks = Number.POSITIVE_INFINITY,
  checkMs = 0,
}: {
  endsAfterChecks?: number;
  checkMs?: number;
} = {}) {
  let now = SUBMITTED_AT;
  const sleeps: { name: string; ms: number }[] = [];
  const step: PollStep = {
    sleep: async (name, durationMs) => {
      sleeps.push({ name, ms: durationMs });
      now += durationMs;
    },
  };
  const run = () =>
    pollUntilEnded({
      step,
      submittedAt: SUBMITTED_AT,
      check: async ({ index }) => {
        now += checkMs;
        return { ended: index + 1 >= endsAfterChecks, checkedAt: now };
      },
    });
  return { run, sleeps, elapsed: () => now - SUBMITTED_AT };
}

describe("review batch polling", () => {
  it("checks every minute for an hour, every 10 minutes to 3 hours, then hourly to 26 hours", async () => {
    const sim = simulate();
    const { checks } = await sim.run();
    expect(checks).toBe(60 + 12 + 23);
    expect(sim.sleeps.map((s) => s.ms)).toEqual([
      ...Array(60).fill(MINUTE),
      ...Array(12).fill(10 * MINUTE),
      ...Array(23).fill(HOUR),
    ]);
    expect(sim.sleeps.map((s) => s.name)).toEqual(
      Array.from({ length: checks }, (_, i) => `wait-${i}`),
    );
    expect(sim.elapsed()).toBe(POLL_DEADLINE_MS);
  });

  it("keeps the worst case well under the Free plan's 1,024 steps per instance", async () => {
    const { checks } = await simulate().run();
    // A sleep and a check per poll, counting sleeps as steps to be safe.
    const worstCaseSteps = OTHER_STEPS + 2 * checks;
    expect(worstCaseSteps).toBe(201);
    expect(worstCaseSteps).toBeLessThan(300);
  });

  it("stops at the first check that sees the batch ended", async () => {
    const sim = simulate({ endsAfterChecks: 7 });
    expect(await sim.run()).toMatchObject({ checks: 7, last: { ended: true } });
    expect(sim.elapsed()).toBe(7 * MINUTE);
  });

  it("caps polling at 26 hours of wall-clock time even when checks are slow", async () => {
    const sim = simulate({ checkMs: 20_000 });
    const { checks } = await sim.run();
    expect(checks).toBeLessThan(95);
    expect(sim.elapsed()).toBeGreaterThanOrEqual(POLL_DEADLINE_MS);
    expect(sim.elapsed()).toBeLessThan(POLL_DEADLINE_MS + MINUTE);
  });

  it("never sleeps past the deadline", () => {
    expect(
      nextWaitMs({
        submittedAt: 0,
        lastCheckAt: POLL_DEADLINE_MS - 5 * MINUTE,
      }),
    ).toBe(5 * MINUTE);
    expect(
      nextWaitMs({ submittedAt: 0, lastCheckAt: POLL_DEADLINE_MS }),
    ).toBeNull();
  });
});
