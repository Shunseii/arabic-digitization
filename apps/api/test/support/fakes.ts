// Test doubles for the Effect services in src/effect/services.ts.
//
// The database is real SQLite (node:sqlite) with every migration applied, so
// tests run the Worker's actual SQL and read back real rows.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { Effect, Layer } from "effect";
import { StorageError } from "../../src/effect/errors";
import {
  AnthropicBatches,
  type AnthropicBatchesShape,
  AnthropicGateway,
  type AppServices,
  type BatchStatus,
  type BatchSummary,
  Bucket,
  type BucketShape,
  Database,
  type DatabaseShape,
  Ollama,
  PageIndexer,
  type ProviderRequest,
  ReviewInstances,
  ReviewQueue,
  ScanLinks,
  type SqlValue,
  type Statement,
  type StoredBytes,
  type TransportError,
  WallClock,
} from "../../src/effect/services";
import type { ReviewApplyMessage } from "../../src/review/message";

const MIGRATIONS_DIR = join(import.meta.dirname, "../../migrations");

export function openTestDatabase(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS_DIR).sort()) {
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
  return sqlite;
}

const bind = (params: readonly SqlValue[]): SQLInputValue[] => [...params];

// Failures to inject: a failing D1 batch, and single statements (run) whose
// SQL matches. Mutable, so a test can switch them on after seeding.
export interface DatabaseFaults {
  batch: boolean;
  run: (sql: string) => boolean;
}

const d1Failure = (operation: string) =>
  new StorageError({ operation, detail: "D1_ERROR: injected failure" });

export function sqliteDatabase(
  sqlite: DatabaseSync,
  faults: DatabaseFaults = { batch: false, run: () => false },
): DatabaseShape {
  const run = (query: Statement) =>
    sqlite.prepare(query.sql).run(...bind(query.params));
  return {
    first: <T>(query: Statement) =>
      Effect.sync(
        () =>
          (sqlite.prepare(query.sql).get(...bind(query.params)) as
            | T
            | undefined) ?? null,
      ),
    all: <T>(query: Statement) =>
      Effect.sync(
        () => sqlite.prepare(query.sql).all(...bind(query.params)) as T[],
      ),
    run: (query) =>
      faults.run(query.sql)
        ? Effect.fail(d1Failure("D1 query"))
        : Effect.sync(() => ({ changes: Number(run(query).changes) })),
    batch: (queries) =>
      faults.batch
        ? Effect.fail(d1Failure("D1 batch"))
        : Effect.sync(() => {
            sqlite.exec("BEGIN");
            try {
              for (const query of queries) run(query);
              sqlite.exec("COMMIT");
            } catch (error) {
              sqlite.exec("ROLLBACK");
              throw error;
            }
          }),
  };
}

export class FakeBucket {
  readonly objects = new Map<string, StoredBytes>();
  // Runs right after a versioned read, to change the object between a read
  // and a conditional write.
  afterVersionedRead: ((key: string) => void) | null = null;
  // Bumped on every write; an object's etag is its version.
  private readonly versions = new Map<string, number>();
  private version = 0;

  private write(key: string, value: StoredBytes): void {
    this.objects.set(key, value);
    this.versions.set(key, ++this.version);
  }

  etag(key: string): string {
    return `v${this.versions.get(key) ?? 0}`;
  }

  putMarkdown({ key, text }: { key: string; text: string }): void {
    this.write(key, {
      bytes: new TextEncoder().encode(text),
      contentType: "text/markdown; charset=utf-8",
    });
  }

  putImage({ key, contentType }: { key: string; contentType: string }): void {
    this.objects.set(key, { bytes: new Uint8Array([1, 2, 3]), contentType });
  }

  text(key: string): string | undefined {
    const obj = this.objects.get(key);
    return obj ? new TextDecoder().decode(obj.bytes) : undefined;
  }

