// OCR core. Single source of truth for transcription — the manual endpoint and
// the queue consumer both call transcribe().
//
// Two providers, Inkling and Claude. A book's ocr_engine picks which runs first
// (default Inkling); the other is the fallback, used when the first fails for a
// transient reason (rate limit, 5xx, network failure or timeout) or, for
// Inkling, when the page hits the output cap.
//   - Inkling — direct to Ollama Cloud with env.OLLAMA_API_KEY.
//   - Claude — via the Cloudflare AI Gateway.
//
// Claude routes through the gateway's Anthropic endpoint. The Anthropic key is
// stored in the gateway (BYOK) — we send only the gateway auth token, never the
// provider key.
//
// Both providers take raster images only, which is why uploads are limited to
// UPLOAD_CONTENT_TYPES (see types.ts).

import { indexPage, saveRevision } from "./lib/pageText";
import type { OcrEngine } from "./types";

// What the model outputs for a page with no text (see SYSTEM_PROMPT). Stored as
// an empty transcription, so a blank page is 'done' rather than 'failed'.
const BLANK_MARKER = "[blank]";

const SYSTEM_PROMPT = `You transcribe scanned pages of classical Arabic printed books into clean Markdown.

Rules:
- Transcribe the Arabic text faithfully, preserving the tashkeel (diacritics) exactly as printed.
- Preserve paragraph and line structure reasonably; do not translate or summarize.
- Render structural section/chapter headings (such as كتاب ...، باب ...، فصل، فائدة، مطلب — printed as standalone titles, often centered or in larger/bold type) as Markdown headings: ## for major divisions, ### for minor ones.
- At the very top there is a running header (the page number with the running topic/chapter name beside it). Transcribe it as the first line, then a BLANK line, then a line containing only "---", then a BLANK line, then the page body. (The blank line is required so the header stays plain text and "---" renders as a divider, not a Markdown heading.) Ignore any bottom footer or catchword (تعقيبة).
- If the page has footnotes (حاشية) in smaller print at the bottom, transcribe the main text (matn) first, then a BLANK line, then a line containing only "---", then a BLANK line, then a heading "### الحاشية", then the footnotes.
- Use a ruby tag ONLY for small explanatory text physically written BETWEEN the main lines (an interlinear gloss sitting above the words it explains): <ruby>النص<rt>الشرح</rt></ruby>, wrapping exactly the word or phrase it sits above. Keep the rest of the line as normal text.
- Do NOT use ruby for anything that is part of the main line itself. In particular: enumeration numbers/letters (e.g. a numbered list of شروط like ١ ٢ ٣) are normal text — render them as a numbered or inline list as printed, never as a gloss. Footnote/reference markers in the matn are normal text too.
- Qur'an text: ayat are printed in the Uthmani script of the mushaf. Transcribe every ayah and Qur'anic phrase letter for letter in that Uthmani spelling as printed — keep alif wasla (ٱ), dagger alif (ٰ), small waw/ya (ۥ ۦ), the small high signs (ۚ ۖ ۗ ۛ ۜ etc.) and mushaf spellings (e.g. ٱلصَّلَوٰةَ, ٱلرَّحْمَٰنِ). Never convert Qur'an text to modern spelling. Keep the ﴿ ﴾ brackets. The author's own text uses ordinary spelling; transcribe it as printed.
- If the page has no text to transcribe at all (a blank page, or only an image or ornament), output exactly ${BLANK_MARKER} and nothing else.
- Output ONLY the transcription as Markdown (HTML ruby tags allowed). No preamble, no commentary, no code fences.`;

const INKLING_MODEL = "inkling-2-small";
const CLAUDE_MODEL = "claude-sonnet-5-5";
const USER_PROMPT = "Transcribe this page.";
const CLAUDE_MAX_TOKENS = 16000;
// Inkling counts its thinking against this cap too. A dense page fits well
// under it; reaching it means the output was cut off (see InklingCutOffError).
const INKLING_MAX_TOKENS = 12000;
// A provider call that hangs this long is treated like a 5xx: fall back or
// re-queue rather than hold the queue consumer.
const PROVIDER_TIMEOUT_MS = 5 * 60 * 1000;
// The providers sit behind Cloudflare's edge; a UA-less request can trip a
// bot-signature block (403/1010), which is terminal in our error model.
const USER_AGENT = "arabic-digitization-worker";

