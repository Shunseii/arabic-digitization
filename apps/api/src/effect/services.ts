// The Worker's dependencies as Effect services. liveLayer wraps `env`; tests
// provide fakes (see test/fakes.ts).

import { Context, Duration, Effect, Layer, Option, Schema } from "effect";
import { indexPageOrThrow } from "../lib/pageText";
import { signScanUrl } from "../lib/scanUrl";
import type { ReviewApplyMessage } from "../review/message";
import {
  BadResponse,
  NetworkError,
  type Provider,
  ProviderRejected,
  ProviderTimeout,
  RateLimited,
  ServerError,
  StorageError,
  type Usage,
} from "./errors";

// ---- D1 ---------------------------------------------------------------------

export type SqlValue = string | number | null;

export interface Statement {
  sql: string;
  params: readonly SqlValue[];
}

export const statement = (
  sql: string,
  params: readonly SqlValue[] = [],
): Statement => ({ sql, params });

export interface DatabaseShape {
  readonly first: <T>(
    query: Statement,
  ) => Effect.Effect<T | null, StorageError>;
  readonly all: <T>(query: Statement) => Effect.Effect<T[], StorageError>;
  readonly run: (
    query: Statement,
  ) => Effect.Effect<{ changes: number }, StorageError>;
  // One round trip, run as a single transaction (one D1 query towards the
  // per-invocation limit).
  readonly batch: (
    queries: readonly Statement[],
  ) => Effect.Effect<void, StorageError>;
}

export class Database extends Context.Service<Database, DatabaseShape>()(
  "app/Database",
) {}

function describe(cause: unknown): string {
  return cause instanceof Error
    ? `${cause.name}: ${cause.message}`
    : String(cause);
}

function storage<A>(
  operation: string,
  run: () => Promise<A>,
): Effect.Effect<A, StorageError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => new StorageError({ operation, detail: describe(cause) }),
  });
}

export function makeD1Database(db: D1Database): DatabaseShape {
  const prepare = (query: Statement) =>
    db.prepare(query.sql).bind(...query.params);
  return {
    first: <T>(query: Statement) =>
      storage("D1 query", () => prepare(query).first<T>()),
    all: <T>(query: Statement) =>
      storage("D1 query", async () => (await prepare(query).all<T>()).results),
    run: (query) =>
      storage("D1 query", async () => ({
        changes: (await prepare(query).run()).meta.changes,
      })),
    batch: (queries) =>
      queries.length === 0
        ? Effect.void
        : storage("D1 batch", () => db.batch(queries.map(prepare))).pipe(
            Effect.asVoid,
          ),
  };
}

// ---- R2 ---------------------------------------------------------------------

export interface StoredBytes {
  bytes: Uint8Array;
  contentType: string | null;
}

export interface BucketShape {
  readonly getBytes: (
    key: string,
  ) => Effect.Effect<StoredBytes | null, StorageError>;
  readonly getText: (key: string) => Effect.Effect<string | null, StorageError>;
  // Markdown text; every text object the Worker writes is Markdown.
  readonly putText: (object: {
    key: string;
    text: string;
  }) => Effect.Effect<void, StorageError>;
  // A byte range of an object (null if the object is missing).
  readonly getRange: (range: {
    key: string;
    offset: number;
    length: number;
  }) => Effect.Effect<Uint8Array | null, StorageError>;
  // Text plus its etag, for a later putTextIfMatch.
  readonly getVersionedText: (
    key: string,
  ) => Effect.Effect<{ text: string; etag: string } | null, StorageError>;
  // Writes only if the object still has `etag`; false if it changed.
  readonly putTextIfMatch: (object: {
    key: string;
    text: string;
    etag: string;
  }) => Effect.Effect<boolean, StorageError>;
  readonly putBytes: (object: {
    key: string;
    bytes: Uint8Array;
    contentType: string;
  }) => Effect.Effect<void, StorageError>;
}

export class Bucket extends Context.Service<Bucket, BucketShape>()(
  "app/Bucket",
) {}

const MARKDOWN_METADATA = { contentType: "text/markdown; charset=utf-8" };

