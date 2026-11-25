import { Effect, Logger } from "effect";
import { describe, expect, it } from "vitest";
import type { AppServices } from "../src/effect/services";
import { REVIEW_MODEL, reviewCostUsd } from "../src/lib/cost";
import { sha256Hex } from "../src/lib/ocrRuns";
import { transcribe } from "../src/ocr";
import { applyReview, applyReviewEdits } from "../src/review/apply";
import type { ReviewApplyMessage } from "../src/review/message";
import { workflowSteps } from "../src/review/poll";
import type { ReviewEdit } from "../src/review/prompt";
import {
  type BatchCheck,
  checkBatch,
  claimPages,
  dispatchApplies,
  finalizeBatch,
  indexResultLines,
  preparePart,
  REVIEW_SCAN_LINK_TTL_SECONDS,
  recordBatch,
  releaseClaims,
  reviewKeys,
  storeResults,
  submitBatch,
} from "../src/review/steps";
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

const ANTHROPIC_ENDED_AT = Date.parse("2026-11-24T12:05:00Z");

const PAGE = "١٢ كتاب الطهارة\n\n---\n\nقال المصنف رحمه الله: الماء طهور";
const textKeyOf = (fileId: string) => `books/${BOOK_ID}/text/${fileId}.md`;

function seedBook(
  world: TestWorld,
  { reviewEnabled = true }: { reviewEnabled?: boolean } = {},
): void {
  world.sqlite
    .prepare(
      "INSERT INTO books (id, title, created_at, review_enabled, ocr_instructions) VALUES (?, ?, ?, ?, ?)",
    )
    .run(BOOK_ID, "Book", 1, reviewEnabled ? 1 : 0, "Footnotes use (1).");
}

function seedDonePage({
  world,
  fileId,
  text = PAGE,
  textEditedAt = null,
}: {
  world: TestWorld;
  fileId: string;
  text?: string;
  textEditedAt?: number | null;
}): void {
  world.sqlite
    .prepare(
      `INSERT INTO files (file_id, book_id, r2_key, state, text_key, preview, text_edited_at, created_at, updated_at)
       VALUES (?, ?, ?, 'done', ?, ?, ?, 1, 1)`,
    )
    .run(
      fileId,
      BOOK_ID,
      `books/${BOOK_ID}/scans/${fileId}`,
      textKeyOf(fileId),
      text.slice(0, 120),
      textEditedAt,
    );
  world.bucket.putMarkdown({ key: textKeyOf(fileId), text });
}

const queueRows = (world: TestWorld) =>
  world.sqlite
    .prepare("SELECT file_id, instance_id FROM review_queue ORDER BY file_id")
    .all() as { file_id: string; instance_id: string | null }[];

const queueAttempts = (world: TestWorld) =>
  world.sqlite
    .prepare("SELECT file_id, attempts FROM review_queue ORDER BY file_id")
    .all() as { file_id: string; attempts: number }[];

const reviewRows = (world: TestWorld) =>
  world.sqlite
    .prepare("SELECT * FROM page_reviews ORDER BY file_id")
    .all() as unknown as {
    file_id: string;
    status: string;
    attempt: number;
    error_type: string | null;
    error: string | null;
    edits: string | null;
    chars_changed: number;
    chars_total: number;
    effort: string;
    model: string;
    edits_proposed: number;
    edits_applied: number;
    edits_failed: number;
    categories: string | null;
    input_tokens: number;
    cache_read_input_tokens: number;
    output_tokens: number;
    cost_usd: number;
    revision_id: number | null;
  }[];

const revisions = (world: TestWorld) =>
  world.sqlite
    .prepare(
      "SELECT id, file_id, change, model, note, prev_key FROM text_revisions",
    )
    .all() as {
    id: number;
    file_id: string;
    change: string;
    model: string | null;
    note: string | null;
    prev_key: string;
  }[];

const USAGE = {
  input_tokens: 5200,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 2100,
  output_tokens: 900,
};

