// OCR core. Single source of truth for transcription — the manual endpoint and
// (later) the queue consumer both call transcribe().
//
// All providers go through one Cloudflare AI Gateway endpoint (the unified
// /ai/run) with BYOK: provider keys live in Cloudflare (Secrets Store), so the
// Worker holds only the CF API token. Model is "provider/model"; the per-provider
// `input` body is still that provider's native shape (built below).

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

const DEFAULT_MODEL = "google/gemini-3.1-pro-preview";
const USER_PROMPT = "Transcribe this page.";
const MAX_TOKENS = 16000;

export interface TranscribeOpts {
  env: Env;
  fileId: string;
  model?: string;
}

export interface TranscribeResult {
  file_id: string;
  model: string;
  text: string;
  text_key: string;
  usage: unknown;
}

interface FileRow {
  file_id: string;
  book_id: string;
  r2_key: string;
}

// Build the provider-native `input` body (sans model) including the image.
type InputBuilder = (base64: string, mimeType: string) => unknown;

const INPUT_BUILDERS: Record<string, InputBuilder> = {
  anthropic: (base64, mimeType) => {
    const source = { type: "base64", media_type: mimeType, data: base64 };
    const fileBlock =
      mimeType === "application/pdf"
        ? { type: "document", source }
        : { type: "image", source };
    return {
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [fileBlock, { type: "text", text: USER_PROMPT }],
        },
      ],
    };
  },
  google: (base64, mimeType) => ({
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType, data: base64 } },
          { text: USER_PROMPT },
        ],
      },
    ],
    // 3.1 Pro is thinking-mandatory (budget 0 is rejected); "low" is the floor.
    generationConfig: {
      maxOutputTokens: MAX_TOKENS,
      thinkingConfig: { thinkingLevel: "low" },
    },
  }),
};

export async function transcribe({
  env,
  fileId,
  model,
}: TranscribeOpts): Promise<TranscribeResult> {
  const spec = model ?? DEFAULT_MODEL;
  const provider = spec.split("/")[0] ?? "";
  const buildInput = INPUT_BUILDERS[provider];
  if (!buildInput) {
    throw new Error(
      `model must be "provider/model" with a known provider (${Object.keys(INPUT_BUILDERS).join(", ")}); got '${spec}'`,
    );
  }

  const row = await env.DB.prepare(
    "SELECT file_id, book_id, r2_key FROM files WHERE file_id = ?",
  )
    .bind(fileId)
    .first<FileRow>();
  if (!row) throw new Error(`file '${fileId}' not found`);

  const obj = await env.BUCKET.get(row.r2_key);
  if (!obj) throw new Error(`R2 object '${row.r2_key}' missing`);

  const mimeType = obj.httpMetadata?.contentType ?? "image/jpeg";
  const base64 = toBase64(new Uint8Array(await obj.arrayBuffer()));

  const input = buildInput(base64, mimeType);
  // Google goes direct to AI Studio (the gateway's unified BYOK path doesn't
  // resolve the AI Studio key yet); Anthropic goes through the gateway (BYOK).
  const { text, usage } =
    provider === "google"
      ? await runGoogleDirect({
          env,
          modelId: spec.slice("google/".length),
          input,
        })
      : await runGateway({ env, model: spec, input });

  const textKey = `books/${row.book_id}/text/${fileId}.md`;
  await env.BUCKET.put(textKey, text, {
    httpMetadata: { contentType: "text/markdown; charset=utf-8" },
  });

  const now = Date.now();
  await env.DB.prepare(
    "UPDATE files SET state = 'done', text_key = ?, preview = ?, updated_at = ? WHERE file_id = ?",
  )
    .bind(textKey, text.slice(0, 120), now, fileId)
    .run();

  return { file_id: fileId, model: spec, text, text_key: textKey, usage };
}

// One call for every provider: the unified AI Gateway /ai/run endpoint.
// Auth = CF API token; BYOK supplies the provider key server-side.
async function runGateway({
  env,
  model,
  input,
}: {
  env: Env;
  model: string;
  input: unknown;
}): Promise<{ text: string; usage: unknown }> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      "cf-aig-gateway-id": env.CF_AIG_GATEWAY_ID,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model, input }),
  });
  if (!res.ok) {
    throw new Error(`AI Gateway ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return { text: extractText(data), usage: extractUsage(data) };
}

// Google AI Studio direct (BYOK via the gateway isn't resolving the AI Studio
// key; this uses env.GOOGLE_API_KEY directly). modelId is the bare id, e.g.
// "gemini-3.1-pro-preview". input is the native generateContent body.
async function runGoogleDirect({
  env,
  modelId,
  input,
}: {
  env: Env;
  modelId: string;
  input: unknown;
}): Promise<{ text: string; usage: unknown }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "x-goog-api-key": env.GOOGLE_API_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(`Google AI Studio ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return { text: extractText(data), usage: extractUsage(data) };
}

// Defensive response parsing — the unified endpoint may wrap the provider
// response in `.result`, and the inner shape differs per provider. Handle the
// common shapes; if none match we throw so failures are visible, not silent "".
function extractText(payload: unknown): string {
  const root = payload as { result?: unknown };
  const data = (root?.result ?? payload) as Record<string, unknown>;

  // Anthropic: { content: [{ type:"text", text }] }
  const content = data.content as
    | Array<{ type?: string; text?: string }>
    | undefined;
  if (Array.isArray(content)) {
    const t = content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    if (t) return t;
  }

  // Gemini: { candidates: [{ content: { parts: [{ text }] } }] }
  const candidates = data.candidates as
    | Array<{ content?: { parts?: Array<{ text?: string }> } }>
    | undefined;
  const geminiText = candidates?.[0]?.content?.parts
    ?.map((p) => p.text ?? "")
    .join("");
  if (geminiText) return geminiText;

  // OpenAI-style: { choices: [{ message: { content } }] }
  const choices = data.choices as
    | Array<{ message?: { content?: string } }>
    | undefined;
  const openaiText = choices?.[0]?.message?.content;
  if (openaiText) return openaiText;

  if (typeof data.text === "string" && data.text) return data.text;

  throw new Error(
    `could not extract text from gateway response: ${JSON.stringify(payload).slice(0, 400)}`,
  );
}

function extractUsage(payload: unknown): unknown {
  const root = payload as { result?: Record<string, unknown> };
  const data = root?.result ?? (payload as Record<string, unknown>);
  return data?.usage ?? data?.usageMetadata ?? null;
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
