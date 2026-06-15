import type { MiddlewareHandler } from "hono";

// Constant-time string comparison. Length difference still short-circuits
// (a minor, accepted leak); the per-byte loop avoids leaking *where* a
// same-length value diverges.
function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++)
    diff |= (ab[i] as number) ^ (bb[i] as number);
  return diff === 0;
}

// Single-user gate: one shared secret, sent as `Authorization: Bearer <key>`.
// No accounts, no sessions — the key IS the account. Compared against
// env.MASTER_KEY (.dev.vars locally, `wrangler secret put` in prod).
export const requireMasterKey: MiddlewareHandler<{ Bindings: Env }> = async (
  c,
  next,
) => {
  const expected = c.env.MASTER_KEY;
  if (!expected) {
    // Misconfiguration — fail closed rather than allow open access.
    return c.json({ success: false, error: "Server auth not configured" }, 500);
  }

  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (!token || !safeEqual(token, expected)) {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }

  await next();
};