function succeededLine({
  fileId,
  edits,
}: {
  fileId: string;
  edits: ReviewEdit[];
}): string {
  return JSON.stringify({
    custom_id: fileId,
    result: {
      type: "succeeded",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: REVIEW_MODEL,
        content: [
          { type: "thinking", thinking: "", signature: "sig" },
          { type: "text", text: JSON.stringify({ edits }) },
        ],
        stop_reason: "end_turn",
        usage: USAGE,
      },
    },
  });
}

const erroredLine = (
  fileId: string,
  errorType = "invalid_request_error",
  message = "image unreachable",
) =>
  JSON.stringify({
    custom_id: fileId,
    result: {
      type: "errored",
      error: { type: "error", error: { type: errorType, message } },
    },
  });

const expiredLine = (fileId: string) =>
  JSON.stringify({ custom_id: fileId, result: { type: "expired" } });

describe("applyReviewEdits", () => {
  it("applies an exact, unique match", () => {
    const outcome = applyReviewEdits({
      text: PAGE,
      edits: [
        { find: "الماء طهور", replace: "الماءُ طَهورٌ", category: "tashkeel" },
      ],
    });
    expect(outcome.text).toBe(PAGE.replace("الماء طهور", "الماءُ طَهورٌ"));
    expect(outcome).toMatchObject({
      applied: 1,
      failed: 0,
      categories: { tashkeel: { proposed: 1, applied: 1, failed: 0 } },
    });
  });

  it("counts a find that matches nowhere, twice, or empty as failed, and applies the rest", () => {
    const text = "باب باب الطهارة";
    const outcome = applyReviewEdits({
      text,
      edits: [
        { find: "غير موجود", replace: "x", category: "spelling" },
        { find: "باب", replace: "كتاب", category: "spelling" },
        { find: "", replace: "x", category: "layout" },
        { find: "الطهارة", replace: "الطَّهارة", category: "tashkeel" },
      ],
    });
    expect(outcome.text).toBe("باب باب الطَّهارة");
    expect(outcome.applied).toBe(1);
    expect(outcome.failed).toBe(3);
    expect(outcome.categories).toEqual({
      spelling: { proposed: 2, applied: 0, failed: 2 },
      layout: { proposed: 1, applied: 0, failed: 1 },
      tashkeel: { proposed: 1, applied: 1, failed: 0 },
    });
  });

  it("matches each edit against the text left by the edits before it", () => {
    const outcome = applyReviewEdits({
      text: "أ ب",
      edits: [
        { find: "أ", replace: "ب", category: "spelling" },
        { find: "ب", replace: "ج", category: "spelling" },
      ],
    });
    // After the first edit the text is "ب ب": the second find is ambiguous.
    expect(outcome).toMatchObject({ text: "ب ب", applied: 1, failed: 1 });
  });
});

describe("indexResultLines", () => {
  it("finds every line's byte range and custom_id without parsing it", () => {
    const lines = [
      succeededLine({
        fileId: "file-a",
        edits: [{ find: "ا", replace: "أ", category: "spelling" }],
      }),
      erroredLine("file-b"),
      expiredLine("file-c"),
    ];
    const bytes = new TextEncoder().encode(`${lines.join("\n")}\n`);
    const index = indexResultLines(bytes);
    expect(index.map((line) => line.customId)).toEqual([
      "file-a",
      "file-b",
      "file-c",
    ]);
    const decoder = new TextDecoder();
    for (const [i, line] of index.entries()) {
      expect(
        decoder.decode(bytes.subarray(line.offset, line.offset + line.length)),
      ).toBe(lines[i]);
    }
  });
});

