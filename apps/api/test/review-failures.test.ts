// How the review flow fails: transient errors retried in place, terminal
// ones never retried, malformed results isolated to their page, and
// infrastructure failures surfacing as typed errors.

import { Cause, Effect, Exit, Logger, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  BadResponse,
  ProviderRejected,
  RateLimited,
  ServerError,
  StorageError,
} from "../src/effect/errors";
import type { AppServices } from "../src/effect/services";
import { applyReview } from "../src/review/apply";
import {
  retryTransient,
  type StepError,
  stepFailureKind,
} from "../src/review/failures";
import { reviewCustomId } from "../src/review/message";
import {
  claimPages,
  dispatchApplies,
  preparePart,
  releaseClaims,
  storeResults,
  submitBatch,
} from "../src/review/steps";
import { BOOK_ID, makeWorld, type TestWorld } from "./support/fakes";

const run = <A, E>(
  world: TestWorld,
  program: Effect.Effect<A, E, AppServices>,
) =>
  Effect.runPromise(
    program.pipe(Effect.provide(world.layer), Effect.provide(Logger.layer([]))),
  );

// An effect that fails with each of `failures` in turn, then succeeds.
function flaky(failures: StepError[]) {
  let calls = 0;
  const effect = Effect.suspend(() => {
    const failure = failures[calls];
    calls += 1;
    return failure ? Effect.fail(failure) : Effect.succeed("ok");
  });
  return { effect, calls: () => calls };
}

const serverError = new ServerError({
  provider: "claude",
  status: 529,
  detail: "overloaded_error",
  retryAfterSeconds: null,
});

describe("retryTransient", () => {
  it("retries a transient failure in place and succeeds", async () => {
    const task = flaky([serverError, serverError]);
    expect(
      await Effect.runPromise(
        retryTransient({ effect: task.effect, baseMs: 1 }),
      ),
    ).toBe("ok");
    expect(task.calls()).toBe(3);
  });

  it("gives up after 3 tries with the last failure", async () => {
    const task = flaky([serverError, serverError, serverError]);
    const exit = await Effect.runPromiseExit(
      retryTransient({ effect: task.effect, baseMs: 1 }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(task.calls()).toBe(3);
  });

  it("waits at least the provider's retry-after", async () => {
    const task = flaky([
      new RateLimited({
        provider: "claude",
        detail: "slow down",
        retryAfterSeconds: 1,
      }),
    ]);
    const startedAt = Date.now();
    await Effect.runPromise(retryTransient({ effect: task.effect, baseMs: 1 }));
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(950);
  });

  it("never retries an invalid request, a body that didn't decode, or a D1 error that isn't transient", async () => {
    for (const failure of [
      new ProviderRejected({
        provider: "claude",
        status: 400,
        detail: "invalid_request_error",
      }),
      new BadResponse({
        provider: "claude",
        detail: "unexpected batch retrieve body",
        usage: { inputTokens: null, outputTokens: null },
      }),
      new StorageError({
        operation: "D1 query",
        detail: "D1_ERROR: UNIQUE constraint failed",
      }),
    ]) {
      const task = flaky([failure]);
      await Effect.runPromiseExit(
        retryTransient({ effect: task.effect, baseMs: 1 }),
      );
      expect(task.calls(), failure._tag).toBe(1);
    }
  });

  it("retries a transient D1 failure", async () => {
    const task = flaky([
      new StorageError({
        operation: "D1 batch",
        detail: "D1_ERROR: Network connection lost.",
      }),
    ]);
    await Effect.runPromise(retryTransient({ effect: task.effect, baseMs: 1 }));
    expect(task.calls()).toBe(2);
  });
});

describe("stepFailureKind", () => {
  it("retries transient failures, ends the instance on terminal ones", () => {
    expect(stepFailureKind(serverError)).toBe("retryable");
    expect(
      stepFailureKind(
        new ProviderRejected({ provider: "claude", status: 400, detail: "x" }),
      ),
    ).toBe("terminal");
    expect(stepFailureKind(new Error("bug"))).toBe("defect");
  });
});

const PAGE = "قال المصنف: الماء طهور";
const textKeyOf = (fileId: string) => `books/${BOOK_ID}/text/${fileId}.md`;

function seed(world: TestWorld, fileIds: string[]) {
  world.sqlite
    .prepare(
      "INSERT INTO books (id, title, created_at, review_enabled) VALUES (?, 'Book', 1, 1)",
    )
    .run(BOOK_ID);
  for (const [index, fileId] of fileIds.entries()) {
    world.sqlite
      .prepare(
        `INSERT INTO files (file_id, book_id, r2_key, state, text_key, preview, created_at, updated_at)
         VALUES (?, ?, 'scan', 'done', ?, 'p', 1, 1)`,
      )
      .run(fileId, BOOK_ID, textKeyOf(fileId));
    world.bucket.putMarkdown({ key: textKeyOf(fileId), text: PAGE });
    world.sqlite
      .prepare(
        "INSERT INTO review_queue (file_id, book_id, queued_at) VALUES (?, ?, ?)",
      )
      .run(fileId, BOOK_ID, index);
  }
}

const customIdOf = (fileId: string) =>
  reviewCustomId({ instanceId: "review-1", fileId });

const goodLine = (fileId: string) =>
  JSON.stringify({
    custom_id: customIdOf(fileId),
    result: {
      type: "succeeded",
      message: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              edits: [
                {
                  find: "الماء طهور",
                  replace: "الماءُ طَهورٌ",
                  category: "tashkeel",
                },
              ],
            }),
          },
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
  });

