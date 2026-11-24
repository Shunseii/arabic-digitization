// Wide events (evlog): one structured event per HTTP request and one per queue
// message, written to Workers Logs as console JSON.
//
// Effect's own logging feeds the same event: loggerLayer routes Effect.log*
// entries and their annotations into the EvlogLogger of the current unit of
// work, so handlers and libs log through Effect and the event stays the single
// record of what happened. No tracer is installed, so Effect spans stay in
// process and are not exported.
//
// Never put page text, prompts or keys on an event.

import { Effect, type Layer } from "effect";
import { type AuditableLogger, createError, type EvlogError } from "evlog";
import { EvlogLogger, loggerLayer } from "evlog/effect";
import { createWorkersLogger, initWorkersLogger } from "evlog/workers";
import type { MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import type { OcrError } from "./effect/errors";
import { type AppServices, liveLayer } from "./effect/services";
import type { AppContext, AppEnv } from "./types";

export const SERVICE_NAME = "arabic-digitization";

// Request headers copied onto the event. An allowlist, so Authorization (the
// master key) and anything else sensitive can never be logged.
export const HEADER_ALLOWLIST = [
  "content-type",
  "content-length",
  "user-agent",
];

export function initLogging(): void {
  initWorkersLogger({ env: { service: SERVICE_NAME } });
}

export const effectLogger: Layer.Layer<never> = loggerLayer();

// The request's logger, keyed by the Request object the fetch handler received
// (Hono passes it through unchanged as c.req.raw).
const requestLoggers = new WeakMap<Request, AuditableLogger>();

export function withRequestEvent<TEnv, TCtx extends ExecutionContext>(
  handler: (request: Request, env: TEnv, ctx: TCtx) => Promise<Response>,
): (request: Request, env: TEnv, ctx: TCtx) => Promise<Response> {
  return async (request, env, ctx) => {
    const log = createWorkersLogger(request, {
      executionCtx: ctx,
      headers: HEADER_ALLOWLIST,
    });
    requestLoggers.set(request, log);
    try {
      const response = await handler(request, env, ctx);
      log.emit({ status: response.status });
      return response;
    } catch (error) {
      log.error(error instanceof Error ? error : String(error));
      log.emit({ status: 500 });
      throw error;
    }
  };
}

const BOOK_AND_FILE = /^\/api\/books\/([^/]+)(?:\/files\/([^/]+))?/;

// Hono middleware: exposes the request's logger as c.get("log") and, once the
// route has run, records which route matched and the book/file it addressed.
export const requestEvent: MiddlewareHandler<AppEnv> = async (c, next) => {
  const log =
    requestLoggers.get(c.req.raw) ??
    createWorkersLogger(c.req.raw, { headers: HEADER_ALLOWLIST });
  c.set("log", log);
  await next();
  const [, bookId, fileId] = BOOK_AND_FILE.exec(c.req.path) ?? [];
  log.set({
    route: `${c.req.method} ${routePath(c, -1)}`,
    ...(bookId ? { book_id: decodeURIComponent(bookId) } : {}),
    ...(fileId ? { file_id: decodeURIComponent(fileId) } : {}),
  });
};

// Replaces Hono's default error handler with the same response (a plain-text
// 500), but records the error on the wide event instead of console.error.
export function recordUnhandledError(error: Error, c: AppContext): Response {
  if ("getResponse" in error && typeof error.getResponse === "function") {
    const res: Response = error.getResponse();
    return c.newResponse(res.body, res);
  }
  c.get("log").error(error);
  return c.text("Internal Server Error", 500);
}

const RETRIED_BY_QUEUE =
  "Nothing to do for a single failure: the queue retries with backoff. If it keeps happening, check the provider's status and quota.";

// The why/fix explanation for a typed failure, at the edge where it leaves
// Effect (HTTP response or queue message).
export function toEvlogError(error: OcrError): EvlogError {
  const base = { message: error.message, status: 500, cause: error };
  switch (error._tag) {
    case "RateLimited":
      return createError({
        ...base,
        why: `The ${error.provider} provider rate-limited the call (429).`,
        fix: RETRIED_BY_QUEUE,
      });
    case "ServerError":
      return createError({
        ...base,
        why: `The ${error.provider} provider returned a server error (${error.status}).`,
        fix: RETRIED_BY_QUEUE,
      });
    case "ProviderTimeout":
      return createError({
        ...base,
        why: `The ${error.provider} provider sent no reply within ${error.timeoutMs} ms.`,
        fix: RETRIED_BY_QUEUE,
      });
    case "NetworkError":
      return createError({
        ...base,
        why: `The request to the ${error.provider} provider failed before any reply.`,
        fix: RETRIED_BY_QUEUE,
      });
    case "ProviderRejected":
      return createError({
        ...base,
        why: `The ${error.provider} provider rejected the request (${error.status}).`,
        fix: "Check the request: a 401/403 means the OLLAMA_API_KEY or CF_AIG_TOKEN secret is wrong or expired; a 400 usually means a model name or parameter the provider no longer accepts.",
      });
    case "InklingCutOff":
      return createError({
        ...base,
        why: "Inkling reached its output cap, so the page would be incomplete.",
        fix: "Claude takes cut-off pages; if Claude failed too, see its error. Set the book's ocr_engine to claude for very dense books.",
      });
    case "BadResponse":
      return createError({
        ...base,
        why: `The ${error.provider} provider answered without usable text.`,
        fix: "Re-run the page (POST .../ocr). If it repeats, the provider's response format may have changed.",
      });
    case "NotAnImage":
      return createError({
        ...base,
        why: `The stored scan is '${error.contentType}', and the OCR providers read raster images only.`,
        fix: "Upload the page as JPEG, PNG or WebP.",
      });
    case "FileNotFound":
      return createError({
        ...base,
        why: "The file row no longer exists; it was probably deleted while queued.",
        fix: "Nothing to do.",
      });
    case "ObjectMissing":
      return createError({
        ...base,
        why: "The scan's R2 object is missing.",
        fix: "Delete the page and upload the scan again.",
      });
    case "StorageError":
      return createError({
        ...base,
        why: "D1 or R2 failed the operation.",
        fix: "Retry; check the Cloudflare status page if it persists.",
      });
  }
}

// Run an Effect program inside an HTTP handler, with the live services and the
// request's wide event as its logger. Typed failures reject as evlog errors.
export function runInRequest<A>({
  c,
  effect,
}: {
  c: AppContext;
  effect: Effect.Effect<A, OcrError, AppServices>;
}): Promise<A> {
  return Effect.runPromise(
    effect.pipe(
      Effect.mapError(toEvlogError),
      Effect.provide(liveLayer(c.env)),
      Effect.provideService(EvlogLogger, c.get("log")),
      Effect.provide(effectLogger),
    ),
  );
}
