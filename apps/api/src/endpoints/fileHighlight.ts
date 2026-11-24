import { Effect, Schema } from "effect";
import { HttpApiEndpoint, OpenApi } from "effect/http-api";
import { EvlogLogger } from "evlog/effect";
import { type EndpointHandler, WorkerContext } from "../http/context";
import { Conflict, conflict, NotFound, notFound } from "../http/errors";
import { respond } from "../http/respond";
import {
  buildHighlight,
  type HighlightResult,
  hashQuery,
} from "../lib/highlight";
import { runInRequest } from "../logging";

// Cached highlight results live 30 days; the cache key includes the file's
// updated_at so a re-OCR (which bumps it) misses and recomputes.
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30;

const Range = Schema.Tuple([Schema.Number, Schema.Number]);

// Given a search query, return the page text plus the passages worth
// highlighting (located as char ranges). Powers cross-lingual / semantic
// highlighting in the search preview, where Meilisearch's lexical _formatted
// can't mark anything (no shared token between an English query and an Arabic
// passage). See lib/highlight.ts.
export const FileHighlight = HttpApiEndpoint.post(
  "fileHighlight",
  "/api/books/:bookId/files/:fileId/highlight",
  {
    params: { bookId: Schema.String, fileId: Schema.String },
    payload: Schema.Struct({
      query: Schema.String.check(Schema.isMinLength(1)),
    }),
    success: Schema.Struct({
      success: Schema.Literal(true),
      text: Schema.String,
      spans: Schema.Array(
        Schema.Struct({ text: Schema.String, ranges: Schema.Array(Range) }),
      ),
    }),
    error: [NotFound, Conflict],
  },
).annotate(
  OpenApi.Summary,
  "Find passages to highlight for a query on one page",
);

export const fileHighlight: EndpointHandler<
  typeof FileHighlight,
  WorkerContext | EvlogLogger
> = ({ params, payload: body }) =>
  Effect.gen(function* () {
    const { env, ctx } = yield* WorkerContext;
    const log = yield* EvlogLogger;
    const row = yield* Effect.promise(() =>
      env.DB.prepare(
        "SELECT text_key, updated_at FROM files WHERE file_id = ? AND book_id = ?",
      )
        .bind(params.fileId, params.bookId)
        .first<{ text_key: string | null; updated_at: number }>(),
    );
    if (!row) return yield* notFound(`File '${params.fileId}' not found`);
    const textKey = row.text_key;
    if (!textKey) return yield* conflict("File not transcribed yet");

    // Deterministic result → cache it. Key binds the file + its version
    // (updated_at) + the query, so re-OCR or a different query misses.
    const cacheKey = `hl:${params.fileId}:${row.updated_at}:${yield* Effect.promise(() => hashQuery(body.query))}`;
    const cached = yield* Effect.promise(() =>
      env.HIGHLIGHT_CACHE.get<HighlightResult>(cacheKey, "json"),
    );
    log.set({ highlight: { cache: cached ? "hit" : "miss" } });
    if (cached)
      return respond({
        endpoint: FileHighlight,
        body: { success: true as const, ...cached },
      });

    const obj = yield* Effect.promise(() => env.BUCKET.get(textKey));
    if (!obj) return yield* notFound("Transcription missing");
    const pageMarkdown = yield* Effect.promise(() => obj.text());

    const { text, spans } = yield* runInRequest({
      env,
      effect: buildHighlight({ query: body.query, pageMarkdown }),
    });
    // Best-effort cache write; a KV hiccup shouldn't fail the request.
    ctx.waitUntil(
      env.HIGHLIGHT_CACHE.put(cacheKey, JSON.stringify({ text, spans }), {
        expirationTtl: CACHE_TTL_SECONDS,
      }),
    );
    return respond({
      endpoint: FileHighlight,
      body: { success: true as const, text, spans },
    });
  });
