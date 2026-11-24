import { Effect, Logger } from "effect";
import { describe, expect, it } from "vitest";
import {
  BadResponse,
  NetworkError,
  ProviderRejected,
  ProviderTimeout,
  RateLimited,
  ServerError,
} from "../src/effect/errors";
import type { TransportError } from "../src/effect/services";
import { costUsd } from "../src/lib/cost";
import {
  CLAUDE_MODEL,
  INKLING_MODEL,
  SYSTEM_PROMPT,
  type TranscribeJob,
  transcribe,
} from "../src/ocr";
import {
  BOOK_ID,
  claudeReply,
  FILE_ID,
  fileRow,
  inklingReply,
  makeWorld,
  ocrRuns,
  type ProviderReply,
  SCAN_URL_BASE,
  seedPage,
  type TestWorld,
} from "./support/fakes";

const PAGE = "١٢ كتاب الطهارة\n\n---\n\nنص الصفحة";
const JOB: TranscribeJob = {
  fileId: FILE_ID,
  trigger: "upload",
  deliveryAttempt: 1,
};

function run(world: TestWorld, job: TranscribeJob = JOB) {
  return Effect.runPromise(
    transcribe(job).pipe(
      Effect.provide(world.layer),
      Effect.provide(Logger.layer([])),
    ),
  );
}

const fail = (error: TransportError): ProviderReply => ({ error });

const TRANSIENT: [string, TransportError, string][] = [
  [
    "rate limit",
    new RateLimited({
      provider: "inkling",
      detail: "slow down",
      retryAfterSeconds: 30,
    }),
    "rate_limit",
  ],
  [
    "server error",
    new ServerError({
      provider: "inkling",
      status: 503,
      detail: "down",
      retryAfterSeconds: null,
    }),
    "server_error",
  ],
  [
    "timeout",
    new ProviderTimeout({ provider: "inkling", timeoutMs: 300_000 }),
    "timeout",
  ],
  [
    "network",
    new NetworkError({
      provider: "inkling",
      detail: "TypeError: fetch failed",
    }),
    "network",
  ],
];

