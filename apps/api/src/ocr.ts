// OCR core. Single source of truth for transcription — the manual endpoint and
// the queue consumer both call transcribe().
//
// Two providers, tried in order:
//   1. Gemini — direct to Google AI Studio with env.GOOGLE_API_KEY (primary).
//   2. Claude — via the Cloudflare AI Gateway (fallback), used when Gemini fails
//      for a transient/capacity reason (rate limit incl. daily quota, or 5xx).
//
// Claude routes through the gateway's Anthropic endpoint. The Anthropic key is
// stored in the gateway (BYOK) — we send only the gateway auth token, never the
// provider key. (Gemini stays direct: the gateway's BYOK never resolved the AI
// Studio key, and pass-through there is unnecessary since the direct call works.)

import { buildPageDocs, deleteDocsByFile, upsertDocs } from "./lib/meili";

const SYSTEM_PROMPT = `You transcribe scanned pages of classical Arabic printed books into clean Markdown.

Rules:
- Transcribe the Arabic text faithfully, preserving the tashkeel (diacritics) exactly as printed.
- Preserve paragraph and line structure reasonably; do not translate or summarize.
- Render structural section/chapter headings (such as كتاب ...، باب ...، فصل، فائدة، مطلب — printed as standalone titles, often centered or in larger/bold type) as Markdown headings: ## for major divisions, ### for minor ones.
- At the very top there is a running header (the page number with the running topic/chapter name beside it). Transcribe it as the first line, then a BLANK line, then a line containing only "---", then a BLANK line, then the page body. (The blank line is required so the header stays plain text and "---" renders as a divider, not a Markdown heading.) Ignore any bottom footer or catchword (تعقيبة).
- If the page has footnotes (حاشية) in smaller print at the bottom, transcribe the main text (matn) first, then a BLANK line, then a line containing only "---", then a BLANK line, then a heading "### الحاشية", then the footnotes.
- Use a ruby tag ONLY for small explanatory text physically written BETWEEN the main lines (an interlinear gloss sitting above the words it explains): <ruby>النص<rt>الشرح</rt></ruby>, wrapping exactly the word or phrase it sits above. Keep the rest of the line as normal text.
- Do NOT use ruby for anything that is part of the main line itself. In particular: enumeration numbers/letters (e.g. a numbered list of شروط like ١ ٢ ٣) are normal text — render them as a numbered or inline list as printed, never as a gloss. Footnote/reference markers in the matn are normal text too.
- Output ONLY the transcription as Markdown (HTML ruby tags allowed). No preamble, no commentary, no code fences.`;

const MODEL = "gemini-3.1-pro-preview";
const CLAUDE_MODEL = "claude-sonnet-5";
const USER_PROMPT = "Transcribe this page.";
const MAX_TOKENS = 16000;