export interface TranscribeOpts {
  env: Env;
  fileId: string;
}

export interface Usage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface TranscribeResult {
  file_id: string;
  model: string;
  text: string;
  text_key: string;
  usage: Usage;
}

interface FileRow {
  file_id: string;
  book_id: string;
  r2_key: string;
  text_key: string | null;
  ocr_instructions: string | null;
  ocr_engine: OcrEngine | null;
}

// Global rules plus any book-specific notes, layered as a labeled supplement so
// the model treats them as additions rather than contradictions to the base.
function buildSystemPrompt(ocrInstructions: string | null): string {
  if (!ocrInstructions?.trim()) return SYSTEM_PROMPT;
  return `${SYSTEM_PROMPT}

## Book-specific notes
The following notes apply to this particular book. Follow them in addition to the rules above:
${ocrInstructions.trim()}`;
}

export async function transcribe({
  env,
  fileId,
}: TranscribeOpts): Promise<TranscribeResult> {
  const row = await env.DB.prepare(
    `SELECT f.file_id, f.book_id, f.r2_key, f.text_key, b.ocr_instructions, b.ocr_engine
       FROM files f
       JOIN books b ON b.id = f.book_id
      WHERE f.file_id = ?`,
  )
    .bind(fileId)
    .first<FileRow>();
  if (!row) throw new Error(`file '${fileId}' not found`);

  const obj = await env.BUCKET.get(row.r2_key);
  if (!obj) throw new Error(`R2 object '${row.r2_key}' missing`);

  const mimeType = obj.httpMetadata?.contentType ?? "image/jpeg";
  if (!mimeType.startsWith("image/")) {
    throw new Error(`OCR needs an image, got '${mimeType}'`);
  }
  const base64 = toBase64(new Uint8Array(await obj.arrayBuffer()));

  const primary = row.ocr_engine ?? "inkling";
  const {
    text: output,
    usage,
    model: ranModel,
  } = await runWithFallback({
    env,
    primary,
    secondary: primary === "inkling" ? "claude" : "inkling",
    page: {
      mimeType,
      base64,
      systemPrompt: buildSystemPrompt(row.ocr_instructions),
    },
  });

  const text = output.trim() === BLANK_MARKER ? "" : output;

  // Keep the text this run replaces (a re-OCR), so it can be read back.
  if (row.text_key) {
    const prev = await env.BUCKET.get(row.text_key);
    if (prev) {
      await saveRevision({
        env,
        bookId: row.book_id,
        fileId,
        previous: await prev.text(),
        next: text,
        change: "ocr",
        model: ranModel,
      });
    }
  }

  const textKey = `books/${row.book_id}/text/${fileId}.md`;
  await env.BUCKET.put(textKey, text, {
    httpMetadata: { contentType: "text/markdown; charset=utf-8" },
  });

  const now = Date.now();
  await env.DB.prepare(
    "UPDATE files SET state = 'done', text_key = ?, preview = ?, input_tokens = ?, output_tokens = ?, ocr_model = ?, error = NULL, text_edited_at = NULL, updated_at = ? WHERE file_id = ?",
  )
    .bind(
      textKey,
      text.slice(0, 120),
      usage.inputTokens,
      usage.outputTokens,
      ranModel,
      now,
      fileId,
    )
    .run();

  await indexPage({ env, fileId, text });

  return { file_id: fileId, model: ranModel, text, text_key: textKey, usage };
}

interface PageInput {
  mimeType: string;
  base64: string;
  systemPrompt: string;
}

interface EngineOutput {
  text: string;
  usage: Usage;
  model: string;
}