export function makeR2Bucket(bucket: R2Bucket): BucketShape {
  return {
    getBytes: (key) =>
      storage("R2 get", async () => {
        const obj = await bucket.get(key);
        if (!obj) return null;
        return {
          bytes: new Uint8Array(await obj.arrayBuffer()),
          contentType: obj.httpMetadata?.contentType ?? null,
        };
      }),
    getText: (key) =>
      storage("R2 get", async () => {
        const obj = await bucket.get(key);
        return obj ? await obj.text() : null;
      }),
    putText: ({ key, text }) =>
      storage("R2 put", () =>
        bucket.put(key, text, { httpMetadata: MARKDOWN_METADATA }),
      ).pipe(Effect.asVoid),
    getRange: ({ key, offset, length }) =>
      storage("R2 get", async () => {
        const obj = await bucket.get(key, { range: { offset, length } });
        return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
      }),
    getVersionedText: (key) =>
      storage("R2 get", async () => {
        const obj = await bucket.get(key);
        return obj ? { text: await obj.text(), etag: obj.etag } : null;
      }),
    putTextIfMatch: ({ key, text, etag }) =>
      storage("R2 put", async () => {
        const written = await bucket.put(key, text, {
          httpMetadata: MARKDOWN_METADATA,
          onlyIf: { etagMatches: etag },
        });
        return written !== null;
      }),
    putBytes: ({ key, bytes, contentType }) =>
      storage("R2 put", () =>
        bucket.put(key, bytes, { httpMetadata: { contentType } }),
      ).pipe(Effect.asVoid),
  };
}

// ---- AI providers -----------------------------------------------------------

export type TransportError =
  | RateLimited
  | ServerError
  | ProviderTimeout
  | NetworkError
  | ProviderRejected
  | BadResponse;

// The providers sit behind Cloudflare's edge; a UA-less request can trip a
// bot-signature block (403/1010), which is terminal in our error model.
const USER_AGENT = "arabic-digitization-worker";

// A Retry-After header in its delta-seconds form; the HTTP-date form is rare
// from these APIs and the queue's exponential backoff covers it.
export function parseRetryAfter(header: string | null): number | null {
  const seconds = Number(header);
  return header && Number.isFinite(seconds) && seconds >= 0
    ? Math.ceil(seconds)
    : null;
}

export function httpFailure({
  provider,
  status,
  detail,
  retryAfterSeconds,
}: {
  provider: Provider;
  status: number;
  detail: string;
  retryAfterSeconds: number | null;
}): RateLimited | ServerError | ProviderRejected {
  if (status === 429) {
    return new RateLimited({ provider, detail, retryAfterSeconds });
  }
  if (status >= 500) {
    return new ServerError({ provider, status, detail, retryAfterSeconds });
  }
  return new ProviderRejected({ provider, status, detail });
}

const NO_USAGE = { inputTokens: null, outputTokens: null };
const ERROR_BODY_MAX = 1000;

// POST JSON and parse the JSON reply. A network failure, a timeout and a
// non-2xx each become their typed error, so callers see one error union.
export function postJson({
  provider,
  url,
  headers,
  body,
  timeoutMs,
}: {
  provider: Provider;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs?: number;
}): Effect.Effect<unknown, TransportError> {
  const exchange = Effect.gen(function* () {
    const res = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(url, {
          method: "POST",
          headers: {
            ...headers,
            "content-type": "application/json",
            "user-agent": USER_AGENT,
          },
          body: JSON.stringify(body),
          signal,
        }),
      catch: (cause) => new NetworkError({ provider, detail: describe(cause) }),
    });
    const text = yield* Effect.tryPromise({
      try: () => res.text(),
      catch: (cause) => new NetworkError({ provider, detail: describe(cause) }),
    });
    if (!res.ok) {
      return yield* httpFailure({
        provider,
        status: res.status,
        // Capped: it lands in files.error and, several times over, on the wide
        // event, and an error page can be large.
        detail: text.slice(0, ERROR_BODY_MAX),
        retryAfterSeconds: parseRetryAfter(res.headers.get("retry-after")),
      });
    }
    return yield* Effect.try({
      try: (): unknown => JSON.parse(text),
      catch: () =>
        new BadResponse({
          provider,
          detail: `2xx body was not JSON (${text.length} chars)`,
          usage: NO_USAGE,
        }),
    });
  });
  if (timeoutMs === undefined) return exchange;
  return exchange.pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(timeoutMs),
      orElse: () => Effect.fail(new ProviderTimeout({ provider, timeoutMs })),
    }),
  );
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const numberOrNull = (value: unknown): number | null =>
  typeof value === "number" ? value : null;

// The text blocks and token usage of an Anthropic Messages response.
export function readAnthropicMessage(raw: unknown): {
  text: string;
  usage: Usage;
} {
  const data = isRecord(raw) ? raw : {};
  const blocks = Array.isArray(data.content) ? data.content : [];
  const text = blocks
    .filter(
      (b): b is { type: "text"; text: string } =>
        isRecord(b) && b.type === "text" && typeof b.text === "string",
    )
    .map((b) => b.text)
    .join("");
  const usage = isRecord(data.usage) ? data.usage : {};
  return {
    text,
    usage: {
      inputTokens: numberOrNull(usage.input_tokens),
      outputTokens: numberOrNull(usage.output_tokens),
    },
  };
}

