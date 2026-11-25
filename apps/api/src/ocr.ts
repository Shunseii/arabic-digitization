// OCR core: transcribe one page and record the run. The queue consumer is the
// only caller; upload, manual re-run and bulk requeue all go through the queue.
//
// Two providers, Inkling and Claude. A book's ocr_engine picks which runs first
// (default Inkling); the other is the fallback, used when the first fails for a
// transient reason (rate limit, 5xx, network failure or timeout) or, for
// Inkling, when the page hits the output cap.
//   - Inkling — direct to Ollama Cloud (the Ollama service).
//   - Claude — via the Cloudflare AI Gateway (the AnthropicGateway service).
//
// Both providers take raster images only, which is why uploads are limited to
// UPLOAD_CONTENT_TYPES (see types.ts).
//
// Every run ends in one D1 batch: the page's new state, the revision it
// replaced, the prompt versions it used, and its ocr_runs row.

import { Buffer } from "node:buffer";
import { Effect } from "effect";
import { resolveFailure } from "./dlq";
import {
  BadResponse,
  FileNotFound,
  fallbackReason,
  InklingCutOff,
  isTransient,
  NotAnImage,
  ObjectMissing,
  type OcrError,
  type ProviderError,
  type StorageError,
  type TransientError,
  type Usage,
  usageOf,
} from "./effect/errors";
import {
  AnthropicGateway,
  Bucket,
  Database,
  isRecord,
  numberOrNull,
  Ollama,
  PageIndexer,
  readAnthropicMessage,
  ScanLinks,
  type Statement,
  statement,
  WallClock,
} from "./effect/services";
import { measurePage } from "./lib/metrics";
import {
  type CallRecord,
  callCost,
  fallbackReasonOf,
  insertOcrRun,
  insertPromptVersion,
  type OcrTrigger,
  type PromptVersion,
  type RunStatus,
  runTextKey,
  runTotals,
  sha256Hex,
} from "./lib/ocrRuns";
import { historyKey } from "./lib/pageText";
import { ocrSpend } from "./lib/spend";
import { enqueueReview } from "./review/pending";
import type { OcrEngine } from "./types";

// What the model outputs for a page with no text (see SYSTEM_PROMPT). Stored as
// an empty transcription, so a blank page is 'done' rather than 'failed'.
const BLANK_MARKER = "[blank]";

export const SYSTEM_PROMPT = `You transcribe scanned pages of classical Arabic printed books into clean Markdown.

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

export const INKLING_MODEL = "inkling-2-small";
export const CLAUDE_MODEL = "claude-sonnet-5-5";
const USER_PROMPT = "Transcribe this page.";
const CLAUDE_MAX_TOKENS = 16000;
// Inkling counts its thinking against this cap too. A dense page fits well
// under it; reaching it means the output was cut off (see InklingCutOff).
export const INKLING_MAX_TOKENS = 12000;
// A provider call that hangs this long is treated like a 5xx: fall back or
// re-queue rather than hold the queue consumer.
export const PROVIDER_TIMEOUT_MS = 5 * 60 * 1000;

const MODEL_OF: Record<OcrEngine, string> = {
  inkling: INKLING_MODEL,
  claude: CLAUDE_MODEL,
};

interface FileRow {
  file_id: string;
  book_id: string;
  r2_key: string;
  text_key: string | null;
  ocr_instructions: string | null;
  ocr_engine: OcrEngine | null;
}

interface PageInput {
  mimeType: string;
  // Inkling only: Ollama takes the image inline. Encoded on first use, so a
  // Claude-only run never pays for it.
  base64: () => string;
  // Claude fetches the scan itself from this signed link.
  imageUrl: string;
  systemPrompt: string;
}

interface EngineOutput {
  text: string;
  usage: Usage;
}

interface EngineSuccess extends EngineOutput {
  model: string;
}

// Global rules plus any book-specific notes, layered as a labeled supplement so
// the model treats them as additions rather than contradictions to the base.
function buildSystemPrompt(bookInstructions: string | null): string {
  if (!bookInstructions) return SYSTEM_PROMPT;
  return `${SYSTEM_PROMPT}

