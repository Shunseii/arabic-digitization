// Failure injection for the review flow: every step is retried after a
// failure, and no page is lost, stuck, or reviewed twice.

import { Effect, Exit, Logger } from "effect";
import { describe, expect, it } from "vitest";
import type { AppServices } from "../src/effect/services";
import { REVIEW_MODEL } from "../src/lib/cost";
import { sha256Hex } from "../src/lib/ocrRuns";
import { reviewHistoryKey } from "../src/lib/pageText";
import { transcribe } from "../src/ocr";
import { applyReview } from "../src/review/apply";
import { type ReviewApplyMessage, reviewCustomId } from "../src/review/message";
import {
  abandonForeignBatch,
  claimPages,
  dispatchApplies,
  FOREIGN_BATCH,
  preparePart,
  releaseClaims,
  resultsAreOwn,
  storeResults,
  submitBatch,
} from "../src/review/steps";
import { STUCK_AFTER_MS, sweepStuckBatches } from "../src/review/sweep";
import {
  BOOK_ID,
  FILE_ID,
  inklingReply,
  makeWorld,
  seedPage,
  type TestWorld,
} from "./support/fakes";

const run = <A, E>(
  world: TestWorld,
  program: Effect.Effect<A, E, AppServices>,
) =>
  Effect.runPromise(
    program.pipe(Effect.provide(world.layer), Effect.provide(Logger.layer([]))),
  );

const runExit = <A, E>(
  world: TestWorld,
  program: Effect.Effect<A, E, AppServices>,
) =>
  Effect.runPromise(
    Effect.exit(
      program.pipe(
        Effect.provide(world.layer),
        Effect.provide(Logger.layer([])),
      ),
    ),
  );

const PAGE = "١٢ كتاب الطهارة\n\n---\n\nقال المصنف: الماء طهور";
const CORRECTED = PAGE.replace("الماء طهور", "الماءُ طَهورٌ");
const textKeyOf = (fileId: string) => `books/${BOOK_ID}/text/${fileId}.md`;