export interface ProviderRequest {
  body: unknown;
  timeoutMs?: number;
}

// Ollama Cloud chat (env.OLLAMA_API_KEY), for Inkling.
export interface OllamaShape {
  readonly chat: (
    request: ProviderRequest,
  ) => Effect.Effect<unknown, TransportError>;
}

export class Ollama extends Context.Service<Ollama, OllamaShape>()(
  "app/Ollama",
) {}

export function makeOllama(env: Env): OllamaShape {
  return {
    chat: ({ body, timeoutMs }) =>
      postJson({
        provider: "inkling",
        url: "https://ollama.com/api/chat",
        headers: { authorization: `Bearer ${env.OLLAMA_API_KEY}` },
        body,
        timeoutMs,
      }),
  };
}

// Claude via the Cloudflare AI Gateway Anthropic endpoint. The Anthropic key
// is stored in the gateway (BYOK), so we authenticate the gateway itself with
// CF_AIG_TOKEN and send no provider key.
export interface AnthropicGatewayShape {
  readonly messages: (
    request: ProviderRequest,
  ) => Effect.Effect<unknown, TransportError>;
}

export class AnthropicGateway extends Context.Service<
  AnthropicGateway,
  AnthropicGatewayShape
>()("app/AnthropicGateway") {}

export function makeAnthropicGateway(env: Env): AnthropicGatewayShape {
  return {
    messages: ({ body, timeoutMs }) =>
      postJson({
        provider: "claude",
        url: `https://gateway.ai.cloudflare.com/v1/${env.CF_AIG_ACCOUNT_ID}/${env.CF_AIG_GATEWAY}/anthropic/v1/messages`,
        headers: {
          "cf-aig-authorization": `Bearer ${env.CF_AIG_TOKEN}`,
          "anthropic-version": "2023-06-01",
        },
        body,
        timeoutMs,
      }),
  };
}

// Claude Message Batches, for the Opus review (see review/). Through the AI
// Gateway like every other Claude call (the key is stored there), unless an
// ANTHROPIC_API_KEY secret is set, which goes to the Anthropic API directly.
export interface BatchCounts {
  processing: number;
  succeeded: number;
  errored: number;
  canceled: number;
  expired: number;
}

export interface BatchSummary {
  id: string;
  createdAt: number;
  // Requests in the batch, in any state.
  requests: number;
}

export interface BatchStatus {
  processingStatus: string;
  counts: BatchCounts;
  // When Anthropic finished the batch (its ended_at, epoch ms); null until then.
  endedAt: number | null;
}

export interface AnthropicBatchesShape {
  // `body` is the request JSON as text: built from stored parts and sent
  // without being parsed again.
  readonly create: (body: string) => Effect.Effect<string, TransportError>;
  readonly retrieve: (
    batchId: string,
  ) => Effect.Effect<BatchStatus, TransportError>;
  // The workspace's most recent batches (one page, newest first).
  readonly list: () => Effect.Effect<BatchSummary[], TransportError>;
  // The raw results JSONL, unparsed.
  readonly results: (
    batchId: string,
  ) => Effect.Effect<Uint8Array, TransportError>;
}

export class AnthropicBatches extends Context.Service<
  AnthropicBatches,
  AnthropicBatchesShape
>()("app/AnthropicBatches") {}

function batchEndpoint(env: Env): {
  base: string;
  headers: Record<string, string>;
} {
  const common = {
    "anthropic-version": "2023-06-01",
    "user-agent": USER_AGENT,
  };
  if (env.ANTHROPIC_API_KEY) {
    return {
      base: "https://api.anthropic.com/v1/messages/batches",
      headers: { ...common, "x-api-key": env.ANTHROPIC_API_KEY },
    };
  }
  return {
    base: `https://gateway.ai.cloudflare.com/v1/${env.CF_AIG_ACCOUNT_ID}/${env.CF_AIG_GATEWAY}/anthropic/v1/messages/batches`,
    headers: {
      ...common,
      "cf-aig-authorization": `Bearer ${env.CF_AIG_TOKEN}`,
    },
  };
}

