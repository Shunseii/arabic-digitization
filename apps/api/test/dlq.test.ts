import { Effect, Logger } from "effect";
import { initLogger } from "evlog";
import { createMemoryDrain } from "evlog/memory";
import { beforeAll, describe, expect, it } from "vitest";
import {
  OCR_QUEUE_MAX_RETRIES,
  recordDeadMessages,
  reviewFailureNoteKey,
} from "../src/dlq";
import type { AppServices } from "../src/effect/services";
import { sha256Hex } from "../src/lib/ocrRuns";
import { effectLogger } from "../src/logging";
import { transcribe } from "../src/ocr";
import { processReviewMessage } from "../src/queue";
import { applyReview } from "../src/review/apply";
import type { ReviewApplyMessage } from "../src/review/message";
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

beforeAll(() => {
  initLogger({
    env: { service: "test" },
    silent: true,
    drain: createMemoryDrain(),
  });
});

const failedRows = (world: TestWorld) =>
  world.sqlite
    .prepare(
      "SELECT kind, file_id, book_id, ref, last_error, attempts, first_failed_at, last_failed_at, resolved_at FROM failed_messages ORDER BY kind, file_id",
    )
    .all() as Record<string, unknown>[];

const PAGE = "قال المصنف: الماء طهور";
const TEXT_KEY = `books/${BOOK_ID}/text/${FILE_ID}.md`;

// A review_apply message whose results line holds `result`.
async function reviewWithLine({
  world,
  batchId,
  result,
}: {
  world: TestWorld;
  batchId: string;
  result: unknown;
}): Promise<ReviewApplyMessage> {
  const customId = `review-1-${FILE_ID}`;
  const line = JSON.stringify({ custom_id: customId, result });
  const resultsKey = `reviews/${batchId}/results.jsonl`;
  const bytes = new TextEncoder().encode(line);
  world.bucket.objects.set(resultsKey, {
    bytes,
    contentType: "application/x-ndjson",
  });
  return {
    ...reviewMessage,
    batchId,
    customId,
    resultsKey,
    textSha: await sha256Hex(PAGE),
    line: { offset: 0, length: bytes.length },
  };
}

const reviewMessage: ReviewApplyMessage = {
  kind: "review_apply",
  batchId: "msgbatch_1",
  fileId: FILE_ID,
  customId: `review-1-${FILE_ID}`,
  bookId: BOOK_ID,
  effort: "low",
  attempt: 0,
  textSha: "x",
  resultsKey: "reviews/review-1/results.jsonl",
  line: null,
};

describe("recordDeadMessages", () => {
  it("records each dead message once, with the error the main consumer left", async () => {
    const world = makeWorld();
    seedPage({ world, state: "rate_limited" });
    world.sqlite.exec("UPDATE files SET error = 'Claude 529: overloaded'");
    world.notes.set(
      reviewFailureNoteKey({ fileId: "file-2", batchId: "msgbatch_1" }),
      "D1 batch failed: storage reset",
    );
    const dead = [
      { body: { fileId: FILE_ID, trigger: "upload" as const }, attempts: 1 },
      { body: { ...reviewMessage, fileId: "file-2" }, attempts: 1 },
      {
        body: {
          kind: "reindex_chain" as const,
          bookIds: [BOOK_ID],
          cursor: 0,
        },
        attempts: 1,
      },
      // A page deleted since: nothing to show.
      { body: { fileId: "gone" }, attempts: 1 },
    ];
    expect(await run(world, recordDeadMessages(dead))).toBe(4);
    // A duplicate delivery changes nothing but the last time.
    await run(world, recordDeadMessages(dead.slice(0, 1)));

    const attempts = OCR_QUEUE_MAX_RETRIES + 1;
    expect(failedRows(world)).toEqual([
      expect.objectContaining({
        kind: "ocr",
        file_id: FILE_ID,
        book_id: BOOK_ID,
        last_error: "Claude 529: overloaded",
        attempts,
        resolved_at: null,
      }),
      expect.objectContaining({
        kind: "reindex",
        file_id: "",
        ref: BOOK_ID,
        last_error: null,
      }),
      expect.objectContaining({
        kind: "review_apply",
        file_id: "file-2",
        ref: "msgbatch_1",
        last_error: "D1 batch failed: storage reset",
        attempts,
      }),
    ]);
  });

  it("resolves an OCR failure when the page is later transcribed, and reopens it if it dies again", async () => {
    const world = makeWorld({ inkling: [inklingReply({ text: "نص" })] });
    seedPage({ world, state: "queued" });
    const dead = [
      { body: { fileId: FILE_ID, trigger: "upload" as const }, attempts: 1 },
    ];
    await run(world, recordDeadMessages(dead));
    const [opened] = failedRows(world);

    await run(
      world,
      transcribe({ fileId: FILE_ID, trigger: "manual", deliveryAttempt: 1 }),
    );
    const [resolved] = failedRows(world);
    expect(resolved?.resolved_at).not.toBeNull();

    await run(world, recordDeadMessages(dead));
    const [reopened] = failedRows(world);
    expect(reopened?.resolved_at).toBeNull();
    expect(Number(reopened?.first_failed_at)).toBeGreaterThan(
      Number(opened?.first_failed_at),
    );
  });

  it("resolves a review apply failure when a later review of the page is recorded", async () => {
    const world = makeWorld();
    seedPage({ world, state: "done", textKey: TEXT_KEY });
    world.sqlite.exec("UPDATE books SET review_enabled = 1");
    world.bucket.putMarkdown({ key: TEXT_KEY, text: PAGE });
    await run(
      world,
      recordDeadMessages([{ body: reviewMessage, attempts: 1 }]),
    );

    // An error result doesn't resolve it.
    const later = await reviewWithLine({
      world,
      batchId: "msgbatch_2",
      result: { type: "errored", error: { type: "api_error", message: "x" } },
    });
    expect(await run(world, applyReview(later))).toBe("errored");
    expect(failedRows(world)[0]?.resolved_at).toBeNull();

    // A review that gets through does, in the same write.
    const applied = await reviewWithLine({
      world,
      batchId: "msgbatch_3",
      result: {
        type: "succeeded",
        message: {
          content: [{ type: "text", text: JSON.stringify({ edits: [] }) }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    });
    expect(await run(world, applyReview(applied))).toBe("no_changes");
    expect(failedRows(world)[0]?.resolved_at).not.toBeNull();
  });
});

describe("the review consumer's error note", () => {
  async function failingDelivery(attempts: number) {
    const world = makeWorld();
    seedPage({ world, state: "done" });
    world.faults.run = () => true;
    world.faults.batch = true;
    let retried = false;
    await Effect.runPromise(
      processReviewMessage({
        body: reviewMessage,
        attempts,
        ack: () => {},
        retry: () => {
          retried = true;
        },
      }).pipe(Effect.provide(world.layer), Effect.provide(effectLogger)),
    );
    return { world, retried };
  }

  it("is left only on a message's last tries", async () => {
    const early = await failingDelivery(1);
    expect(early.retried).toBe(true);
    expect(early.world.notes.size).toBe(0);

    const last = await failingDelivery(OCR_QUEUE_MAX_RETRIES);
    expect([...last.world.notes.entries()]).toEqual([
      [
        reviewFailureNoteKey({ fileId: FILE_ID, batchId: "msgbatch_1" }),
        expect.stringContaining("D1"),
      ],
    ]);
  });
});