export interface TranscribeOpts {
  env: Env;
  fileId: string;
  model?: string; // bare AI Studio model id; defaults to MODEL
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
  ocr_instructions: string | null;
  book_title: string;
  page_number: number | null;
  role: string | null;
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
  model,
}: TranscribeOpts): Promise<TranscribeResult> {
  const useModel = model ?? MODEL;

  const row = await env.DB.prepare(
    `SELECT f.file_id, f.book_id, f.r2_key, f.page_number, f.role,
            b.ocr_instructions, b.title AS book_title
       FROM files f JOIN books b ON b.id = f.book_id
      WHERE f.file_id = ?`,
  )
    .bind(fileId)
    .first<FileRow>();
  if (!row) throw new Error(`file '${fileId}' not found`);

  const obj = await env.BUCKET.get(row.r2_key);
  if (!obj) throw new Error(`R2 object '${row.r2_key}' missing`);

  const mimeType = obj.httpMetadata?.contentType ?? "image/jpeg";
  const base64 = toBase64(new Uint8Array(await obj.arrayBuffer()));

  const { text, usage, model: ranModel } = await runWithFallback({
    env,
    geminiModel: useModel,
    mimeType,
    base64,
    systemPrompt: buildSystemPrompt(row.ocr_instructions),
  });

  const textKey = `books/${row.book_id}/text/${fileId}.md`;
  await env.BUCKET.put(textKey, text, {
    httpMetadata: { contentType: "text/markdown; charset=utf-8" },
  });

  const now = Date.now();
  await env.DB.prepare(
    "UPDATE files SET state = 'done', text_key = ?, preview = ?, input_tokens = ?, output_tokens = ?, ocr_model = ?, error = NULL, updated_at = ? WHERE file_id = ?",
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

  // Auto-index into search. Best-effort: a Meili outage (or cold start, or
  // unconfigured MEILI_*) must not fail OCR — the page is safe in R2/D1 and
  // POST /api/search/reindex is the backstop that re-syncs anything missed.
  if (env.MEILI_URL && env.MEILI_KEY) {
    try {
      // Clear this page's prior chunks first — a re-OCR can produce a different
      // chunk count, so upsert alone would leave stale `file_id#N` docs behind.
      await deleteDocsByFile({ env, fileId });
      await upsertDocs({
        env,
        docs: buildPageDocs({
          file_id: fileId,
          book_id: row.book_id,
          book_title: row.book_title,
          page_number: row.page_number,
          role: row.role,
          text,
        }),
      });
    } catch (err) {
      console.error(`search auto-index failed for ${fileId}: ${err}`);
    }
  }

  return { file_id: fileId, model: ranModel, text, text_key: textKey, usage };
}

// Try Gemini; on a transient/capacity failure (rate limit incl. daily quota, or
// 5xx) fall back to Claude via the AI Gateway. Terminal Gemini errors (a bad
// request, an empty response) rethrow without falling back — Claude wouldn't
// fare better and the masking would hide a real bug. Returns the model that
// actually produced the text, so cost/UI attribute the page correctly.
async function runWithFallback({
  env,
  geminiModel,
  mimeType,
  base64,
  systemPrompt,
}: {
  env: Env;
  geminiModel: string;
  mimeType: string;
  base64: string;
  systemPrompt: string;
}): Promise<{ text: string; usage: Usage; model: string }> {
  try {
    const r = await runGemini({
      env,
      model: geminiModel,
      mimeType,
      base64,
      systemPrompt,
    });
    return { ...r, model: geminiModel };
  } catch (err) {
    if (!(err instanceof OcrError) || !err.isTransient) throw err;
    console.warn(
      `Gemini transient failure, falling back to Claude: ${err.message.slice(0, 160)}`,
    );
    const r = await runClaude({ env, mimeType, base64, systemPrompt });
    return { ...r, model: CLAUDE_MODEL };
  }
}

// Raised when an OCR provider returns a non-2xx. Carries the HTTP status and,
// where the provider supplies one, a server-suggested retry delay so the queue
// consumer can back off precisely.
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

  // Conditions worth re-queuing rather than burning the page: rate limits (429)
  // and transient server errors (5xx). Client errors (4xx bar 429) are terminal.
  get isTransient(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

export class GeminiError extends OcrError {
  constructor(status: number, body: string) {
    super({
      name: "GeminiError",
      status,
      message: `Gemini ${status}: ${body}`,
      retryAfterSeconds: parseRetryDelaySeconds(body),
    });
  }
}

// Anthropic sends its retry hint in a `retry-after` response header, which we
// don't thread through here — the queue's exponential backoff covers it.
export class ClaudeError extends OcrError {
  constructor(status: number, body: string) {
    super({
      name: "ClaudeError",
      status,
      message: `Claude ${status}: ${body}`,
      retryAfterSeconds: null,
    });
  }
}

// Pull error.details[].retryDelay (e.g. "51s", "1.05s") out of a Gemini error
// body. Returns whole seconds, or null if the body has no structured delay.
function parseRetryDelaySeconds(body: string): number | null {
  try {
    const json = JSON.parse(body) as {
      error?: { details?: Array<{ retryDelay?: string }> };
    };
    for (const detail of json.error?.details ?? []) {
      const seconds = detail.retryDelay?.match(/^([\d.]+)s$/)?.[1];
      if (seconds) return Math.ceil(parseFloat(seconds));
    }
  } catch {
    // Non-JSON body — no structured delay to extract.
  }
  return null;
}

// Google AI Studio direct generateContent call (BYOK via env.GOOGLE_API_KEY).
async function runGemini({
  env,
  model,
  mimeType,
  base64,
  systemPrompt,
}: {
  env: Env;
  model: string;
  mimeType: string;
  base64: string;
  systemPrompt: string;
}): Promise<{ text: string; usage: Usage }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "x-goog-api-key": env.GOOGLE_API_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType, data: base64 } },
            { text: USER_PROMPT },
          ],
        },
      ],
      // gemini-3.1-pro is thinking-mandatory; "low" is the floor (≈0 on OCR).
      generationConfig: {
        maxOutputTokens: MAX_TOKENS,
        thinkingConfig: { thinkingLevel: "low" },
      },
    }),
  });
  if (!res.ok) {
    throw new GeminiError(res.status, await res.text());
  }

  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      thoughtsTokenCount?: number;
    };
  };
  const text = (data.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("");
  if (!text) {
    throw new Error(
      `no text in Gemini response: ${JSON.stringify(data).slice(0, 400)}`,
    );
  }

  // Input = prompt (image + text). Output = visible text + thinking tokens,
  // which bill at the output rate.
  const um = data.usageMetadata;
  const usage: Usage = {
    inputTokens: um?.promptTokenCount ?? null,
    outputTokens: um
      ? (um.candidatesTokenCount ?? 0) + (um.thoughtsTokenCount ?? 0)
      : null,
  };
  return { text, usage };
}

// Claude via the Cloudflare AI Gateway Anthropic endpoint. The Anthropic key is
// stored in the gateway (BYOK), so we authenticate the gateway itself with
// CF_AIG_TOKEN and send no provider key. Image-only: the corpus is images and
// the Messages API image block takes raster media, not PDF.
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
  if (!mimeType.startsWith("image/")) {
    throw new ClaudeError(400, `Claude OCR needs an image, got '${mimeType}'`);
  }

  const url = `https://gateway.ai.cloudflare.com/v1/${env.CF_AIG_ACCOUNT_ID}/${env.CF_AIG_GATEWAY}/anthropic/v1/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "cf-aig-authorization": `Bearer ${env.CF_AIG_TOKEN}`,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      // The gateway sits behind Cloudflare's edge; a UA-less request can trip a
      // bot-signature block (403/1010), which is terminal in our error model.
      "user-agent": "arabic-digitization-worker",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      // Transcription, not reasoning — no thinking tokens to pay for.
      thinking: { type: "disabled" },
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
    }),
  });
  if (!res.ok) {
    throw new ClaudeError(res.status, await res.text());
  }

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