async function runEngine({
  env,
  engine,
  page,
}: {
  env: Env;
  engine: OcrEngine;
  page: PageInput;
}): Promise<EngineOutput> {
  if (engine === "inkling") {
    const r = await runInkling({ env, ...page });
    return { ...r, model: INKLING_MODEL };
  }
  const r = await runClaude({ env, ...page });
  return { ...r, model: CLAUDE_MODEL };
}

function shouldFallBack({
  primary,
  err,
}: {
  primary: OcrEngine;
  err: unknown;
}): boolean {
  if (primary === "inkling" && err instanceof InklingCutOffError) return true;
  return err instanceof OcrError && err.isTransient;
}

// Run the primary engine; on a transient failure (rate limit, 5xx, network
// failure or timeout) — or a cut-off page when Inkling is the one that failed —
// run the secondary instead. Terminal errors (a bad request, an empty response)
// rethrow without falling back — the other provider wouldn't fare better and
// the masking would hide a real bug. Returns the model that actually produced
// the text, so cost/UI attribute the page correctly.
async function runWithFallback({
  env,
  primary,
  secondary,
  page,
}: {
  env: Env;
  primary: OcrEngine;
  secondary: OcrEngine;
  page: PageInput;
}): Promise<EngineOutput> {
  try {
    return await runEngine({ env, engine: primary, page });
  } catch (err) {
    if (!shouldFallBack({ primary, err })) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `${primary} failed, falling back to ${secondary}: ${reason.slice(0, 160)}`,
    );
    try {
      return await runEngine({ env, engine: secondary, page });
    } catch (fallbackErr) {
      // A cut-off page can't be kept, but the primary failed transiently, so
      // re-queue on that error rather than fail the page.
      if (fallbackErr instanceof InklingCutOffError) throw err;
      throw fallbackErr;
    }
  }
}

// Status used for a request that got no HTTP response at all.
const NO_RESPONSE_STATUS = 0;

// Raised when an OCR provider call fails: a non-2xx (with its HTTP status), or
// no response at all (NO_RESPONSE_STATUS). Carries the provider's retry-after
// hint, when it sends one, so the queue consumer can back off precisely.
export class OcrError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number | null;

  constructor({
    name,
    status,
    message,
    retryAfterSeconds,
  }: {
    name: string;
    status: number;
    message: string;
    retryAfterSeconds: number | null;
  }) {
    super(message);
    this.name = name;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }

  // Conditions worth re-queuing rather than burning the page: rate limits
  // (429), transient server errors (5xx), and network failures or timeouts.
  // Client errors (4xx bar 429) are terminal.
  get isTransient(): boolean {
    return (
      this.status === NO_RESPONSE_STATUS ||
      this.status === 429 ||
      this.status >= 500
    );
  }
}

interface ProviderErrorInit {
  status: number;
  body: string;
  retryAfterSeconds?: number | null;
}

export class InklingError extends OcrError {
  constructor({ status, body, retryAfterSeconds = null }: ProviderErrorInit) {
    super({
      name: "InklingError",
      status,
      message: `Inkling ${status}: ${body}`,
      retryAfterSeconds,
    });
  }
}

// Inkling stopped at INKLING_MAX_TOKENS (done_reason "length"), so the page is
// incomplete. Retrying Inkling gives the same result; Claude takes it instead.
export class InklingCutOffError extends Error {
  constructor(outputTokens: number | null) {
    super(
      `Inkling output cut off at the ${INKLING_MAX_TOKENS}-token cap (${outputTokens ?? "?"} tokens)`,
    );
    this.name = "InklingCutOffError";
  }
}

export class ClaudeError extends OcrError {
  constructor({ status, body, retryAfterSeconds = null }: ProviderErrorInit) {
    super({
      name: "ClaudeError",
      status,
      message: `Claude ${status}: ${body}`,
      retryAfterSeconds,
    });
  }
}

// A Retry-After header in its delta-seconds form; the HTTP-date form is rare
// from these APIs and the queue's exponential backoff covers it.
function parseRetryAfter(header: string | null): number | null {
  const seconds = Number(header);
  return header && Number.isFinite(seconds) && seconds >= 0
    ? Math.ceil(seconds)
    : null;
}