function exchange({
  url,
  init,
}: {
  url: string;
  init: RequestInit;
}): Effect.Effect<Response, TransportError> {
  const provider = "claude";
  return Effect.gen(function* () {
    const res = yield* Effect.tryPromise({
      try: (signal) => fetch(url, { ...init, signal }),
      catch: (cause) => new NetworkError({ provider, detail: describe(cause) }),
    });
    if (res.ok) return res;
    const text = yield* Effect.tryPromise({
      try: () => res.text(),
      catch: (cause) => new NetworkError({ provider, detail: describe(cause) }),
    });
    return yield* httpFailure({
      provider,
      status: res.status,
      detail: text.slice(0, ERROR_BODY_MAX),
      retryAfterSeconds: parseRetryAfter(res.headers.get("retry-after")),
    });
  });
}

const notJson = (detail: string) =>
  new BadResponse({ provider: "claude", detail, usage: NO_USAGE });

function readJson(res: Response): Effect.Effect<unknown, TransportError> {
  return Effect.tryPromise({
    try: (): Promise<unknown> => res.json(),
    catch: () => notJson("2xx body was not JSON"),
  });
}

// Anthropic's Message Batch object, as create, retrieve and list return it.
// Decoded with Schema: a body that doesn't match is a BadResponse, never a
// guess.
const RequestCounts = Schema.Struct({
  processing: Schema.Number,
  succeeded: Schema.Number,
  errored: Schema.Number,
  canceled: Schema.Number,
  expired: Schema.Number,
});

const BatchObject = Schema.Struct({
  id: Schema.String,
  processing_status: Schema.String,
  request_counts: RequestCounts,
  created_at: Schema.String,
  ended_at: Schema.optional(Schema.NullOr(Schema.String)),
});

const BatchPage = Schema.Struct({ data: Schema.Array(BatchObject) });

const decodeBatchObject = Schema.decodeUnknownOption(BatchObject);
const decodeBatchPage = Schema.decodeUnknownOption(BatchPage);

const timeOrNull = (value: string | null | undefined): number | null => {
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(time) ? null : time;
};

// The status in a batch object, or null if the body isn't one.
export function readBatchStatus(raw: unknown): BatchStatus | null {
  const batch = Option.getOrNull(decodeBatchObject(raw));
  if (!batch) return null;
  return {
    processingStatus: batch.processing_status,
    endedAt: timeOrNull(batch.ended_at),
    counts: { ...batch.request_counts },
  };
}

// One page of the batch list, or null if the body isn't one.
export function readBatchList(raw: unknown): BatchSummary[] | null {
  const page = Option.getOrNull(decodeBatchPage(raw));
  if (!page) return null;
  return page.data.flatMap((batch) => {
    const createdAt = timeOrNull(batch.created_at);
    if (createdAt === null) return [];
    const counts = batch.request_counts;
    const requests =
      counts.processing +
      counts.succeeded +
      counts.errored +
      counts.canceled +
      counts.expired;
    return [{ id: batch.id, createdAt, requests }];
  });
}

const decoded =
  <A>(what: string) =>
  (value: A | null) =>
    value === null
      ? Effect.fail(notJson(`unexpected ${what} body`))
      : Effect.succeed(value);

const BATCH_LIST_LIMIT = 20;

export function makeAnthropicBatches(env: Env): AnthropicBatchesShape {
  const { base, headers } = batchEndpoint(env);
  const batchUrl = (batchId: string) =>
    `${base}/${encodeURIComponent(batchId)}`;
  return {
    create: (body) =>
      exchange({
        url: base,
        init: {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body,
        },
      }).pipe(
        Effect.flatMap(readJson),
        Effect.map(
          (raw) => Option.getOrNull(decodeBatchObject(raw))?.id ?? null,
        ),
        Effect.flatMap(decoded<string>("batch create")),
      ),
    retrieve: (batchId) =>
      exchange({ url: batchUrl(batchId), init: { headers } }).pipe(
        Effect.flatMap(readJson),
        Effect.map(readBatchStatus),
        Effect.flatMap(decoded<BatchStatus>("batch retrieve")),
      ),
    list: () =>
      exchange({
        url: `${base}?limit=${BATCH_LIST_LIMIT}`,
        init: { headers },
      }).pipe(
        Effect.flatMap(readJson),
        Effect.map(readBatchList),
        Effect.flatMap(decoded<BatchSummary[]>("batch list")),
      ),
    results: (batchId) =>
      exchange({ url: `${batchUrl(batchId)}/results`, init: { headers } }).pipe(
        Effect.flatMap((res) =>
          Effect.tryPromise({
            try: async () => new Uint8Array(await res.arrayBuffer()),
            catch: (cause) =>
              new NetworkError({ provider: "claude", detail: describe(cause) }),
          }),
        ),
      ),
  };
}