// Runs the Workflow's steps in order on fakes, up to the queue messages.
async function reviewThroughDispatch({
  world,
  resultLines,
}: {
  world: TestWorld;
  resultLines: (claimed: string[]) => string[];
}): Promise<ReviewApplyMessage[]> {
  const instanceId = "review-1";
  const claimed = await run(world, claimPages(instanceId));
  await run(world, preparePart({ instanceId, index: 0, fileIds: claimed }));
  const batchId = await run(world, submitBatch({ instanceId, parts: 1 }));
  world.batches.results = new TextEncoder().encode(
    resultLines(claimed).join("\n"),
  );
  await run(world, storeResults({ instanceId, batchId }));
  await run(world, releaseClaims({ instanceId, retry: false }));
  await run(world, dispatchApplies({ instanceId, batchId, parts: 1 }));
  return world.sent;
}

describe("review batch", () => {
  it("submits eligible pages with a long-lived scan link and the cached shared prompt", async () => {
    const world = makeWorld();
    seedBook(world);
    seedDonePage({ world, fileId: "file-a" });
    seedDonePage({ world, fileId: "file-b", textEditedAt: 9 });
    seedDonePage({ world, fileId: "file-c", text: "" });
    world.sqlite.exec(
      "INSERT INTO review_queue (file_id, book_id, queued_at) VALUES ('file-a', 'test-book', 1), ('file-b', 'test-book', 2), ('file-c', 'test-book', 3), ('gone', 'test-book', 4)",
    );

    const claimed = await run(world, claimPages("review-1"));
    expect(claimed).toEqual(["file-a", "file-b", "file-c", "gone"]);
    // A retried select step returns the same claim instead of a new one.
    expect(await run(world, claimPages("review-1"))).toEqual(claimed);

    const prepared = await run(
      world,
      preparePart({ instanceId: "review-1", index: 0, fileIds: claimed }),
    );
    expect(prepared).toEqual({ pages: 1, dropped: 3 });
    expect(queueRows(world)).toEqual([
      { file_id: "file-a", instance_id: "review-1" },
    ]);
    expect(world.scanLinkTtls).toEqual([REVIEW_SCAN_LINK_TTL_SECONDS]);

    await run(world, submitBatch({ instanceId: "review-1", parts: 1 }));
    const body = JSON.parse(world.batches.created[0] ?? "") as {
      requests: {
        custom_id: string;
        params: {
          model: string;
          thinking: unknown;
          output_config: { effort: string };
          system: { text: string; cache_control: unknown }[];
          messages: { content: { type: string; text?: string }[] }[];
        };
      }[];
    };
    expect(body.requests).toHaveLength(1);
    const request = body.requests[0];
    expect(request?.custom_id).toBe("file-a");
    expect(request?.params.model).toBe("claude-opus-5-5");
    expect(request?.params.thinking).toEqual({ type: "adaptive" });
    expect(request?.params.output_config.effort).toBe("low");
    expect(request?.params.system.map((block) => block.cache_control)).toEqual([
      { type: "ephemeral", ttl: "1h" },
      { type: "ephemeral", ttl: "1h" },
    ]);
    expect(request?.params.system[1]?.text).toContain("Footnotes use (1).");
    expect(request?.params.messages[0]?.content[1]?.text).toContain(PAGE);
  });

  it("ingests succeeded, errored and expired results from the JSONL", async () => {
    const world = makeWorld();
    seedBook(world);
    for (const fileId of ["file-a", "file-b", "file-c"]) {
      seedDonePage({ world, fileId });
    }
    world.sqlite.exec(
      "INSERT INTO review_queue (file_id, book_id, queued_at) VALUES ('file-a', 'test-book', 1), ('file-b', 'test-book', 2), ('file-c', 'test-book', 3)",
    );
    const messages = await reviewThroughDispatch({
      world,
      resultLines: () => [
        succeededLine({
          fileId: "file-a",
          edits: [
            { find: "الماء طهور", replace: "الماءُ طَهورٌ", category: "tashkeel" },
            { find: "ليس في الصفحة", replace: "x", category: "spelling" },
          ],
        }),
        erroredLine("file-b"),
        expiredLine("file-c"),
      ],
    });
    expect(messages.map((m) => m.fileId)).toEqual([
      "file-a",
      "file-b",
      "file-c",
    ]);
    expect(queueRows(world)).toEqual([]);

    for (const message of messages) {
      await run(world, applyReview(message));
    }

    const corrected = PAGE.replace("الماء طهور", "الماءُ طَهورٌ");
    expect(world.bucket.text(textKeyOf("file-a"))).toBe(corrected);
    expect(world.indexed).toEqual([{ fileId: "file-a", text: corrected }]);
    const [revision] = revisions(world);
    expect(revision).toMatchObject({
      file_id: "file-a",
      change: "review",
      model: REVIEW_MODEL,
      note: "Opus review (msgbatch_1): 1 applied, 1 failed to apply",
    });
    // The revision holds the text before the review, so it can be restored.
    expect(world.bucket.text(revision?.prev_key ?? "")).toBe(PAGE);

    const usage = {
      inputTokens: USAGE.input_tokens,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: USAGE.cache_read_input_tokens,
      outputTokens: USAGE.output_tokens,
    };
    const rows = reviewRows(world);
    expect(rows.map((r) => [r.file_id, r.status])).toEqual([
      ["file-a", "applied"],
      ["file-b", "failed"],
      ["file-c", "expired"],
    ]);
    expect(rows[0]).toMatchObject({
      model: REVIEW_MODEL,
      effort: "low",
      edits_proposed: 2,
      edits_applied: 1,
      edits_failed: 1,
      input_tokens: 5200,
      cache_read_input_tokens: 2100,
      output_tokens: 900,
      revision_id: revision?.id,
    });
    expect(rows[0]?.cost_usd).toBeCloseTo(reviewCostUsd(usage));
    expect(JSON.parse(rows[0]?.categories ?? "")).toEqual({
      tashkeel: { proposed: 1, applied: 1, failed: 0 },
      spelling: { proposed: 1, applied: 0, failed: 1 },
    });
    expect(JSON.parse(rows[0]?.edits ?? "")).toEqual([
      {
        find: "الماء طهور",
        replace: "الماءُ طَهورٌ",
        category: "tashkeel",
        applied: true,
      },
      {
        find: "ليس في الصفحة",
        replace: "x",
        category: "spelling",
        applied: false,
      },
    ]);
    expect(rows[0]?.chars_changed).toBe("الماءُ طَهورٌ".length);
    expect(rows[0]?.chars_total).toBe(PAGE.length);
    // An invalid request is never retried.
    expect(rows[1]).toMatchObject({
      error_type: "invalid_request_error",
      error: "image unreachable",
      cost_usd: 0,
    });
    // An expired page goes back in the queue for the next batch, one try used.
    expect(queueAttempts(world)).toEqual([{ file_id: "file-c", attempts: 1 }]);

    // A redelivered message changes nothing.
    const [first] = messages;
    if (!first) throw new Error("no message");
    expect(await run(world, applyReview(first))).toBe("duplicate");
    expect(revisions(world)).toHaveLength(1);
  });

  it("never touches a page that was hand-edited after it was sent", async () => {
    const world = makeWorld();
    seedBook(world);
    seedDonePage({ world, fileId: "file-a" });
    world.sqlite.exec(
      "INSERT INTO review_queue (file_id, book_id, queued_at) VALUES ('file-a', 'test-book', 1)",
    );
    const messages = await reviewThroughDispatch({
      world,
      resultLines: () => [
        succeededLine({
          fileId: "file-a",
          edits: [{ find: "الماء", replace: "الماءُ", category: "tashkeel" }],
        }),
      ],
    });
    world.sqlite.exec(
      "UPDATE files SET text_edited_at = 77 WHERE file_id = 'file-a'",
    );

    expect(
      await run(world, applyReview(messages[0] as ReviewApplyMessage)),
    ).toBe("skipped_hand_edited");
    expect(world.bucket.text(textKeyOf("file-a"))).toBe(PAGE);
    expect(revisions(world)).toEqual([]);
    expect(reviewRows(world)[0]).toMatchObject({
      status: "skipped_hand_edited",
      edits_proposed: 1,
      edits_applied: 0,
      edits_failed: 0,
    });
  });

  it("skips a page whose text changed in review and queues it again", async () => {
    const world = makeWorld();
    seedBook(world);
    seedDonePage({ world, fileId: "file-a" });
    world.sqlite.exec(
      "INSERT INTO review_queue (file_id, book_id, queued_at) VALUES ('file-a', 'test-book', 1)",
    );
    const messages = await reviewThroughDispatch({
      world,
      resultLines: () => [
        succeededLine({
          fileId: "file-a",
          edits: [{ find: "الماء", replace: "الماءُ", category: "tashkeel" }],
        }),
      ],
    });
    const reOcrd = `${PAGE} (re-OCR)`;
    world.bucket.putMarkdown({ key: textKeyOf("file-a"), text: reOcrd });

    const message = messages[0] as ReviewApplyMessage;
    expect(message.textSha).toBe(await sha256Hex(PAGE));
    expect(await run(world, applyReview(message))).toBe("stale");
    expect(world.bucket.text(textKeyOf("file-a"))).toBe(reOcrd);
    expect(queueRows(world)).toEqual([
      { file_id: "file-a", instance_id: null },
    ]);
  });

  it("returns claimed pages to the queue when the Workflow gives up", async () => {
    const world = makeWorld();
    seedBook(world);
    seedDonePage({ world, fileId: "file-a" });
    world.sqlite.exec(
      "INSERT INTO review_queue (file_id, book_id, queued_at) VALUES ('file-a', 'test-book', 1)",
    );
    await run(world, claimPages("review-1"));
    await run(world, releaseClaims({ instanceId: "review-1", retry: true }));
    expect(queueRows(world)).toEqual([
      { file_id: "file-a", instance_id: null },
    ]);
    expect(reviewKeys("review-1").results).toBe(
      "reviews/review-1/results.jsonl",
    );
  });
});