// POST JSON to a provider. A network failure or timeout becomes a transient
// provider error and a non-2xx carries its status and retry hint, so callers
// see one error type either way.
async function postProvider({
  url,
  headers,
  body,
  toError,
}: {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  toError: (init: ProviderErrorInit) => OcrError;
}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        "user-agent": USER_AGENT,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch (err) {
    throw toError({
      status: NO_RESPONSE_STATUS,
      body: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
  }
  if (!res.ok) {
    throw toError({
      status: res.status,
      body: await res.text(),
      retryAfterSeconds: parseRetryAfter(res.headers.get("retry-after")),
    });
  }
  return res;
}

// Ollama Cloud chat call (env.OLLAMA_API_KEY). Inkling ignores `think: false`;
// "low" is the cheapest setting that stays stable.
async function runInkling({
  env,
  base64,
  systemPrompt,
}: {
  env: Env;
  base64: string;
  systemPrompt: string;
}): Promise<{ text: string; usage: Usage }> {
  const res = await postProvider({
    url: "https://ollama.com/api/chat",
    headers: { authorization: `Bearer ${env.OLLAMA_API_KEY}` },
    body: {
      model: INKLING_MODEL,
      stream: false,
      think: "low",
      options: { num_predict: INKLING_MAX_TOKENS },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: USER_PROMPT, images: [base64] },
      ],
    },
    toError: (init) => new InklingError(init),
  });

  const data = (await res.json()) as {
    message?: { content?: string };
    done_reason?: string;
    prompt_eval_count?: number;
    eval_count?: number;
  };
  // Output = visible text + thinking tokens, which bill at the output rate.
  const usage: Usage = {
    inputTokens: data.prompt_eval_count ?? null,
    outputTokens: data.eval_count ?? null,
  };
  // A cut-off stop can come with partial text; never keep a cut-off page.
  if (data.done_reason === "length") {
    throw new InklingCutOffError(usage.outputTokens);
  }
  const text = data.message?.content ?? "";
  if (!text) {
    throw new Error(
      `no text in Inkling response: ${JSON.stringify(data).slice(0, 400)}`,
    );
  }
  return { text, usage };
}

// Claude via the Cloudflare AI Gateway Anthropic endpoint. The Anthropic key is
// stored in the gateway (BYOK), so we authenticate the gateway itself with
// CF_AIG_TOKEN and send no provider key.
async function runClaude({
  env,
  mimeType,
  base64,
  systemPrompt,
}: {
  env: Env;
  mimeType: string;
  base64: string;
  systemPrompt: string;
}): Promise<{ text: string; usage: Usage }> {
  const res = await postProvider({
    url: `https://gateway.ai.cloudflare.com/v1/${env.CF_AIG_ACCOUNT_ID}/${env.CF_AIG_GATEWAY}/anthropic/v1/messages`,
    headers: {
      "cf-aig-authorization": `Bearer ${env.CF_AIG_TOKEN}`,
      "anthropic-version": "2023-06-01",
    },
    body: {
      model: CLAUDE_MODEL,
      max_tokens: CLAUDE_MAX_TOKENS,
      system: systemPrompt,
      // Transcription, not reasoning — no thinking tokens to pay for. Sonnet 5.5
      // turns thinking off with "between_tools" and rejects "disabled".
      thinking: { type: "between_tools" },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mimeType, data: base64 },
            },
            { type: "text", text: USER_PROMPT },
          ],
        },
      ],
    },
    toError: (init) => new ClaudeError(init),
  });

  const data = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const text = (data.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
  if (!text) {
    throw new Error(
      `no text in Claude response: ${JSON.stringify(data).slice(0, 400)}`,
    );
  }

  const usage: Usage = {
    inputTokens: data.usage?.input_tokens ?? null,
    outputTokens: data.usage?.output_tokens ?? null,
  };
  return { text, usage };
}

// Chunked base64 — avoids call-stack blowups on large images that a single
// String.fromCharCode(...bytes) would hit.
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