function seedReviewBook(world: TestWorld, pages: string[]): void {
  world.sqlite
    .prepare(
      "INSERT INTO books (id, title, created_at, review_enabled) VALUES (?, 'Book', 1, 1)",
    )
    .run(BOOK_ID);
  for (const [index, fileId] of pages.entries()) {
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

const count = (world: TestWorld, sql: string) =>
  (world.sqlite.prepare(sql).get() as { n: number }).n;

const succeededLine = ({
  instanceId = "review-1",
  fileId,
}: {
  instanceId?: string;
  fileId: string;
}) =>
  JSON.stringify({
    custom_id: reviewCustomId({ instanceId, fileId }),
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

// Claim, prepare and submit one page, then dispatch its result.
async function dispatchedMessage(
  world: TestWorld,
): Promise<ReviewApplyMessage> {
  const instanceId = "review-1";
  const claimed = await run(world, claimPages(instanceId));
  await run(world, preparePart({ instanceId, index: 0, fileIds: claimed }));
  const { batchId } = await run(
    world,
    submitBatch({ instanceId, parts: 1, pages: claimed.length }),
  );
  world.batches.results = new TextEncoder().encode(
    succeededLine({ fileId: "file-a" }),
  );
  await run(world, storeResults({ instanceId, batchId, parts: 1 }));
  await run(world, releaseClaims({ instanceId, retry: false }));
  await run(world, dispatchApplies({ instanceId, batchId, parts: 1 }));
  const [message] = world.sent;
  if (!message) throw new Error("no message");
  return message;
}

describe("submit", () => {
  it("adopts the batch a failed attempt created instead of creating a second", async () => {
    const world = makeWorld();
    seedReviewBook(world, ["file-a"]);
    const claimed = await run(world, claimPages("review-1"));
    await run(
      world,
      preparePart({ instanceId: "review-1", index: 0, fileIds: claimed }),
    );
    // Someone else's batch of the same size, created before our attempt.
    world.batches.others.push({
      id: "msgbatch_old",
      createdAt: 0,
      requests: 1,
    });

    // The create succeeds, then recording its id fails.
    world.faults.run = (sql) => sql.includes("SET batch_id = ?");
    const first = await runExit(
      world,
      submitBatch({ instanceId: "review-1", parts: 1, pages: 1 }),
    );
    expect(Exit.isFailure(first)).toBe(true);
    expect(world.batches.created).toHaveLength(1);

    // The step retries: it finds that batch and adopts it.
    world.faults.run = () => false;
    const retried = await run(
      world,
      submitBatch({ instanceId: "review-1", parts: 1, pages: 1 }),
    );
    expect(retried.batchId).toBe("msgbatch_1");
    expect(world.batches.created).toHaveLength(1);
    expect(
      world.sqlite.prepare("SELECT stage, batch_id FROM review_batches").get(),
    ).toEqual({ stage: "processing", batch_id: "msgbatch_1" });

    // A step that already finished returns the same batch.
    expect(
      await run(
        world,
        submitBatch({ instanceId: "review-1", parts: 1, pages: 1 }),
      ),
    ).toEqual(retried);
  });

  it("creates the batch when the failed attempt never reached Anthropic", async () => {
    const world = makeWorld();
    seedReviewBook(world, ["file-a"]);
    const claimed = await run(world, claimPages("review-1"));
    await run(
      world,
      preparePart({ instanceId: "review-1", index: 0, fileIds: claimed }),
    );
    world.sqlite.exec(
      "UPDATE review_batches SET stage = 'submitting', submit_attempted_at = 1700000000000",
    );
    // A batch of another size, and one another instance already owns.
    world.batches.others.push(
      { id: "msgbatch_big", createdAt: 1_700_000_000_500, requests: 7 },
      { id: "msgbatch_taken", createdAt: 1_700_000_000_500, requests: 1 },
    );
    world.sqlite.exec(
      "INSERT INTO review_batches (instance_id, batch_id, created_at, model, pages, stage) VALUES ('review-0', 'msgbatch_taken', 1, 'm', 1, 'applying')",
    );
    const { batchId } = await run(
      world,
      submitBatch({ instanceId: "review-1", parts: 1, pages: 1 }),
    );
    expect(batchId).toBe("msgbatch_1");
    expect(world.batches.created).toHaveLength(1);
  });
});

describe("a foreign batch", () => {
  it("is never applied when a retried submit adopted a stranger's same-size batch", async () => {
    const world = makeWorld();
    seedReviewBook(world, ["file-a"]);
    const claimed = await run(world, claimPages("review-1"));
    await run(
      world,
      preparePart({ instanceId: "review-1", index: 0, fileIds: claimed }),
    );
    // Our first attempt failed before reaching Anthropic; meanwhile someone
    // else in the workspace created a one-request batch.
    const attemptedAt = 1_700_000_000_000;
    world.sqlite
      .prepare(
        "UPDATE review_batches SET stage = 'submitting', submit_attempted_at = ?",
      )
      .run(attemptedAt);
    world.batches.others.push({
      id: "msgbatch_stranger",
      createdAt: attemptedAt + 1000,
      requests: 1,
    });
    const { batchId } = await run(
      world,
      submitBatch({ instanceId: "review-1", parts: 1, pages: 1 }),
    );
    expect(batchId).toBe("msgbatch_stranger");

    // Its results carry the stranger's custom_ids.
    world.batches.results = new TextEncoder().encode(
      succeededLine({ instanceId: "someone-else", fileId: "req-1" }),
    );
    const stored = await run(
      world,
      storeResults({ instanceId: "review-1", batchId, parts: 1 }),
    );
    expect(stored.own).toBe(false);
    await run(world, abandonForeignBatch("review-1"));

    expect(world.sent).toEqual([]);
    expect(world.bucket.text(textKeyOf("file-a"))).toBe(PAGE);
    expect(
      world.sqlite
        .prepare("SELECT file_id, instance_id, attempts FROM review_queue")
        .all(),
    ).toEqual([{ file_id: "file-a", instance_id: null, attempts: 0 }]);
    expect(
      world.sqlite.prepare("SELECT stage, error FROM review_batches").get(),
    ).toEqual({ stage: "failed", error: FOREIGN_BATCH });
  });

  it("is told apart by its custom_ids: foreign, missing or extra lines", () => {
    const manifest = [
      {
        fileId: "file-a",
        bookId: BOOK_ID,
        effort: "low" as const,
        textSha: "x",
        attempt: 0,
      },
      {
        fileId: "file-b",
        bookId: BOOK_ID,
        effort: "low" as const,
        textSha: "x",
        attempt: 0,
      },
    ];
    const bytes = (lines: string[]) =>
      new TextEncoder().encode(lines.join("\n"));
    const own = (fileId: string) => succeededLine({ fileId });
    const check = (lines: string[]) =>
      resultsAreOwn({ instanceId: "review-1", bytes: bytes(lines), manifest });
    expect(check([own("file-a"), own("file-b")])).toBe(true);
    // A page with no line is ours only if a garbled line accounts for it.
    expect(check([own("file-a")])).toBe(false);
    expect(check([own("file-a"), '{"garbled'])).toBe(true);
    expect(check(['{"garbled', '{"garbled'])).toBe(false);
    expect(check([own("file-a"), own("file-b"), own("file-c")])).toBe(false);
    expect(
      check([
        own("file-a"),
        succeededLine({ instanceId: "review-2", fileId: "file-b" }),
      ]),
    ).toBe(false);
  });

  it("isn't adopted when it was created long after the failed attempt", async () => {
    const world = makeWorld();
    seedReviewBook(world, ["file-a"]);
    const claimed = await run(world, claimPages("review-1"));
    await run(
      world,
      preparePart({ instanceId: "review-1", index: 0, fileIds: claimed }),
    );
    const attemptedAt = 1_600_000_000_000;
    world.sqlite
      .prepare(
        "UPDATE review_batches SET stage = 'submitting', submit_attempted_at = ?",
      )
      .run(attemptedAt);
    world.batches.others.push({
      id: "msgbatch_later",
      createdAt: attemptedAt + 11 * 60_000,
      requests: 1,
    });
    const { batchId } = await run(
      world,
      submitBatch({ instanceId: "review-1", parts: 1, pages: 1 }),
    );
    expect(batchId).toBe("msgbatch_1");
  });
});

describe("apply", () => {
  it("finishes the D1 part on redelivery after R2 was written and D1 failed", async () => {
    const world = makeWorld();
    seedReviewBook(world, ["file-a"]);
    const message = await dispatchedMessage(world);

    world.faults.batch = true;
    const failed = await runExit(world, applyReview(message));
    expect(Exit.isFailure(failed)).toBe(true);
    // R2 has the reviewed text and the saved original; D1 has nothing yet.
    expect(world.bucket.text(textKeyOf("file-a"))).toBe(CORRECTED);
    const saved = reviewHistoryKey({
      bookId: BOOK_ID,
      fileId: "file-a",
      batchId: message.batchId,
    });
    expect(world.bucket.text(saved)).toBe(PAGE);
    expect(count(world, "SELECT COUNT(*) AS n FROM page_reviews")).toBe(0);

    world.faults.batch = false;
    expect(await run(world, applyReview(message))).toBe("applied");
    expect(world.bucket.text(textKeyOf("file-a"))).toBe(CORRECTED);
    const revisions = world.sqlite
      .prepare("SELECT change, model, prev_key FROM text_revisions")
      .all();
    expect(revisions).toEqual([
      { change: "review", model: REVIEW_MODEL, prev_key: saved },
    ]);
    expect(
      world.sqlite
        .prepare("SELECT status, edits_applied, revision_id FROM page_reviews")
        .get(),
    ).toEqual({ status: "applied", edits_applied: 1, revision_id: 1 });
    expect(message.textSha).toBe(await sha256Hex(PAGE));
  });

  it("treats a duplicate message as a no-op", async () => {
    const world = makeWorld();
    seedReviewBook(world, ["file-a"]);
    const message = await dispatchedMessage(world);
    expect(await run(world, applyReview(message))).toBe("applied");
    expect(await run(world, applyReview(message))).toBe("duplicate");
    expect(count(world, "SELECT COUNT(*) AS n FROM text_revisions")).toBe(1);
    expect(count(world, "SELECT COUNT(*) AS n FROM page_reviews")).toBe(1);
  });

  it("re-dispatching a batch sends messages that change nothing", async () => {
    const world = makeWorld();
    seedReviewBook(world, ["file-a"]);
    const message = await dispatchedMessage(world);
    await run(world, applyReview(message));
    await run(
      world,
      dispatchApplies({
        instanceId: "review-1",
        batchId: message.batchId,
        parts: 1,
      }),
    );
    expect(world.sent).toHaveLength(2);
    expect(
      await run(world, applyReview(world.sent[1] as ReviewApplyMessage)),
    ).toBe("duplicate");
  });

  it("keeps a hand edit that landed between the read and the write", async () => {
    const world = makeWorld();
    seedReviewBook(world, ["file-a"]);
    const message = await dispatchedMessage(world);
    // The page changes after the review was made from it but is still
    // un-edited in D1: the etag-conditional write refuses to replace it.
    world.bucket.afterVersionedRead = (key) => {
      world.bucket.afterVersionedRead = null;
      world.bucket.putMarkdown({ key, text: `${PAGE} ✎` });
    };
    expect(await run(world, applyReview(message))).toBe("conflict");
    expect(world.bucket.text(textKeyOf("file-a"))).toBe(`${PAGE} ✎`);
    expect(count(world, "SELECT COUNT(*) AS n FROM text_revisions")).toBe(0);
  });
});

describe("stuck batches", () => {
  function seedStuck(
    world: TestWorld,
    {
      instanceId,
      stage,
      ageMs,
      attempts,
    }: { instanceId: string; stage: string; ageMs: number; attempts: number[] },
  ) {
    const now = 1_700_000_000_000;
    world.sqlite
      .prepare(
        "INSERT INTO review_batches (instance_id, created_at, model, pages, stage) VALUES (?, ?, 'm', ?, ?)",
      )
      .run(instanceId, now - ageMs, attempts.length, stage);
    for (const [i, tries] of attempts.entries()) {
      world.sqlite
        .prepare(
          "INSERT INTO review_queue (file_id, book_id, queued_at, instance_id, attempts) VALUES (?, ?, 1, ?, ?)",
        )
        .run(`${instanceId}-p${i}`, BOOK_ID, instanceId, tries);
    }
  }

  it("frees the pages of an instance that errored mid-poll and fails its batch", async () => {
    const world = makeWorld();
    const old = STUCK_AFTER_MS + 60_000;
    seedStuck(world, {
      instanceId: "dead",
      stage: "processing",
      ageMs: old,
      attempts: [0, 2],
    });
    seedStuck(world, {
      instanceId: "alive",
      stage: "processing",
      ageMs: old,
      attempts: [0],
    });
    seedStuck(world, {
      instanceId: "young",
      stage: "processing",
      ageMs: 60_000,
      attempts: [0],
    });
    seedStuck(world, {
      instanceId: "gone",
      stage: "ingesting",
      ageMs: old,
      attempts: [1],
    });
    world.instanceStatuses.set("dead", "errored");
    world.instanceStatuses.set("alive", "running");

    const result = await run(world, sweepStuckBatches());
    expect(result).toEqual({ checked: 3, failed: ["dead", "gone"] });
    expect(
      world.sqlite
        .prepare(
          "SELECT file_id, instance_id, attempts FROM review_queue ORDER BY file_id",
        )
        .all(),
    ).toEqual([
      { file_id: "alive-p0", instance_id: "alive", attempts: 0 },
      // dead-p1 was on its last try: it leaves the queue.
      { file_id: "dead-p0", instance_id: null, attempts: 1 },
      { file_id: "gone-p0", instance_id: null, attempts: 2 },
      { file_id: "young-p0", instance_id: "young", attempts: 0 },
    ]);
    expect(
      world.sqlite
        .prepare(
          "SELECT instance_id, stage FROM review_batches ORDER BY instance_id",
        )
        .all(),
    ).toEqual([
      { instance_id: "alive", stage: "processing" },
      { instance_id: "dead", stage: "failed" },
      { instance_id: "gone", stage: "failed" },
      { instance_id: "young", stage: "processing" },
    ]);
  });
});

describe("enqueue and claim", () => {
  it("queues a page in the same D1 batch that marks it done", async () => {
    const world = makeWorld({ inkling: [inklingReply({ text: PAGE })] });
    seedPage({ world });
    world.sqlite.exec("UPDATE books SET review_enabled = 1");
    world.faults.batch = true;
    await runExit(
      world,
      transcribe({ fileId: FILE_ID, trigger: "upload", deliveryAttempt: 1 }),
    );
    expect(count(world, "SELECT COUNT(*) AS n FROM review_queue")).toBe(0);
    expect(
      (
        world.sqlite.prepare("SELECT state FROM files").get() as {
          state: string;
        }
      ).state,
    ).not.toBe("done");
  });

  it("never lets two instances claim the same page", async () => {
    const world = makeWorld();
    const pages = Array.from({ length: 150 }, (_, i) => `p${i}`);
    seedReviewBook(world, pages);
    const [a, b] = await Promise.all([
      run(world, claimPages("review-a")),
      run(world, claimPages("review-b")),
    ]);
    expect(a).toHaveLength(100);
    expect(b).toHaveLength(50);
    expect(new Set([...a, ...b]).size).toBe(150);
  });
});