describe("review_batches stages", () => {
  it("records each stage, writing a check only when the counts moved or the batch ended", async () => {
    const world = makeWorld();
    seedBook(world);
    seedDonePage({ world, fileId: "file-a" });
    world.sqlite.exec(
      "INSERT INTO review_queue (file_id, book_id, queued_at) VALUES ('file-a', 'test-book', 1)",
    );
    const row = () =>
      world.sqlite
        .prepare(
          "SELECT stage, batch_id, pages, processing, succeeded, submitted_at, ended_at, anthropic_ended_at, checks, steps FROM review_batches WHERE instance_id = 'review-1'",
        )
        .get() as Record<string, unknown>;
    const batchWrites: string[] = [];
    world.faults.run = (sql) => {
      if (sql.includes("UPDATE review_batches")) batchWrites.push(sql);
      return false;
    };

    await run(world, claimPages("review-1"));
    expect(row()).toMatchObject({ stage: "preparing", pages: 1 });

    const submittedAt = await run(
      world,
      recordBatch({ instanceId: "review-1", batchId: "msgbatch_x", pages: 1 }),
    );
    expect(row()).toMatchObject({
      stage: "processing",
      batch_id: "msgbatch_x",
      submitted_at: submittedAt,
    });
    batchWrites.length = 0;

    const counts = {
      processing: 2,
      succeeded: 0,
      errored: 0,
      canceled: 0,
      expired: 0,
    };
    world.batches.statuses = [
      { processingStatus: "in_progress", counts, endedAt: null },
      { processingStatus: "in_progress", counts, endedAt: null },
      {
        processingStatus: "in_progress",
        counts: { ...counts, processing: 1, succeeded: 1 },
        endedAt: null,
      },
      {
        processingStatus: "ended",
        counts: { ...counts, processing: 0, succeeded: 2 },
        endedAt: ANTHROPIC_ENDED_AT,
      },
    ];
    let previous: BatchCheck | null = null;
    const check = async (): Promise<BatchCheck> => {
      const result: BatchCheck = await run(
        world,
        checkBatch({
          instanceId: "review-1",
          batchId: "msgbatch_x",
          previous: previous?.counts ?? null,
        }),
      );
      previous = result;
      return result;
    };

    await check();
    expect(row()).toMatchObject({ stage: "processing", processing: 2 });
    await check();
    expect(batchWrites).toHaveLength(1);
    await check();
    expect(row()).toMatchObject({ processing: 1, succeeded: 1 });
    expect(batchWrites).toHaveLength(2);

    const ended = await check();
    expect(ended.ended).toBe(true);
    expect(batchWrites).toHaveLength(3);
    expect(row()).toMatchObject({
      stage: "ingesting",
      processing: 0,
      succeeded: 2,
      ended_at: ended.checkedAt,
      anthropic_ended_at: ANTHROPIC_ENDED_AT,
    });

    // Finalize keeps the time the batch ended, and records the checks and
    // steps the instance used, in the same write.
    batchWrites.length = 0;
    await run(
      world,
      finalizeBatch({
        instanceId: "review-1",
        ended: true,
        resultsKey: "k",
        checks: 4,
        steps: workflowSteps({ parts: 1, checks: 4, ended: true }),
      }),
    );
    expect(batchWrites).toHaveLength(1);
    expect(row()).toMatchObject({
      stage: "applying",
      ended_at: ended.checkedAt,
      anthropic_ended_at: ANTHROPIC_ENDED_AT,
      checks: 4,
      steps: 16,
    });
  });

  it("records checks and steps when the Workflow gives up waiting", async () => {
    const world = makeWorld();
    seedBook(world);
    seedDonePage({ world, fileId: "file-a" });
    world.sqlite.exec(
      "INSERT INTO review_queue (file_id, book_id, queued_at) VALUES ('file-a', 'test-book', 1)",
    );
    await run(world, claimPages("review-1"));
    await run(
      world,
      recordBatch({ instanceId: "review-1", batchId: "msgbatch_x", pages: 1 }),
    );
    await run(
      world,
      finalizeBatch({
        instanceId: "review-1",
        ended: false,
        resultsKey: null,
        checks: 95,
        steps: workflowSteps({ parts: 4, checks: 95, ended: false }),
      }),
    );
    expect(
      world.sqlite
        .prepare(
          "SELECT stage, checks, steps, anthropic_ended_at, ended_at IS NOT NULL AS ended FROM review_batches",
        )
        .get(),
    ).toEqual({
      stage: "timed_out",
      checks: 95,
      steps: 198,
      anthropic_ended_at: null,
      ended: 1,
    });
  });
});

