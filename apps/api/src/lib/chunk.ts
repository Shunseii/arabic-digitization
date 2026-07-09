// Split a page's markdown into overlapping chunks small enough for the bge-m3
// embedder (~512 tokens). One chunk = one indexed vector; overlap keeps a
// passage that straddles a boundary findable from either side. The char budgets
// are a heuristic proxy for tokens — Arabic is dense, so we stay well under the
// model limit rather than risk silent truncation losing a chunk's tail.

const MAX_CHARS = 1000;
const OVERLAP_CHARS = 150;

export function chunkPage(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= MAX_CHARS) return [trimmed];

  // Prefer paragraph boundaries; hard-slice any single block that alone exceeds
  // the budget (with overlap so its own seams stay searchable).
  const blocks: string[] = [];
  for (const para of trimmed.split(/\n{2,}/)) {
    const p = para.trim();
    if (!p) continue;
    if (p.length <= MAX_CHARS) {
      blocks.push(p);
    } else {
      for (let i = 0; i < p.length; i += MAX_CHARS - OVERLAP_CHARS) {
        blocks.push(p.slice(i, i + MAX_CHARS));
      }
    }
  }

  // Greedily pack blocks into chunks; when a chunk fills, seed the next one with
  // the tail of the current chunk as overlap.
  const chunks: string[] = [];
  let cur = "";
  for (const block of blocks) {
    if (cur && cur.length + block.length + 2 > MAX_CHARS) {
      chunks.push(cur);
      cur = `${cur.slice(-OVERLAP_CHARS)}\n\n${block}`;
    } else {
      cur = cur ? `${cur}\n\n${block}` : block;
    }
  }
  if (cur.trim()) chunks.push(cur);
  return chunks;
}
