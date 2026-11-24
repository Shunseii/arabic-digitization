import { Effect } from "effect";
import { initLogger } from "evlog";
import {
  clearMemoryLogs,
  createMemoryDrain,
  readMemoryLogs,
} from "evlog/memory";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ProviderRejected,
  RateLimited,
  ServerError,
} from "../src/effect/errors";
import { effectLogger } from "../src/logging";
import {
  type OcrDelivery,
  type OcrMessage,
  processOcrMessage,
  requeueTrigger,
} from "../src/queue";
import {
  claudeReply,
  FILE_ID,
  fileRow,
  inklingReply,
  makeWorld,
  ocrRuns,
  seedPage,
  type TestWorld,
} from "./support/fakes";

const PAGE = "١٢ كتاب الطهارة\n\n---\n\nنص الصفحة السرية";

function delivery({
  body = { fileId: FILE_ID, trigger: "upload" },
  attempts = 1,
}: {
  body?: OcrMessage;
  attempts?: number;
} = {}) {
  const result = { acked: false, retryDelay: null as number | null };
  const msg: OcrDelivery = {
    body,
    attempts,
    ack: () => {
      result.acked = true;
    },
    retry: ({ delaySeconds }) => {
      result.retryDelay = delaySeconds;
    },
  };
  return { msg, result };
}

function process(world: TestWorld, msg: OcrDelivery) {
  return Effect.runPromise(
    processOcrMessage(msg).pipe(
      Effect.provide(world.layer),
      Effect.provide(effectLogger),
    ),
  );
}

beforeAll(() => {
  initLogger({
    env: { service: "test" },
    silent: true,
    drain: createMemoryDrain(),
  });
});

beforeEach(() => clearMemoryLogs());

