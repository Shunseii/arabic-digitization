import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Logger } from "effect";
import { describe, expect, it } from "vitest";
import { BadResponse, RateLimited } from "../src/effect/errors";
import type { AppServices } from "../src/effect/services";
import {
  costUsd,
  REVIEW_MODEL,
  reviewCostUsd,
} from "../src/lib/cost";
import { sha256Hex } from "../src/lib/ocrRuns";
import { spendDay } from "../src/lib/spend";
import { CLAUDE_MODEL, INKLING_MODEL, transcribe } from "../src/ocr";
import { applyReview } from "../src/review/apply";
import type { ReviewApplyMessage } from "../src/review/message";
import {
  BOOK_ID,
  claudeReply,
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

const ocr = (world: TestWorld) =>
  run(
    world,
    transcribe({ fileId: FILE_ID, trigger: "upload", deliveryAttempt: 1 }),
  );

interface SpendRow {
  day: string;
  book_id: string;
  kind: string;
  model: string;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  calls: number;
  pages: number;
}

const spendRows = (world: TestWorld) =>
  world.sqlite
    .prepare(
      "SELECT day, book_id, kind, model, cost_usd, input_tokens, output_tokens, calls, pages FROM spend_daily ORDER BY kind, model",
    )
    .all() as unknown as SpendRow[];

// The fake clock starts at 1_700_000_000_000.
const DAY = spendDay(1_700_000_000_000);
const PAGE = "قال المصنف: الماء طهور";

describe("OCR spend", () => {
  it("adds each OCR run to the day's row for its book and model", async () => {
    const world = makeWorld({
      inkling: [
        inklingReply({ text: PAGE, inputTokens: 1000, outputTokens: 2000 }),
        inklingReply({ text: `${PAGE}!`, inputTokens: 1100, outputTokens: 2100 }),
      ],
    });
    seedPage({ world });
    await ocr(world);
    // A re-run is billed again, and counted again.
    await ocr(world);
    const cost = (input: number, output: number) =>
      costUsd({ model: INKLING_MODEL, inputTokens: input, outputTokens: output }) ?? 0;
    const [row] = spendRows(world);
    expect(row).toMatchObject({
      day: DAY,
      book_id: BOOK_ID,
      kind: "ocr",
      model: INKLING_MODEL,
      input_tokens: 2100,
      output_tokens: 4100,
      calls: 2,
      pages: 2,
    });
    expect(row?.cost_usd).toBeCloseTo(cost(1000, 2000) + cost(1100, 2100));
  });

  it("counts a fallback's calls per model and the page once, for the model whose text was kept", async () => {
    const world = makeWorld({
      inkling: [
        {
          error: new RateLimited({
            provider: "inkling",
            detail: "slow down",
            retryAfterSeconds: null,
          }),
        },
      ],
      claude: [claudeReply({ text: PAGE, inputTokens: 1500, outputTokens: 800 })],
    });
    seedPage({ world });
    await ocr(world);
    // The rate-limited call produced no tokens: not billed, not counted.
    expect(spendRows(world)).toEqual([
      expect.objectContaining({ model: CLAUDE_MODEL, calls: 1, pages: 1 }),
    ]);
  });

  it("counts a failed call that still billed tokens, with no page", async () => {
    const world = makeWorld({
      inkling: [
        {
          error: new BadResponse({
            provider: "inkling",
            detail: "thinking only",
            usage: { inputTokens: 900, outputTokens: 300 },
          }),
        },
      ],
    });
    seedPage({ world });
    await ocr(world);
    expect(spendRows(world)).toEqual([
      expect.objectContaining({
        model: INKLING_MODEL,
        input_tokens: 900,
        output_tokens: 300,
        calls: 1,
        pages: 0,
      }),
    ]);
  });
});

describe("review spend", () => {
  const usage = {
    input_tokens: 5000,
    output_tokens: 700,
    cache_read_input_tokens: 2000,
  };

  async function reviewMessage({
    world,
    batchId,
    result,
  }: {
    world: TestWorld;
    batchId: string;
    result: unknown;
  }): Promise<ReviewApplyMessage> {
    const customId = `review-1-${FILE_ID}`;
    const bytes = new TextEncoder().encode(
      JSON.stringify({ custom_id: customId, result }),
    );
    const resultsKey = `reviews/${batchId}/results.jsonl`;
    world.bucket.objects.set(resultsKey, {
      bytes,
      contentType: "application/x-ndjson",
    });
    return {
      kind: "review_apply",
      batchId,
      fileId: FILE_ID,
      customId,
      bookId: BOOK_ID,
      effort: "low",
      attempt: 0,
      textSha: await sha256Hex(PAGE),
      resultsKey,
      line: { offset: 0, length: bytes.length },
    };
  }

  const succeeded = (edits: unknown[]) => ({
    type: "succeeded",
    message: {
      content: [{ type: "text", text: JSON.stringify({ edits }) }],
      stop_reason: "end_turn",
      usage,
    },
  });

  function seedDonePage(world: TestWorld) {
    const textKey = `books/${BOOK_ID}/text/${FILE_ID}.md`;
    seedPage({ world, state: "done", textKey });
    world.bucket.putMarkdown({ key: textKey, text: PAGE });
  }

  const reviewCost = reviewCostUsd({
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: usage.cache_read_input_tokens,
  });

  const reviewCostOfPage = (world: TestWorld) =>
    (
      world.sqlite
        .prepare("SELECT review_cost_usd FROM files WHERE file_id = ?")
        .get(FILE_ID) as { review_cost_usd: number | null }
    ).review_cost_usd;

  it("adds a billed review to the rollup and to the page's review cost, once", async () => {
    const world = makeWorld();
    seedDonePage(world);
    const message = await reviewMessage({
      world,
      batchId: "msgbatch_1",
      result: succeeded([
        { find: "الماء طهور", replace: "الماءُ طَهورٌ", category: "tashkeel" },
      ]),
    });
    expect(await run(world, applyReview(message))).toBe("applied");
    // A redelivery adds nothing.
    expect(await run(world, applyReview(message))).toBe("duplicate");

    const [row] = spendRows(world);
    expect(row).toMatchObject({
      kind: "review",
      model: REVIEW_MODEL,
      input_tokens: 5000,
      output_tokens: 700,
      calls: 1,
      pages: 1,
    });
    expect(row?.cost_usd).toBeCloseTo(reviewCost);
    expect(reviewCostOfPage(world)).toBeCloseTo(reviewCost);
  });

  it("sums a page's reviews, including one that changed nothing", async () => {
    const world = makeWorld();
    seedDonePage(world);
    for (const batchId of ["msgbatch_1", "msgbatch_2"]) {
      const message = await reviewMessage({
        world,
        batchId,
        result: succeeded([]),
      });
      expect(await run(world, applyReview(message))).toBe("no_changes");
    }
    expect(spendRows(world)[0]).toMatchObject({ calls: 2, pages: 2 });
    expect(reviewCostOfPage(world)).toBeCloseTo(2 * reviewCost);
  });

  it("adds nothing for an unbilled result", async () => {
    const world = makeWorld();
    seedDonePage(world);
    for (const [batchId, result] of [
      ["msgbatch_1", { type: "expired" }],
      [
        "msgbatch_2",
        { type: "errored", error: { type: "error", error: { type: "api_error", message: "x" } } },
      ],
    ] as const) {
      const message = await reviewMessage({ world, batchId, result });
      await run(world, applyReview(message));
    }
    expect(spendRows(world)).toEqual([]);
    expect(reviewCostOfPage(world)).toBeNull();
  });
});

describe("backfill", () => {
  it("rolls up existing OCR runs, pre-history pages and reviews", () => {
    const dir = join(import.meta.dirname, "../migrations");
    const files = readdirSync(dir).sort();
    const sqlite = new DatabaseSync(":memory:");
    for (const file of files.filter((f) => f < "0014")) {
      sqlite.exec(readFileSync(join(dir, file), "utf8"));
    }
    const at = Date.parse("2026-11-20T10:00:00Z");
    sqlite.exec(`
      INSERT INTO books (id, title, created_at) VALUES ('b', 'B', 1);
      INSERT INTO files (file_id, book_id, r2_key, state, input_tokens, output_tokens, ocr_model, created_at, updated_at)
        VALUES ('old', 'b', 'k', 'done', 1000000, 1000000, 'inkling-2-small', 1, ${at}),
               ('new', 'b', 'k', 'done', 10, 10, 'inkling-2-small', 1, ${at});
      INSERT INTO ocr_runs (file_id, book_id, created_at, status, primary_engine, final_model,
                            delivery_attempt, calls, latency_ms, input_tokens, output_tokens, cost_usd, wasted_cost_usd)
        VALUES ('new', 'b', ${at}, 'done', 'inkling', 'claude-sonnet-5-5', 1,
          '[{"engine":"inkling","model":"inkling-2-small","status":"error","ms":1,"input_tokens":100,"output_tokens":50,"cost_usd":0.01,"error_type":"InklingCutOff"},
            {"engine":"claude","model":"claude-sonnet-5-5","status":"ok","ms":1,"input_tokens":200,"output_tokens":80,"cost_usd":0.02,"error_type":null}]',
          2, 300, 130, 0.03, 0.01);
      INSERT INTO page_reviews (file_id, batch_id, book_id, created_at, model, effort, status,
                                input_tokens, output_tokens, cost_usd)
        VALUES ('new', 'm1', 'b', ${at}, 'claude-opus-5-5', 'low', 'applied', 5000, 700, 0.05),
               ('new', 'm2', 'b', ${at}, 'claude-opus-5-5', 'low', 'expired', 0, 0, 0);
    `);
    sqlite.exec(readFileSync(join(dir, "0014_spend_daily.sql"), "utf8"));
    expect(
      sqlite
        .prepare(
          "SELECT day, kind, model, cost_usd, calls, pages FROM spend_daily ORDER BY kind, model",
        )
        .all(),
    ).toEqual([
      // claude call of the run (kept its text), plus nothing else.
      { day: "2026-11-20", kind: "ocr", model: "claude-sonnet-5-5", cost_usd: 0.02, calls: 1, pages: 1 },
      // The run's cut-off Inkling call, plus the pre-history page (1M in and
      // out at $0.30 + $1.00).
      { day: "2026-11-20", kind: "ocr", model: "inkling-2-small", cost_usd: 0.01 + 1.3, calls: 2, pages: 1 },
      { day: "2026-11-20", kind: "review", model: "claude-opus-5-5", cost_usd: 0.05, calls: 1, pages: 1 },
    ]);
    expect(
      sqlite.prepare("SELECT file_id, review_cost_usd FROM files ORDER BY file_id").all(),
    ).toEqual([
      { file_id: "new", review_cost_usd: 0.05 },
      { file_id: "old", review_cost_usd: null },
    ]);
  });
});