describe("results that end without a review", () => {
  // One page through a batch whose result is `line`, after `attempts` earlier
  // tries that ended without a review.
  async function tryPage({
    attempts,
    line,
  }: {
    attempts: number;
    line: (fileId: string) => string;
  }) {
    const world = makeWorld();
    seedBook(world);
    seedDonePage({ world, fileId: "file-a" });
    world.sqlite
      .prepare(
        "INSERT INTO review_queue (file_id, book_id, queued_at, attempts) VALUES ('file-a', 'test-book', 1, ?)",
      )
      .run(attempts);
    const [message] = await reviewThroughDispatch({
      world,
      resultLines: () => [line("file-a")],
    });
    if (!message) throw new Error("no message");
    expect(message.attempt).toBe(attempts);
    const status = await run(world, applyReview(message));
    return { world, status, row: reviewRows(world)[0] };
  }

  it("never retries an invalid request", async () => {
    const { world, status, row } = await tryPage({
      attempts: 0,
      line: (id) => erroredLine(id, "invalid_request_error", "bad image"),
    });
    expect(status).toBe("failed");
    expect(row).toMatchObject({
      error_type: "invalid_request_error",
      error: "bad image",
      attempt: 0,
    });
    expect(queueAttempts(world)).toEqual([]);
  });

  for (const errorType of [
    "api_error",
    "overloaded_error",
    "rate_limit_error",
  ]) {
    it(`queues the page again after ${errorType}, counting the try`, async () => {
      const { world, status, row } = await tryPage({
        attempts: 1,
        line: (id) => erroredLine(id, errorType, "try later"),
      });
      expect(status).toBe("errored");
      expect(row).toMatchObject({ error_type: errorType, attempt: 1 });
      expect(queueAttempts(world)).toEqual([
        { file_id: "file-a", attempts: 2 },
      ]);
    });
  }

  it("fails the page on the third server error in a row, with the last reason", async () => {
    const { world, status, row } = await tryPage({
      attempts: 2,
      line: (id) => erroredLine(id, "overloaded_error", "Overloaded"),
    });
    expect(status).toBe("failed");
    expect(row).toMatchObject({
      error_type: "overloaded_error",
      error: "Overloaded",
      attempt: 2,
    });
    expect(queueAttempts(world)).toEqual([]);
  });

  for (const type of ["expired", "canceled"] as const) {
    it(`queues a ${type} page again and fails it on the third try`, async () => {
      const line = (id: string) =>
        JSON.stringify({ custom_id: id, result: { type } });
      const first = await tryPage({ attempts: 0, line });
      expect(first.status).toBe(type);
      expect(queueAttempts(first.world)).toEqual([
        { file_id: "file-a", attempts: 1 },
      ]);

      const last = await tryPage({ attempts: 2, line });
      expect(last.status).toBe("failed");
      expect(last.row).toMatchObject({ error_type: type });
      expect(queueAttempts(last.world)).toEqual([]);
    });
  }

  it("starts a page's count again when OCR finishes it anew", async () => {
    const world = makeWorld({ inkling: [inklingReply({ text: PAGE })] });
    seedPage({ world });
    world.sqlite.exec("UPDATE books SET review_enabled = 1");
    await run(
      world,
      transcribe({ fileId: FILE_ID, trigger: "upload", deliveryAttempt: 1 }),
    );
    expect(queueAttempts(world)).toEqual([{ file_id: FILE_ID, attempts: 0 }]);
  });
});