describe("processOcrMessage", () => {
  it("acks a done page and writes its run with the message's trigger and attempt", async () => {
    const world = makeWorld({ inkling: [inklingReply({ text: PAGE })] });
    seedPage({ world });
    const { msg, result } = delivery({
      body: { fileId: FILE_ID, trigger: "manual" },
      attempts: 2,
    });

    await process(world, msg);

    expect(result).toEqual({ acked: true, retryDelay: null });
    expect(ocrRuns(world)).toMatchObject([
      { status: "done", trigger: "manual", delivery_attempt: 2 },
    ]);
  });

  it("retries a transient failure with the provider's retry-after as the floor", async () => {
    const world = makeWorld({
      inkling: [
        {
          error: new ServerError({
            provider: "inkling",
            status: 502,
            detail: "bad gateway",
            retryAfterSeconds: null,
          }),
        },
      ],
      claude: [
        {
          error: new RateLimited({
            provider: "claude",
            detail: "slow down",
            retryAfterSeconds: 60,
          }),
        },
      ],
    });
    seedPage({ world });
    const { msg, result } = delivery({ attempts: 3 });

    await process(world, msg);

    expect(result.acked).toBe(false);
    expect(result.retryDelay).toBeGreaterThanOrEqual(60);
    expect(result.retryDelay).toBeLessThanOrEqual(65);
    expect(fileRow(world).state).toBe("rate_limited");
    expect(ocrRuns(world)).toMatchObject([
      { status: "requeued", delivery_attempt: 3, error_type: "RateLimited" },
    ]);
  });

  it("acks a terminal failure and records it", async () => {
    const world = makeWorld({
      inkling: [
        {
          error: new ProviderRejected({
            provider: "inkling",
            status: 401,
            detail: "unauthorized",
          }),
        },
      ],
    });
    seedPage({ world });
    const { msg, result } = delivery();

    await process(world, msg);

    expect(result).toEqual({ acked: true, retryDelay: null });
    expect(fileRow(world).state).toBe("failed");
    expect(ocrRuns(world)).toMatchObject([
      { status: "failed", error_type: "ProviderRejected" },
    ]);
  });

  it("drops a message for a paused book without running OCR", async () => {
    const world = makeWorld();
    seedPage({ world });
    world.sqlite.exec("UPDATE books SET paused = 1");
    const { msg, result } = delivery();

    await process(world, msg);

    expect(result.acked).toBe(true);
    expect(world.inkling.requests).toHaveLength(0);
    expect(ocrRuns(world)).toEqual([]);
  });

  it("accepts a message queued before triggers existed", async () => {
    const world = makeWorld({ inkling: [inklingReply({ text: PAGE })] });
    seedPage({ world });
    const { msg } = delivery({ body: { fileId: FILE_ID } });

    await process(world, msg);

    expect(ocrRuns(world)[0]?.trigger).toBeNull();
  });

  it("emits one wide event per message, without page text or prompts", async () => {
    const world = makeWorld({
      inkling: [
        {
          error: new ServerError({
            provider: "inkling",
            status: 503,
            detail: "down",
            retryAfterSeconds: null,
          }),
        },
      ],
      claude: [claudeReply({ text: PAGE })],
    });
    seedPage({ world });

    await process(world, delivery({ attempts: 2 }).msg);

    const events = readMemoryLogs();
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event).toMatchObject({
      action: "ocr",
      kind: "ocr",
      file_id: FILE_ID,
      attempt: 2,
      trigger: "upload",
      book_id: "test-book",
      ocr: {
        status: "done",
        engine: "inkling",
        final_model: "claude-sonnet-5-5",
        fell_back: true,
        fallback_reason: "server_error",
        calls: 2,
      },
    });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("نص الصفحة السرية");
    expect(serialized).not.toContain("You transcribe scanned pages");
  });

  it("puts a structured why/fix error on the event of a failed page", async () => {
    const world = makeWorld({
      inkling: [
        {
          error: new ProviderRejected({
            provider: "inkling",
            status: 401,
            detail: "unauthorized",
          }),
        },
      ],
    });
    seedPage({ world });

    await process(world, delivery().msg);

    const [event] = readMemoryLogs();
    expect(event?.level).toBe("error");
    expect(event).toMatchObject({
      error_type: "ProviderRejected",
      error: {
        message: "Inkling 401: unauthorized",
        data: {
          why: expect.stringContaining("rejected"),
          fix: expect.any(String),
        },
      },
    });
  });
});

describe("processOcrMessage when D1 fails", () => {
  it("fails the page and acks when the run can't be recorded", async () => {
    const world = makeWorld({ inkling: [inklingReply({ text: PAGE })] });
    seedPage({ world });
    world.faults.batch = true;
    const { msg, result } = delivery();

    await process(world, msg);

    expect(result).toEqual({ acked: true, retryDelay: null });
    expect(fileRow(world)).toMatchObject({
      state: "failed",
      error: "D1 batch failed: D1_ERROR: injected failure",
    });
    const [event] = readMemoryLogs();
    expect(event).toMatchObject({
      level: "error",
      error: { data: { why: "D1 or R2 failed the operation." } },
    });
  });

  it("retries instead of acking when the page can't be marked failed either", async () => {
    const world = makeWorld({ inkling: [inklingReply({ text: PAGE })] });
    seedPage({ world });
    world.faults.batch = true;
    world.faults.run = (sql) => sql.includes("state = 'failed'");
    const { msg, result } = delivery({ attempts: 2 });

    await process(world, msg);

    expect(result.acked).toBe(false);
    expect(result.retryDelay).toBeGreaterThanOrEqual(4);
    expect(fileRow(world).state).toBe("processing");
  });
});

describe("requeueTrigger", () => {
  it.each([
    ["failed", "retry"],
    ["rate_limited", "retry"],
    ["done", "requeue"],
    ["queued", "requeue"],
  ])("labels a %s page %s", (state, trigger) => {
    expect(requeueTrigger(state)).toBe(trigger);
  });
});