  keys(prefix: string): string[] {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix));
  }

  readonly service: BucketShape = {
    getBytes: (key) => Effect.sync(() => this.objects.get(key) ?? null),
    getText: (key) => Effect.sync(() => this.text(key) ?? null),
    putText: (object) => Effect.sync(() => this.putMarkdown(object)),
    getRange: ({ key, offset, length }) =>
      Effect.sync(
        () =>
          this.objects.get(key)?.bytes.slice(offset, offset + length) ?? null,
      ),
    getVersionedText: (key) =>
      Effect.sync(() => {
        const text = this.text(key);
        const read = text === undefined ? null : { text, etag: this.etag(key) };
        this.afterVersionedRead?.(key);
        return read;
      }),
    putTextIfMatch: ({ key, text, etag }) =>
      Effect.sync(() => {
        if (this.etag(key) !== etag) return false;
        this.putMarkdown({ key, text });
        return true;
      }),
    putBytes: ({ key, bytes, contentType }) =>
      Effect.sync(() => this.write(key, { bytes, contentType })),
  };
}

// Message Batches that answer from a script and record what was sent.
export class FakeBatches {
  readonly created: string[] = [];
  readonly retrieved: string[] = [];
  // Batches the list call returns besides the ones created here (another
  // workspace user's, for instance).
  readonly others: BatchSummary[] = [];
  private readonly listed: BatchSummary[] = [];
  statuses: BatchStatus[] = [];
  results: Uint8Array = new Uint8Array();

  constructor(private readonly clock: { now: () => number }) {}

  readonly service: AnthropicBatchesShape = {
    create: (body) =>
      Effect.sync(() => {
        this.created.push(body);
        const id = `msgbatch_${this.created.length}`;
        const { requests } = JSON.parse(body) as { requests: unknown[] };
        this.listed.push({
          id,
          createdAt: this.clock.now(),
          requests: requests.length,
        });
        return id;
      }),
    list: () =>
      Effect.sync(() =>
        [...this.listed, ...this.others].sort(
          (a, b) => b.createdAt - a.createdAt,
        ),
      ),
    retrieve: (batchId) =>
      Effect.suspend(() => {
        this.retrieved.push(batchId);
        const status = this.statuses.shift();
        return status
          ? Effect.succeed(status)
          : Effect.die(new Error("unexpected batch retrieve"));
      }),
    results: () => Effect.sync(() => this.results),
  };
}

export type ProviderReply = { json: unknown } | { error: TransportError };

// A provider that answers from a script, in order, and records each request.
export class ScriptedProvider {
  readonly requests: ProviderRequest[] = [];

  constructor(private readonly replies: ProviderReply[] = []) {}

  readonly call = (
    request: ProviderRequest,
  ): Effect.Effect<unknown, TransportError> =>
    Effect.suspend(() => {
      this.requests.push(request);
      const reply = this.replies.shift();
      if (!reply) return Effect.die(new Error("unexpected provider call"));
      return "error" in reply
        ? Effect.fail(reply.error)
        : Effect.succeed(reply.json);
    });
}

export const inklingReply = ({
  text,
  inputTokens = 1000,
  outputTokens = 2000,
  doneReason = "stop",
}: {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  doneReason?: string;
}): ProviderReply => ({
  json: {
    message: { content: text },
    done_reason: doneReason,
    prompt_eval_count: inputTokens,
    eval_count: outputTokens,
  },
});

export const claudeReply = ({
  text,
  inputTokens = 1500,
  outputTokens = 800,
}: {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}): ProviderReply => ({
  json: {
    content: [{ type: "text", text }],
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  },
});

// Each reading moves time on by `stepMs`, so durations are deterministic.
export function steppingClock({
  start = 1_700_000_000_000,
  stepMs = 100,
}: {
  start?: number;
  stepMs?: number;
} = {}) {
  let now = start - stepMs;
  return {
    now: () => {
      now += stepMs;
      return now;
    },
  };
}

export interface TestWorld {
  sqlite: DatabaseSync;
  bucket: FakeBucket;
  inkling: ScriptedProvider;
  claude: ScriptedProvider;
  indexed: { fileId: string; text: string }[];
  batches: FakeBatches;
  // Workflow instance statuses by id; a missing id reads as gone (null).
  instanceStatuses: Map<string, string>;
  sent: ReviewApplyMessage[];
  scanLinkTtls: number[];
  faults: DatabaseFaults;
  layer: Layer.Layer<AppServices>;
}