describe("review opt-in", () => {
  async function ocrPage({ reviewEnabled }: { reviewEnabled: boolean }) {
    const world = makeWorld({ inkling: [inklingReply({ text: PAGE })] });
    seedPage({ world });
    world.sqlite
      .prepare("UPDATE books SET review_enabled = ? WHERE id = ?")
      .run(reviewEnabled ? 1 : 0, BOOK_ID);
    await run(
      world,
      transcribe({ fileId: FILE_ID, trigger: "upload", deliveryAttempt: 1 }),
    );
    return world;
  }

  it("queues a page that finishes OCR only when its book opted in", async () => {
    expect(queueRows(await ocrPage({ reviewEnabled: false }))).toEqual([]);
    expect(queueRows(await ocrPage({ reviewEnabled: true }))).toEqual([
      { file_id: FILE_ID, instance_id: null },
    ]);
  });

  it("drops a waiting page when its book opts out before the batch is built", async () => {
    const world = makeWorld();
    seedBook(world, { reviewEnabled: false });
    seedDonePage({ world, fileId: "file-a" });
    world.sqlite.exec(
      "INSERT INTO review_queue (file_id, book_id, queued_at) VALUES ('file-a', 'test-book', 1)",
    );
    const claimed = await run(world, claimPages("review-1"));
    expect(
      await run(
        world,
        preparePart({ instanceId: "review-1", index: 0, fileIds: claimed }),
      ),
    ).toEqual({ pages: 0, dropped: 1 });
    expect(queueRows(world)).toEqual([]);
  });
});