async function dispatch(world: TestWorld, lines: string[]) {
  const claimed = await run(world, claimPages("review-1"));
  await run(
    world,
    preparePart({ instanceId: "review-1", index: 0, fileIds: claimed }),
  );
  const { batchId } = await run(
    world,
    submitBatch({ instanceId: "review-1", parts: 1, pages: claimed.length }),
  );
  world.batches.results = new TextEncoder().encode(lines.join("\n"));
  const stored = await run(
    world,
    storeResults({ instanceId: "review-1", batchId, parts: 1 }),
  );
  await run(world, releaseClaims({ instanceId: "review-1", retry: false }));
  await run(
    world,
    dispatchApplies({ instanceId: "review-1", batchId, parts: 1 }),
  );
  return stored;
}

describe("results lines", () => {
  it("a malformed line fails only its own page", async () => {
    const world = makeWorld();
    seed(world, ["file-a", "file-b", "file-c"]);
    const stored = await dispatch(world, [
      goodLine("file-a"),
      // Cut off mid-line: its custom_id is readable, its result isn't.
      `{"custom_id":"${customIdOf("file-b")}","result":{"type":"succ`,
      // A result type the Batches API doesn't document.
      JSON.stringify({
        custom_id: customIdOf("file-c"),
        result: { type: "mystery" },
      }),
    ]);
    expect(stored.own).toBe(true);
    expect(world.sent).toHaveLength(3);

    const statuses = [];
    for (const message of world.sent) {
      statuses.push(await run(world, applyReview(message)));
    }
    expect(statuses).toEqual(["applied", "errored", "failed"]);
    expect(
      world.sqlite
        .prepare(
          "SELECT file_id, status, error_type FROM page_reviews ORDER BY file_id",
        )
        .all(),
    ).toEqual([
      { file_id: "file-a", status: "applied", error_type: null },
      { file_id: "file-b", status: "errored", error_type: "unreadable_result" },
      {
        file_id: "file-c",
        status: "failed",
        error_type: "unknown_result_type",
      },
    ]);
    // The unreadable page gets another try; the unknown type doesn't.
    expect(
      world.sqlite.prepare("SELECT file_id, attempts FROM review_queue").all(),
    ).toEqual([{ file_id: "file-b", attempts: 1 }]);
  });
});

describe("infrastructure failures", () => {
  it("surface as typed StorageError, not defects", async () => {
    const world = makeWorld();
    seed(world, ["file-a"]);
    await dispatch(world, [goodLine("file-a")]);
    const [message] = world.sent;
    if (!message) throw new Error("no message");
    world.faults.batch = true;
    const exit = await Effect.runPromiseExit(
      applyReview(message).pipe(
        Effect.provide(world.layer),
        Effect.provide(Logger.layer([])),
      ),
    );
    if (!Exit.isFailure(exit)) throw new Error("expected a failure");
    expect(Cause.hasDies(exit.cause)).toBe(false);
    const error = Option.getOrNull(Cause.findErrorOption(exit.cause));
    expect(error?._tag).toBe("StorageError");
    expect(stepFailureKind(error)).toBe("terminal");
  });
});