describe("transcribe", () => {
  it("stores Inkling's text and records a done run", async () => {
    const world = makeWorld({ inkling: [inklingReply({ text: PAGE })] });
    seedPage({ world });

    const outcome = await run(world);

    expect(outcome).toEqual({ status: "done", error: null });
    expect(world.claude.requests).toHaveLength(0);
    const [runRow] = ocrRuns(world);
    expect(runRow).toMatchObject({
      file_id: FILE_ID,
      book_id: BOOK_ID,
      trigger: "upload",
      status: "done",
      primary_engine: "inkling",
      final_model: INKLING_MODEL,
      fell_back: 0,
      fallback_reason: null,
      delivery_attempt: 1,
      input_tokens: 1000,
      output_tokens: 2000,
      wasted_cost_usd: 0,
      has_header: 1,
      metrics_version: 1,
      book_instructions_hash: null,
    });
    expect(runRow?.cost_usd).toBeCloseTo(
      costUsd({
        model: INKLING_MODEL,
        inputTokens: 1000,
        outputTokens: 2000,
      }) ?? -1,
    );
    expect(world.bucket.text(runRow?.text_key ?? "")).toBe(PAGE);
    expect(world.bucket.text(`books/${BOOK_ID}/text/${FILE_ID}.md`)).toBe(PAGE);
    expect(fileRow(world)).toMatchObject({
      state: "done",
      ocr_model: INKLING_MODEL,
      input_tokens: 1000,
      error: null,
    });
    expect(world.indexed).toEqual([{ fileId: FILE_ID, text: PAGE }]);
  });

  it("records the system prompt once and the book's instructions by hash", async () => {
    const world = makeWorld({
      inkling: [inklingReply({ text: PAGE }), inklingReply({ text: PAGE })],
    });
    seedPage({ world, instructions: "  Keep the page numbers.  " });

    await run(world);
    await run(world);

    const prompts = world.sqlite
      .prepare("SELECT kind, text FROM prompt_versions ORDER BY kind")
      .all();
    expect(prompts).toEqual([
      { kind: "book_instructions", text: "Keep the page numbers." },
      { kind: "system", text: SYSTEM_PROMPT },
    ]);
    const [first, second] = ocrRuns(world);
    expect(first?.book_instructions_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(second?.system_prompt_hash).toBe(first?.system_prompt_hash);
  });

  it.each(
    TRANSIENT,
  )("falls back to Claude on an Inkling %s", async (_name, error, reason) => {
    const world = makeWorld({
      inkling: [fail(error)],
      claude: [claudeReply({ text: PAGE })],
    });
    seedPage({ world });

    const outcome = await run(world);

    expect(outcome.status).toBe("done");
    const [runRow] = ocrRuns(world);
    expect(runRow).toMatchObject({
      final_model: CLAUDE_MODEL,
      fell_back: 1,
      fallback_reason: reason,
    });
    expect(JSON.parse(runRow?.calls ?? "[]")).toMatchObject([
      { engine: "inkling", status: "error", error_type: error._tag },
      { engine: "claude", status: "ok", error_type: null },
    ]);
    expect(fileRow(world).ocr_model).toBe(CLAUDE_MODEL);
  });

  it.each([
    [
      "a rejected request",
      new ProviderRejected({
        provider: "inkling",
        status: 400,
        detail: "bad model",
      }),
    ],
    [
      "an empty response",
      new BadResponse({
        provider: "inkling",
        detail: "{}",
        usage: { inputTokens: null, outputTokens: null },
      }),
    ],
  ])("does not fall back on %s", async (_name, error) => {
    const world = makeWorld({ inkling: [fail(error)] });
    seedPage({ world });

    const outcome = await run(world);

    expect(outcome.status).toBe("failed");
    expect(outcome.error?._tag).toBe(error._tag);
    expect(world.claude.requests).toHaveLength(0);
    expect(fileRow(world)).toMatchObject({
      state: "failed",
      error: error.message,
    });
    expect(ocrRuns(world)[0]).toMatchObject({
      status: "failed",
      error_type: error._tag,
      fell_back: 0,
      final_model: null,
      text_key: null,
    });
  });

  it("does not fall back on an empty Inkling answer", async () => {
    const world = makeWorld({ inkling: [inklingReply({ text: "" })] });
    seedPage({ world });

    const outcome = await run(world);

    expect(outcome.error?._tag).toBe("BadResponse");
    expect(world.claude.requests).toHaveLength(0);
  });

  it("sends a cut-off page to Claude and never stores the partial text", async () => {
    const world = makeWorld({
      inkling: [
        inklingReply({
          text: "PARTIAL",
          doneReason: "length",
          inputTokens: 1000,
          outputTokens: 12000,
        }),
      ],
      claude: [
        claudeReply({ text: PAGE, inputTokens: 1500, outputTokens: 800 }),
      ],
    });
    seedPage({ world });

    await run(world);

    const [runRow] = ocrRuns(world);
    expect(runRow).toMatchObject({
      fell_back: 1,
      fallback_reason: "cut_off",
      final_model: CLAUDE_MODEL,
      input_tokens: 2500,
      output_tokens: 12800,
    });
    for (const key of world.bucket.objects.keys()) {
      expect(world.bucket.text(key)).not.toContain("PARTIAL");
    }
  });

  it("re-queues on the Claude error when Inkling, as the fallback, is cut off", async () => {
    const claudeDown = new ServerError({
      provider: "claude",
      status: 529,
      detail: "overloaded",
      retryAfterSeconds: null,
    });
    const world = makeWorld({
      claude: [fail(claudeDown)],
      inkling: [inklingReply({ text: "PARTIAL", doneReason: "length" })],
    });
    seedPage({ world, engine: "claude" });

    const outcome = await run(world);

    expect(outcome).toEqual({ status: "requeued", error: claudeDown });
    expect(fileRow(world).state).toBe("rate_limited");
    expect(ocrRuns(world)[0]).toMatchObject({
      status: "requeued",
      error_type: "ServerError",
      fell_back: 1,
      fallback_reason: "server_error",
      text_key: null,
    });
    for (const key of world.bucket.objects.keys()) {
      expect(world.bucket.text(key)).not.toContain("PARTIAL");
    }
  });

  it("sends Claude a signed scan link, not base64", async () => {
    const world = makeWorld({ claude: [claudeReply({ text: PAGE })] });
    seedPage({ world, engine: "claude" });

    await run(world);

    const body = world.claude.requests[0]?.body as {
      messages: { content: { type: string; source?: unknown }[] }[];
    };
    const image = body.messages[0]?.content.find((c) => c.type === "image");
    expect(image?.source).toEqual({
      type: "url",
      url: `${SCAN_URL_BASE}/${FILE_ID}?exp=1&sig=test`,
    });
    expect(JSON.stringify(body)).not.toContain("base64");
  });

  it("sends Inkling the scan inline as base64", async () => {
    const world = makeWorld({ inkling: [inklingReply({ text: PAGE })] });
    seedPage({ world });

    await run(world);

    const body = world.inkling.requests[0]?.body as {
      messages: { images?: string[] }[];
    };
    // The fake scan is the bytes [1, 2, 3].
    expect(body.messages[1]?.images).toEqual(["AQID"]);
  });

  it("runs Claude first for a book whose engine is claude", async () => {
    const world = makeWorld({ claude: [claudeReply({ text: PAGE })] });
    seedPage({ world, engine: "claude" });

    await run(world);

    expect(world.inkling.requests).toHaveLength(0);
    expect(world.claude.requests).toHaveLength(1);
    expect(ocrRuns(world)[0]).toMatchObject({
      primary_engine: "claude",
      final_model: CLAUDE_MODEL,
      fell_back: 0,
    });
  });

  it("counts failed calls in the cost total and as wasted", async () => {
    const world = makeWorld({
      inkling: [
        inklingReply({
          text: "x",
          doneReason: "length",
          inputTokens: 1000,
          outputTokens: 12000,
        }),
      ],
      claude: [
        claudeReply({ text: PAGE, inputTokens: 1500, outputTokens: 800 }),
      ],
    });
    seedPage({ world });

    await run(world);

    const inklingCost =
      costUsd({
        model: INKLING_MODEL,
        inputTokens: 1000,
        outputTokens: 12000,
      }) ?? 0;
    const claudeCost =
      costUsd({ model: CLAUDE_MODEL, inputTokens: 1500, outputTokens: 800 }) ??
      0;
    const [runRow] = ocrRuns(world);
    expect(inklingCost).toBeGreaterThan(0);
    expect(runRow?.cost_usd).toBeCloseTo(inklingCost + claudeCost, 10);
    expect(runRow?.wasted_cost_usd).toBeCloseTo(inklingCost, 10);
    expect(runRow?.latency_ms).toBeGreaterThan(0);
  });

  it("re-queues when both engines fail transiently", async () => {
    const world = makeWorld({
      inkling: [fail(TRANSIENT[0]?.[1] as TransportError)],
      claude: [
        fail(
          new RateLimited({
            provider: "claude",
            detail: "busy",
            retryAfterSeconds: 45,
          }),
        ),
      ],
    });
    seedPage({ world });

    const outcome = await run(world);

    expect(outcome.status).toBe("requeued");
    expect(outcome.error).toMatchObject({
      _tag: "RateLimited",
      retryAfterSeconds: 45,
    });
    expect(fileRow(world)).toMatchObject({ state: "rate_limited" });
    expect(ocrRuns(world)[0]).toMatchObject({
      status: "requeued",
      cost_usd: 0,
    });
  });

  it("fails a page whose scan is not an image, without calling a provider", async () => {
    const world = makeWorld();
    seedPage({ world, contentType: "application/pdf" });

    const outcome = await run(world);

    expect(outcome.error?._tag).toBe("NotAnImage");
    expect(ocrRuns(world)[0]).toMatchObject({
      status: "failed",
      error_type: "NotAnImage",
      calls: "[]",
    });
  });

  it("keeps the replaced text as a revision on a re-OCR", async () => {
    const world = makeWorld({ inkling: [inklingReply({ text: PAGE })] });
    const textKey = `books/${BOOK_ID}/text/${FILE_ID}.md`;
    seedPage({ world, textKey });
    world.sqlite.exec("UPDATE files SET text_edited_at = 123, preview = 'old'");
    await Effect.runPromise(
      world.bucket.service.putText({ key: textKey, text: "old" }),
    );

    await run(world);

    const revisions = world.sqlite
      .prepare("SELECT change, model, prev_key FROM text_revisions")
      .all() as { change: string; model: string; prev_key: string }[];
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ change: "ocr", model: INKLING_MODEL });
    expect(world.bucket.text(revisions[0]?.prev_key ?? "")).toBe("old");
    expect(world.bucket.text(textKey)).toBe(PAGE);
    expect(
      world.sqlite.prepare("SELECT text_edited_at, preview FROM files").get(),
    ).toEqual({ text_edited_at: null, preview: PAGE.slice(0, 120) });
  });

  it("leaves the page's text and history untouched when the D1 batch fails", async () => {
    const world = makeWorld({ inkling: [inklingReply({ text: PAGE })] });
    const textKey = `books/${BOOK_ID}/text/${FILE_ID}.md`;
    seedPage({ world, textKey, state: "processing" });
    world.sqlite.exec("UPDATE files SET text_edited_at = 123");
    await Effect.runPromise(
      world.bucket.service.putText({ key: textKey, text: "hand-fixed text" }),
    );
    world.faults.batch = true;

    await expect(run(world)).rejects.toMatchObject({ _tag: "StorageError" });

    expect(world.bucket.text(textKey)).toBe("hand-fixed text");
    expect(
      world.sqlite.prepare("SELECT COUNT(*) AS n FROM text_revisions").get(),
    ).toEqual({ n: 0 });
    expect(
      world.sqlite.prepare("SELECT state, text_edited_at FROM files").get(),
    ).toEqual({ state: "processing", text_edited_at: 123 });
    expect(ocrRuns(world)).toEqual([]);
  });

  it("stores a blank page as empty text", async () => {
    const world = makeWorld({ inkling: [inklingReply({ text: "[blank]" })] });
    seedPage({ world });

    await run(world);

    const [runRow] = ocrRuns(world);
    expect(world.bucket.text(runRow?.text_key ?? "")).toBe("");
    expect(fileRow(world).state).toBe("done");
  });
});