// The review Workflow's instances (env.REVIEW_WORKFLOW): their coarse status,
// or null when the instance can't be found (gone past retention, or never
// created).
export interface ReviewInstancesShape {
  readonly status: (instanceId: string) => Effect.Effect<string | null>;
}

export class ReviewInstances extends Context.Service<
  ReviewInstances,
  ReviewInstancesShape
>()("app/ReviewInstances") {}

export function makeReviewInstances(workflow: Workflow): ReviewInstancesShape {
  return {
    // get() rejects for an instance that doesn't exist (or no longer does);
    // that is the expected answer here, not a failure.
    status: (instanceId) =>
      Effect.tryPromise(async () => {
        const instance = await workflow.get(instanceId);
        return (await instance.status()).status;
      }).pipe(Effect.catch(() => Effect.succeed(null))),
  };
}

// Hands each reviewed page to the OCR queue's consumer, which applies it.
export interface ReviewQueueShape {
  readonly send: (
    messages: readonly ReviewApplyMessage[],
  ) => Effect.Effect<void, StorageError>;
}

export class ReviewQueue extends Context.Service<
  ReviewQueue,
  ReviewQueueShape
>()("app/ReviewQueue") {}

// Cloudflare Queues take at most 100 messages per sendBatch.
const QUEUE_BATCH_MAX = 100;

export function makeReviewQueue(queue: Queue): ReviewQueueShape {
  return {
    send: (messages) =>
      storage("Queue send", async () => {
        for (let i = 0; i < messages.length; i += QUEUE_BATCH_MAX) {
          await queue.sendBatch(
            messages.slice(i, i + QUEUE_BATCH_MAX).map((body) => ({ body })),
          );
        }
      }),
  };
}

// ---- Clock and search index ------------------------------------------------

export interface WallClockShape {
  readonly now: () => number;
}

export class WallClock extends Context.Service<WallClock, WallClockShape>()(
  "app/WallClock",
) {}

export const systemClock: WallClockShape = { now: () => Date.now() };

// Best-effort: a Meili outage must not fail the OCR run, so failures are only
// logged (into the wide event).
export interface PageIndexerShape {
  readonly index: (page: {
    fileId: string;
    text: string;
  }) => Effect.Effect<void>;
}

export class PageIndexer extends Context.Service<
  PageIndexer,
  PageIndexerShape
>()("app/PageIndexer") {}

export function makePageIndexer(env: Env): PageIndexerShape {
  return {
    index: ({ fileId, text }) =>
      Effect.tryPromise(() => indexPageOrThrow({ env, fileId, text })).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("search index update failed").pipe(
            Effect.annotateLogs({ index_error: describe(cause) }),
          ),
        ),
      ),
  };
}

// ---- Signed scan links --------------------------------------------------------

// Mints a short-lived signed link to a page scan (lib/scanUrl), so a provider
// can fetch the image instead of us base64-encoding it into the request.
export interface ScanLinksShape {
  readonly urlFor: (request: {
    fileId: string;
    ttlSeconds: number;
  }) => Effect.Effect<string>;
}

export class ScanLinks extends Context.Service<ScanLinks, ScanLinksShape>()(
  "app/ScanLinks",
) {}

export function makeScanLinks(env: Env): ScanLinksShape {
  return {
    urlFor: ({ fileId, ttlSeconds }) =>
      Effect.promise(() =>
        signScanUrl({
          baseUrl: env.PUBLIC_API_URL,
          masterKey: env.MASTER_KEY,
          fileId,
          expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds,
        }),
      ),
  };
}

export type AppServices =
  | Database
  | Bucket
  | Ollama
  | AnthropicGateway
  | AnthropicBatches
  | ReviewQueue
  | ReviewInstances
  | WallClock
  | PageIndexer
  | ScanLinks;

export function liveLayer(env: Env): Layer.Layer<AppServices> {
  return Layer.mergeAll(
    Layer.succeed(Database, makeD1Database(env.DB)),
    Layer.succeed(Bucket, makeR2Bucket(env.BUCKET)),
    Layer.succeed(Ollama, makeOllama(env)),
    Layer.succeed(AnthropicGateway, makeAnthropicGateway(env)),
    Layer.succeed(AnthropicBatches, makeAnthropicBatches(env)),
    Layer.succeed(ReviewQueue, makeReviewQueue(env.OCR_Q)),
    Layer.succeed(ReviewInstances, makeReviewInstances(env.REVIEW_WORKFLOW)),
    Layer.succeed(WallClock, systemClock),
    Layer.succeed(PageIndexer, makePageIndexer(env)),
    Layer.succeed(ScanLinks, makeScanLinks(env)),
  );
}
