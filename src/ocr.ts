// OCR core. Single source of truth for transcription — the manual endpoint and
// (later) the queue consumer both call transcribe().
//
// Gemini only, called directly against Google AI Studio with env.GOOGLE_API_KEY.
// (The Cloudflare AI Gateway unified path was dropped: its BYOK wouldn't resolve
// the AI Studio key. To re-introduce the gateway later, route this one fetch
// through it.)

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
const USER_PROMPT = "Transcribe this page.";
const MAX_TOKENS = 16000;

export interface TranscribeOpts {
  env: Env;
  fileId: string;
  model?: string; // bare AI Studio model id; defaults to MODEL
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
  ocr_instructions: string | null;
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
    `SELECT f.file_id, f.book_id, f.r2_key, b.ocr_instructions
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

  const { text, usage } = await runGemini({
    env,
    model: useModel,
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
    "UPDATE files SET state = 'done', text_key = ?, preview = ?, updated_at = ? WHERE file_id = ?",
  )
    .bind(textKey, text.slice(0, 120), now, fileId)
    .run();

  return { file_id: fileId, model: useModel, text, text_key: textKey, usage };
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
}): Promise<{ text: string; usage: unknown }> {
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
    throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: unknown;
  };
  const text = (data.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("");
  if (!text) {
    throw new Error(
      `no text in Gemini response: ${JSON.stringify(data).slice(0, 400)}`,
    );
  }
  return { text, usage: data.usageMetadata };
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
