// Search-result highlighting. Given a page's OCR text and a search query (any
// language, keyword or phrase), ask Claude Haiku for the relevant passages,
// then locate each verbatim in the page so the client can wrap it.
//
// Why this is more than indexOf: hybrid search matches cross-lingually and
// semantically, so the relevant passage shares no token with the query — only
// an LLM can pick it. And the model returns the *right* text but often minus an
// OCR artifact (an inline footnote marker like (١), a diacritic, a line break),
// so a raw substring match misses it. We locate against a normalized skeleton
// (diacritics, footnote and list markers, alef/ta-marbuta variants, and
// whitespace runs folded out) and map back to real offsets — recovering those near-misses.

import { Effect } from "effect";
import { BadResponse } from "../effect/errors";
import {
  AnthropicGateway,
  isRecord,
  readAnthropicMessage,
  type TransportError,
  WallClock,
} from "../effect/services";
import { costUsd } from "./cost";

// Mirrors @qiraa/shared HighlightSpan; redefined locally so the Worker doesn't
// take a dependency on the shared package.
export interface HighlightSpan {
  text: string;
  ranges: [number, number][];
}

export const HIGHLIGHT_MODEL = "claude-haiku-5-5";
const MAX_TOKENS = 2048;

const SYSTEM_PROMPT = `You are given the full text of a scanned Arabic book page and a search query (English or Arabic, keyword or natural-language phrase). Identify the passages on the page that are most relevant to the query and worth highlighting for a reader. Return them as a list of spans, each copied EXACTLY as it appears on the page (verbatim characters, including diacritics). Include ONLY genuinely relevant passages and order them most-relevant first; prefer the few best spans over many weak ones (at most ~6). Each span should be a focused phrase or sentence, not the whole page. Return an empty list if nothing on the page is relevant.`;

// Strip OCR markup but keep newlines (readability) and character positions
// stable enough to locate spans against. Mirrors the desktop cleanSnippet, but
// preserves line breaks instead of collapsing everything to one line.
export function cleanText(md: string): string {
  return md
    .replace(/__\/?ais-highlight__/g, "")
    .replace(/<rt>[\s\S]*?<\/rt>/g, "") // interlinear gloss content
    .replace(/<[^>]+>/g, "") // remaining HTML (ruby, em, …)
    .replace(/^\s*#{1,6}\s+/gm, "") // md headings
    .replace(/\s*-{3,}\s*/g, "\n") // dividers → line break
    .replace(/[*_`>]/g, "") // emphasis / blockquote markers
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const DIACRITIC = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/;
const LETTER_SUB: Record<string, string> = {
  أ: "ا",
  إ: "ا",
  آ: "ا",
  ى: "ي",
  ؤ: "و",
  ئ: "ي",
  ة: "ه",
};

// Normalized skeleton + a map from each normalized char back to its raw index.
// Dropped: diacritics/tatweel, footnote and list markers (`(` `)` `[` `]` and
// Arabic-indic digits), and collapsed whitespace runs (folded to a single space
// at the run's start).
const MARKER_CHARS = new Set(["(", ")", "[", "]"]);

function normalize(s: string): { norm: string; idx: number[] } {
  const out: string[] = [];
  const idx: number[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i] as string;
    if (DIACRITIC.test(c) || MARKER_CHARS.has(c) || (c >= "٠" && c <= "٩")) {
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      out.push(" ");
      idx.push(i);
      while (i < s.length && /\s/.test(s[i] as string)) i++;
      continue;
    }
    out.push(LETTER_SUB[c] ?? c);
    idx.push(i);
    i++;
  }
  return { norm: out.join(""), idx };
}

// Every occurrence of `span` in `page`, as [start, end) raw offsets into page.
function locateAll(span: string, page: string): [number, number][] {
  const ns = normalize(cleanText(span)).norm.trim();
  if (!ns) return [];
  const { norm: np, idx } = normalize(page);
  const ranges: [number, number][] = [];
  let from = np.indexOf(ns);
  while (from >= 0) {
    const start = idx[from] as number;
    const end = (idx[from + ns.length - 1] as number) + 1;
    ranges.push([start, end]);
    from = np.indexOf(ns, from + ns.length);
  }
  return ranges;
}

// Claude Haiku via the AI Gateway (the AnthropicGateway service). Structured
// output pins the reply to {spans: string[]}. No temperature: Haiku 5.5
// rejects it. Records the call's model, tokens, cost and latency on the wide
// event.
function extractSpans({
  query,
  pageText,
}: {
  query: string;
  pageText: string;
}): Effect.Effect<string[], TransportError, AnthropicGateway | WallClock> {
  return Effect.gen(function* () {
    const gateway = yield* AnthropicGateway;
    const clock = yield* WallClock;
    const startedAt = clock.now();
    const raw = yield* gateway.messages({
      body: {
        model: HIGHLIGHT_MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `QUERY: ${query}\n\nPAGE TEXT:\n${pageText}`,
          },
        ],
        output_config: {
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: {
                spans: { type: "array", items: { type: "string" } },
              },
              required: ["spans"],
              additionalProperties: false,
            },
          },
        },
      },
    });
    const { text, usage } = readAnthropicMessage(raw);
    yield* Effect.logInfo("highlight spans extracted").pipe(
      Effect.annotateLogs({
        highlight: {
          model: HIGHLIGHT_MODEL,
          tokens: { input: usage.inputTokens, output: usage.outputTokens },
          cost_usd: costUsd({ model: HIGHLIGHT_MODEL, ...usage }),
          latency_ms: clock.now() - startedAt,
        },
      }),
    );
    if (!text) return [];
    const parsed = yield* Effect.try({
      try: (): unknown => JSON.parse(text),
      catch: () =>
        new BadResponse({
          provider: "claude",
          detail: `structured output was not JSON (${text.length} chars)`,
          usage,
        }),
    });
    const spans = isRecord(parsed) ? parsed.spans : undefined;
    if (!Array.isArray(spans)) return [];
    return spans.filter(
      (span): span is string => typeof span === "string" && span.trim() !== "",
    );
  });
}

export interface HighlightResult {
  text: string;
  spans: HighlightSpan[];
}

// Short stable digest of a query, for use in a KV cache key (keeps keys bounded
// and ASCII-safe regardless of the query's script/length).
export async function hashQuery(query: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(query),
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

// Orchestrate: clean the page, ask Claude for relevant spans, locate each.
// Spans that don't locate verbatim are dropped — every returned range is
// guaranteed to slice cleanly out of `text`.
export function buildHighlight({
  query,
  pageMarkdown,
}: {
  query: string;
  pageMarkdown: string;
}): Effect.Effect<
  HighlightResult,
  TransportError,
  AnthropicGateway | WallClock
> {
  const text = cleanText(pageMarkdown);
  return extractSpans({ query, pageText: text }).pipe(
    Effect.map((rawSpans) => ({
      text,
      spans: locateSpans({ rawSpans, text }),
    })),
  );
}

export function locateSpans({
  rawSpans,
  text,
}: {
  rawSpans: readonly string[];
  text: string;
}): HighlightSpan[] {
  const spans: HighlightSpan[] = [];
  for (const s of rawSpans) {
    const ranges = locateAll(s, text);
    if (ranges.length > 0) spans.push({ text: cleanText(s).trim(), ranges });
  }
  return spans;
}
