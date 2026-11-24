import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { WorkerContext } from "../http/context";
import { verifyScanSignature } from "../lib/scanUrl";

// Public (no master key): serves one page scan to whoever holds a valid signed
// link from lib/scanUrl. Lets a provider fetch the image itself. Every failure
// is the same bare 404, so a probe learns nothing about which files exist.
export const scanSigned = Effect.gen(function* () {
  const { env } = yield* WorkerContext;
  const { fileId = "" } = yield* HttpRouter.params;
  const search = yield* HttpServerRequest.ParsedSearchParams;
  const notFound = HttpServerResponse.empty({ status: 404 });
  const single = (value: string | readonly string[] | undefined) =>
    typeof value === "string" ? value : value?.[0];

  const masterKey = env.MASTER_KEY;
  const valid = masterKey
    ? yield* Effect.promise(() =>
        verifyScanSignature({
          masterKey,
          fileId,
          exp: single(search.exp),
          sig: single(search.sig),
          nowSeconds: Math.floor(Date.now() / 1000),
        }),
      )
    : false;
  if (!valid) return notFound;

  const obj = yield* Effect.promise(async () => {
    const row = await env.DB.prepare(
      "SELECT r2_key FROM files WHERE file_id = ?",
    )
      .bind(fileId)
      .first<{ r2_key: string }>();
    return row ? env.BUCKET.get(row.r2_key) : null;
  });
  if (!obj) return notFound;

  return HttpServerResponse.raw(obj.body, {
    contentType: obj.httpMetadata?.contentType ?? "application/octet-stream",
    headers: { "cache-control": "private, no-store" },
  });
});