## Book-specific notes
The following notes apply to this particular book. Follow them in addition to the rules above:
${bookInstructions}`;
}

let systemPromptHash: Promise<string> | undefined;

function promptVersions(bookInstructions: string | null): Effect.Effect<{
  system: PromptVersion;
  book: PromptVersion | null;
}> {
  return Effect.promise(async () => {
    systemPromptHash ??= sha256Hex(SYSTEM_PROMPT);
    return {
      system: {
        hash: await systemPromptHash,
        kind: "system",
        text: SYSTEM_PROMPT,
      },
      book: bookInstructions
        ? {
            hash: await sha256Hex(bookInstructions),
            kind: "book_instructions",
            text: bookInstructions,
          }
        : null,
    };
  });
}

// Ollama Cloud chat call. Inkling ignores `think: false`; "low" is the
// cheapest setting that stays stable.
function runInkling(
  page: PageInput,
): Effect.Effect<EngineOutput, ProviderError, Ollama> {
  return Effect.gen(function* () {
    const ollama = yield* Ollama;
    const raw = yield* ollama.chat({
      timeoutMs: PROVIDER_TIMEOUT_MS,
      body: {
        model: INKLING_MODEL,
        stream: false,
        think: "low",
        options: { num_predict: INKLING_MAX_TOKENS },
        messages: [
          { role: "system", content: page.systemPrompt },
          { role: "user", content: USER_PROMPT, images: [page.base64()] },
        ],
      },
    });
    const data = isRecord(raw) ? raw : {};
    // Output = visible text + thinking tokens, which bill at the output rate.
    const usage: Usage = {
      inputTokens: numberOrNull(data.prompt_eval_count),
      outputTokens: numberOrNull(data.eval_count),
    };
    // A cut-off stop can come with partial text; never keep a cut-off page.
    if (data.done_reason === "length") {
      return yield* new InklingCutOff({
        maxTokens: INKLING_MAX_TOKENS,
        usage,
      });
    }
    const content = isRecord(data.message) ? data.message.content : undefined;
    if (typeof content !== "string" || content === "") {
      // Structure only: the body may hold page text or thinking.
      return yield* new BadResponse({
        provider: "inkling",
        detail: `done_reason=${String(data.done_reason)}, fields=${Object.keys(data).join(",")}`,
        usage,
      });
    }
    return { text: content, usage };
  });
}

function runClaude(
  page: PageInput,
): Effect.Effect<EngineOutput, ProviderError, AnthropicGateway> {
  return Effect.gen(function* () {
    const gateway = yield* AnthropicGateway;
    const raw = yield* gateway.messages({
      timeoutMs: PROVIDER_TIMEOUT_MS,
      body: {
        model: CLAUDE_MODEL,
        max_tokens: CLAUDE_MAX_TOKENS,
        system: page.systemPrompt,
        // Transcription, not reasoning — no thinking tokens to pay for. Sonnet
        // 5.5 turns thinking off with "between_tools" and rejects "disabled".
        thinking: { type: "between_tools" },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "url", url: page.imageUrl },
              },
              { type: "text", text: USER_PROMPT },
            ],
          },
        ],
      },
    });
    const { text, usage } = readAnthropicMessage(raw);
    if (!text) {
      // Structure only: the body may hold page text.
      const data = isRecord(raw) ? raw : {};
      const blocks = Array.isArray(data.content) ? data.content : [];
      return yield* new BadResponse({
        provider: "claude",
        detail: `stop_reason=${String(data.stop_reason)}, content=[${blocks.map((b) => (isRecord(b) ? String(b.type) : typeof b)).join(",")}]`,
        usage,
      });
    }
    return { text, usage };
  });
}

// One provider call, recorded in `calls` whether it succeeds or fails.
function runCall({
  engine,
  page,
  calls,
}: {
  engine: OcrEngine;
  page: PageInput;
  calls: CallRecord[];
}): Effect.Effect<
  EngineSuccess,
  ProviderError,
  Ollama | AnthropicGateway | WallClock
> {
  return Effect.gen(function* () {
    const clock = yield* WallClock;
    const model = MODEL_OF[engine];
    const startedAt = clock.now();
    const record = ({
      usage,
      errorType,
    }: {
      usage: Usage | null;
      errorType: string | null;
    }) => {
      calls.push({
        engine,
        model,
        status: errorType ? "error" : "ok",
        ms: clock.now() - startedAt,
        input_tokens: usage?.inputTokens ?? null,
        output_tokens: usage?.outputTokens ?? null,
        cost_usd: callCost({
          model,
          inputTokens: usage?.inputTokens ?? null,
          outputTokens: usage?.outputTokens ?? null,
        }),
        error_type: errorType,
      });
    };
    const call: Effect.Effect<
      EngineOutput,
      ProviderError,
      Ollama | AnthropicGateway
    > = engine === "inkling" ? runInkling(page) : runClaude(page);
    const output = yield* call.pipe(
      Effect.tapError((error) =>
        Effect.sync(() =>
          record({ usage: usageOf(error), errorType: error._tag }),
        ),
      ),
    );
    record({ usage: output.usage, errorType: null });
    return { ...output, model };
  });
}

// The failure that sends a page to the other engine: a transient error, or
// Inkling's cut-off when Inkling ran first. Terminal errors (a bad request, an
// empty response) don't fall back: the other provider wouldn't fare better and
// the masking would hide a real bug.
function fallbackTrigger({
  primary,
  error,
}: {
  primary: OcrEngine;
  error: ProviderError;
}): TransientError | InklingCutOff | null {
  if (primary === "inkling" && error._tag === "InklingCutOff") return error;
  return isTransient(error) ? error : null;
}

export function runWithFallback({
  primary,
  page,
  calls,
}: {
  primary: OcrEngine;
  page: PageInput;
  calls: CallRecord[];
}): Effect.Effect<
  EngineSuccess,
  ProviderError,
  Ollama | AnthropicGateway | WallClock
> {
  const secondary: OcrEngine = primary === "inkling" ? "claude" : "inkling";
  return runCall({ engine: primary, page, calls }).pipe(
    Effect.catch((error) => {
      const trigger = fallbackTrigger({ primary, error });
      if (!trigger) return Effect.fail(error);
      const reason = fallbackReason(trigger);
      return Effect.logWarning(
        `${primary} failed, falling back to ${secondary}`,
      ).pipe(
        Effect.annotateLogs({ fallback_reason: reason }),
        Effect.andThen(runCall({ engine: secondary, page, calls })),
        // A cut-off page can't be kept, but the primary failed transiently, so
        // re-queue on that error rather than fail the page.
        Effect.mapError((fallbackError) =>
          fallbackError._tag === "InklingCutOff" ? error : fallbackError,
        ),
      );
    }),
  );
}

// Native encoder: ~35x less CPU than a JS loop + btoa (≈0.4 ms vs ≈14 ms for
// a 450 KB scan), which matters on the free plan's 10 ms CPU budget.
function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    "base64",
  );
}

function lazy<T>(compute: () => T): () => T {
  let value: { v: T } | null = null;
  return () => {
    value ??= { v: compute() };
    return value.v;
  };
}

// Long enough for a slow provider call plus retries inside one run.
const SCAN_LINK_TTL_SECONDS = 15 * 60;

export interface TranscribeJob {
  fileId: string;
  trigger: OcrTrigger | null;
  deliveryAttempt: number;
}

export interface RunOutcome {
  status: RunStatus;
  error: OcrError | null;
}

type Attempt =
  | { ok: true; output: EngineSuccess }
  | { ok: false; error: OcrError };

// Transcribe the page and record the run. Never fails on a provider or page
// problem: those come back as the outcome ('failed', or 'requeued' for a
// transient error) with the page and run already written. Fails only when D1
// or R2 can't record the outcome.
export function transcribe(
  job: TranscribeJob,
): Effect.Effect<
  RunOutcome,
  StorageError,
  | Database
  | Bucket
  | Ollama
  | AnthropicGateway
  | WallClock
  | PageIndexer
  | ScanLinks
> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const bucket = yield* Bucket;
    const clock = yield* WallClock;
    const startedAt = clock.now();

    const row = yield* db.first<FileRow>(
      statement(
        `SELECT f.file_id, f.book_id, f.r2_key, f.text_key, b.ocr_instructions, b.ocr_engine
           FROM files f
           JOIN books b ON b.id = f.book_id
          WHERE f.file_id = ?`,
        [job.fileId],
      ),
    );
    if (!row) {
      return {
        status: "failed",
        error: new FileNotFound({ fileId: job.fileId }),
      };
    }

    const bookInstructions = row.ocr_instructions?.trim() || null;
    const prompts = yield* promptVersions(bookInstructions);
    const primary = row.ocr_engine ?? "inkling";
    const calls: CallRecord[] = [];

    const attempt: Attempt = yield* Effect.gen(function* () {
      const scan = yield* bucket.getBytes(row.r2_key);
      if (!scan) return yield* new ObjectMissing({ key: row.r2_key });
      const mimeType = scan.contentType ?? "image/jpeg";
      if (!mimeType.startsWith("image/")) {
        return yield* new NotAnImage({ contentType: mimeType });
      }
      const scanLinks = yield* ScanLinks;
      const imageUrl = yield* scanLinks.urlFor({
        fileId: job.fileId,
        ttlSeconds: SCAN_LINK_TTL_SECONDS,
      });
      return yield* runWithFallback({
        primary,
        calls,
        page: {
          mimeType,
          base64: lazy(() => toBase64(scan.bytes)),
          imageUrl,
          systemPrompt: buildSystemPrompt(bookInstructions),
        },
      });
    }).pipe(
      Effect.map((output): Attempt => ({ ok: true, output })),
      Effect.catch((error: OcrError) =>
        Effect.succeed<Attempt>({ ok: false, error }),
      ),
    );

    const run = {
      fileId: job.fileId,
      bookId: row.book_id,
      createdAt: startedAt,
      trigger: job.trigger,
      primaryEngine: primary,
      deliveryAttempt: job.deliveryAttempt,
      calls,
      systemPromptHash: prompts.system.hash,
      bookInstructionsHash: prompts.book?.hash ?? null,
    };
    const promptInserts = [prompts.system, prompts.book]
      .filter((p): p is PromptVersion => p !== null)
      .map((prompt) => insertPromptVersion({ prompt, seenAt: startedAt }));

    const outcome: RunOutcome & { finalModel: string | null } = attempt.ok
      ? yield* storeTranscription({
          row,
          output: attempt.output,
          promptInserts,
          run,
        })
      : yield* storeFailure({ row, error: attempt.error, promptInserts, run });

    const totals = runTotals(calls);
    const fellBackFor = fallbackReasonOf(calls);
    yield* Effect.logInfo(`ocr run ${outcome.status}`).pipe(
      Effect.annotateLogs({
        book_id: row.book_id,
        ocr: {
          status: outcome.status,
          engine: primary,
          final_model: outcome.finalModel,
          fell_back: fellBackFor !== null,
          fallback_reason: fellBackFor,
          calls: calls.length,
          tokens: { input: totals.inputTokens, output: totals.outputTokens },
          cost_usd: totals.costUsd,
          wasted_cost_usd: totals.wastedCostUsd,
          latency_ms: totals.latencyMs,
          error_type: outcome.error?._tag ?? null,
        },
      }),
    );
    return { status: outcome.status, error: outcome.error };
  });
}

interface RunBase {
  fileId: string;
  bookId: string;
  createdAt: number;
  trigger: OcrTrigger | null;
  primaryEngine: OcrEngine;
  deliveryAttempt: number;
  calls: CallRecord[];
  systemPromptHash: string;
  bookInstructionsHash: string | null;
}

function storeTranscription({
  row,
  output,
  promptInserts,
  run,
}: {
  row: FileRow;
  output: EngineSuccess;
  promptInserts: Statement[];
  run: RunBase;
}) {
  return Effect.gen(function* () {
    const db = yield* Database;
    const bucket = yield* Bucket;
    const clock = yield* WallClock;
    const indexer = yield* PageIndexer;

    const text = output.text.trim() === BLANK_MARKER ? "" : output.text;
    const statements: Statement[] = [];

    // Keep the text this run replaces (a re-OCR), so it can be read back.
    if (row.text_key) {
      const previous = yield* bucket.getText(row.text_key);
      if (previous !== null && previous !== text) {
        const at = clock.now();
        const prevKey = historyKey({
          bookId: row.book_id,
          fileId: row.file_id,
          at,
        });
        yield* bucket.putText({ key: prevKey, text: previous });
        statements.push(
          statement(
            `INSERT INTO text_revisions (file_id, book_id, change, model, note, prev_key, created_at)
             VALUES (?, ?, 'ocr', ?, NULL, ?, ?)`,
            [row.file_id, row.book_id, output.model, prevKey, at],
          ),
        );
      }
    }

    const textKey = `books/${row.book_id}/text/${row.file_id}.md`;
    const runKey = runTextKey({
      bookId: row.book_id,
      fileId: row.file_id,
      at: run.createdAt,
    });
    // The run copy is new and the revision copy is extra, so both are safe to
    // write before the batch. The page's own text is overwritten only after
    // the batch commits: if the batch fails, the page keeps its current text
    // and history (a hand edit is never replaced without its revision row).
    yield* bucket.putText({ key: runKey, text });

    statements.push(
      statement(
        "UPDATE files SET state = 'done', text_key = ?, preview = ?, input_tokens = ?, output_tokens = ?, ocr_model = ?, error = NULL, text_edited_at = NULL, updated_at = ? WHERE file_id = ?",
        [
          textKey,
          text.slice(0, 120),
          output.usage.inputTokens,
          output.usage.outputTokens,
          output.model,
          clock.now(),
          row.file_id,
        ],
      ),
      ...promptInserts,
      // A page whose OCR message had died is resolved by this success
      // (a no-op unless such a row exists).
      resolveFailure({ kind: "ocr", fileId: row.file_id, at: clock.now() }),
      // A page with text, in an opted-in book, waits for the Opus review.
      ...(text
        ? [
            enqueueReview({
              fileId: row.file_id,
              bookId: row.book_id,
              at: clock.now(),
            }),
          ]
        : []),
      insertOcrRun({
        ...run,
        status: "done",
        errorType: null,
        errorMessage: null,
        finalModel: output.model,
        textKey: runKey,
        measurement: measurePage(text),
      }),
      ...ocrSpend({
        bookId: row.book_id,
        at: run.createdAt,
        calls: run.calls,
        storedModel: output.model,
      }),
    );
    yield* db.batch(statements);
    yield* bucket.putText({ key: textKey, text });
    yield* indexer.index({ fileId: row.file_id, text });

    return {
      status: "done" as const,
      error: null,
      finalModel: output.model,
    };
  });
}

// Transient errors are not the page's fault: set 'rate_limited' and let the
// queue re-deliver with backoff. Anything else fails the page for good; re-run
// it via POST .../ocr.
//
// A transient failure on the last delivery Cloudflare allows (max_retries in
// wrangler.jsonc) is still recorded as 'requeued', although the message is
// then dropped and the page stays 'rate_limited' (as before this history
// existed). The consumer can't see max_retries, so it can't tell the last
// delivery apart.
function storeFailure({
  row,
  error,
  promptInserts,
  run,
}: {
  row: FileRow;
  error: OcrError;
  promptInserts: Statement[];
  run: RunBase;
}) {
  return Effect.gen(function* () {
    const db = yield* Database;
    const clock = yield* WallClock;
    const status: RunStatus = isTransient(error) ? "requeued" : "failed";
    const message = error.message;
    yield* db.batch([
      status === "requeued"
        ? statement(
            "UPDATE files SET state = 'rate_limited', error = ?, updated_at = ? WHERE file_id = ?",
            [message.slice(0, 500), clock.now(), row.file_id],
          )
        : statement(
            "UPDATE files SET state = 'failed', error = ?, updated_at = ? WHERE file_id = ?",
            [message, clock.now(), row.file_id],
          ),
      ...promptInserts,
      insertOcrRun({
        ...run,
        status,
        errorType: error._tag,
        errorMessage: message,
        finalModel: null,
        textKey: null,
        measurement: null,
      }),
      ...ocrSpend({
        bookId: row.book_id,
        at: run.createdAt,
        calls: run.calls,
        storedModel: null,
      }),
    ]);
    return { status, error, finalModel: null };
  });
}