export function makeWorld({
  inkling = [],
  claude = [],
}: {
  inkling?: ProviderReply[];
  claude?: ProviderReply[];
} = {}): TestWorld {
  const sqlite = openTestDatabase();
  const bucket = new FakeBucket();
  const inklingProvider = new ScriptedProvider(inkling);
  const claudeProvider = new ScriptedProvider(claude);
  const indexed: { fileId: string; text: string }[] = [];
  const faults: DatabaseFaults = { batch: false, run: () => false };
  const clock = steppingClock();
  const batches = new FakeBatches(clock);
  const sent: ReviewApplyMessage[] = [];
  const instanceStatuses = new Map<string, string>();
  const scanLinkTtls: number[] = [];
  const layer = Layer.mergeAll(
    Layer.succeed(Database, sqliteDatabase(sqlite, faults)),
    Layer.succeed(Bucket, bucket.service),
    Layer.succeed(Ollama, { chat: inklingProvider.call }),
    Layer.succeed(AnthropicGateway, { messages: claudeProvider.call }),
    Layer.succeed(AnthropicBatches, batches.service),
    Layer.succeed(ReviewInstances, {
      status: (instanceId: string) =>
        Effect.sync(() => instanceStatuses.get(instanceId) ?? null),
    }),
    Layer.succeed(ReviewQueue, {
      send: (messages: readonly ReviewApplyMessage[]) =>
        Effect.sync(() => {
          sent.push(...messages);
        }),
    }),
    Layer.succeed(WallClock, clock),
    Layer.succeed(PageIndexer, {
      index: (page: { fileId: string; text: string }) =>
        Effect.sync(() => {
          indexed.push(page);
        }),
    }),
    Layer.succeed(ScanLinks, {
      urlFor: ({
        fileId,
        ttlSeconds,
      }: {
        fileId: string;
        ttlSeconds: number;
      }) =>
        Effect.sync(() => {
          scanLinkTtls.push(ttlSeconds);
          return `${SCAN_URL_BASE}/${fileId}?exp=1&sig=test`;
        }),
    }),
  );
  return {
    sqlite,
    bucket,
    inkling: inklingProvider,
    claude: claudeProvider,
    indexed,
    batches,
    instanceStatuses,
    sent,
    scanLinkTtls,
    faults,
    layer,
  };
}

export const SCAN_URL_BASE = "https://api.test/scan";
export const BOOK_ID = "test-book";
export const FILE_ID = "file-1";
export const SCAN_KEY = `books/${BOOK_ID}/scans/${FILE_ID}`;

export function seedPage({
  world,
  engine = null,
  instructions = null,
  state = "queued",
  contentType = "image/jpeg",
  textKey = null,
}: {
  world: TestWorld;
  engine?: "inkling" | "claude" | null;
  instructions?: string | null;
  state?: string;
  contentType?: string;
  textKey?: string | null;
}): void {
  world.sqlite
    .prepare(
      "INSERT INTO books (id, title, created_at, ocr_engine, ocr_instructions) VALUES (?, ?, ?, ?, ?)",
    )
    .run(BOOK_ID, "Test book", 1, engine, instructions);
  world.sqlite
    .prepare(
      "INSERT INTO files (file_id, book_id, r2_key, state, text_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(FILE_ID, BOOK_ID, SCAN_KEY, state, textKey, 1, 1);
  world.bucket.putImage({ key: SCAN_KEY, contentType });
}

export interface OcrRunRow {
  id: number;
  file_id: string;
  book_id: string;
  trigger: string | null;
  status: string;
  error_type: string | null;
  error_message: string | null;
  primary_engine: string;
  final_model: string | null;
  fell_back: number;
  fallback_reason: string | null;
  delivery_attempt: number;
  calls: string;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  wasted_cost_usd: number;
  system_prompt_hash: string | null;
  book_instructions_hash: string | null;
  text_key: string | null;
  words: number | null;
  has_header: number | null;
  metrics: string | null;
  metrics_version: number | null;
}

export function ocrRuns(world: TestWorld): OcrRunRow[] {
  return world.sqlite
    .prepare("SELECT * FROM ocr_runs ORDER BY id")
    .all() as unknown as OcrRunRow[];
}

export function fileRow(world: TestWorld): {
  state: string;
  error: string | null;
  ocr_model: string | null;
  text_key: string | null;
  input_tokens: number | null;
} {
  return world.sqlite
    .prepare(
      "SELECT state, error, ocr_model, text_key, input_tokens FROM files WHERE file_id = ?",
    )
    .get(FILE_ID) as unknown as {
    state: string;
    error: string | null;
    ocr_model: string | null;
    text_key: string | null;
    input_tokens: number | null;
  };
}
