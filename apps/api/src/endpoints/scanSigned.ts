import type { Context } from "hono";
import { verifyScanSignature } from "../lib/scanUrl";

// Public (no master key): serves one page scan to whoever holds a valid signed
// link from lib/scanUrl. Lets a provider fetch the image itself. Every failure
// is the same bare 404, so a probe learns nothing about which files exist.
export async function scanSigned(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  const fileId = c.req.param("fileId") ?? "";
  const notFound = () => c.body(null, 404);

  const valid = c.env.MASTER_KEY
    ? await verifyScanSignature({
        masterKey: c.env.MASTER_KEY,
        fileId,
        exp: c.req.query("exp"),
        sig: c.req.query("sig"),
        nowSeconds: Math.floor(Date.now() / 1000),
      })
    : false;
  if (!valid) return notFound();

  const row = await c.env.DB.prepare(
    "SELECT r2_key FROM files WHERE file_id = ?",
  )
    .bind(fileId)
    .first<{ r2_key: string }>();
  if (!row) return notFound();

  const obj = await c.env.BUCKET.get(row.r2_key);
  if (!obj) return notFound();

  return c.body(obj.body, 200, {
    "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream",
    "cache-control": "private, no-store",
  });
}
