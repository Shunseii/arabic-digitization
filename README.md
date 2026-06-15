# Arabic Book Digitization

A Cloudflare Worker that turns scanned pages of classical Arabic books into clean Markdown. You upload page images; they are OCR'd by Gemini (preserving tashkeel, section headings, footnotes, and interlinear glosses) and the text is retrievable per-page or in bulk for assembly into your notes.

Built on [Hono](https://hono.dev) + [chanfana](https://chanfana.pages.dev) (OpenAPI). Single-user: the whole API is gated by one shared master key — there are no accounts.

## How it works

```
upload image ──▶ R2 (scan)         enqueue {fileId}
                 D1 row (queued) ──────────────▶ Queue ──▶ consumer ──▶ Gemini OCR
                                                                          │
                          text/<fileId>.md ◀── R2  ◀───────── writes ─────┘
                                                  D1 row → done
```

- **R2** (`BUCKET`) stores both the uploaded scans (`books/<bookId>/scans/<fileId>`) and the transcribed Markdown (`books/<bookId>/text/<fileId>.md`).
- **D1** (`DB`) stores metadata only: `books` and a flat `files` table. A "page" is **not** a stored entity — files carry a `page_number`, and you group/stitch them at assembly time (locally).
- **Queue** (`OCR_Q`, `arabic-ocr`) decouples OCR from the upload request. Uploading a file enqueues it; the consumer (`src/queue.ts`) runs the transcription off the request path, with retries.
- **OCR** (`src/ocr.ts`) calls Google AI Studio directly (`gemini-3.1-pro-preview`, thinking set to `low` since transcription needs little reasoning and high thinking is the main cost driver). The Worker holds only the Google API key.

File state machine: `queued → processing → done` (or `failed` after retries; `needs_review` / `approved` reserved for a future review step).

### Output Markdown conventions

The OCR prompt produces a consistent structure (see `SYSTEM_PROMPT` in `src/ocr.ts`):

- Running page header (topic + page number) as the first line, then a blank line, then `---`, then the body.
- Section/chapter titles (كتاب / باب / فصل …) as `##` / `###` headings.
- Bottom footnotes (حاشية) after the body under a `### الحاشية` divider.
- Interlinear glosses (small text written between the lines) as `<ruby>span<rt>gloss</rt></ruby>`, attached to the word/phrase they sit above.
- Tashkeel preserved as printed.

## API

Every `/api/*` request needs `Authorization: Bearer <MASTER_KEY>`. Full, always-current reference for tools/agents: **`GET /llms.txt`** (public). Human Swagger UI at `/`.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/books` | Create a book (`{title, id?}`) |
| GET | `/api/books` | List books with per-state counts |
| GET | `/api/books/:bookId` | Book + status summary |
| GET | `/api/books/:bookId/status` | Per-file states (poll the pipeline) |
| GET | `/api/books/:bookId/export` | All files + transcription text, for local assembly |
| POST | `/api/books/:bookId/files?page=<n>` | Upload a page (raw image/PDF body); auto-enqueues OCR |
| POST | `/api/books/:bookId/files/:fileId/ocr` | Re-run OCR on one file (synchronous) |
| GET | `/api/books/:bookId/files/:fileId/text` | One file's transcription (raw `text/markdown`) |

Upload accepts `image/jpeg`, `image/png`, `image/webp`, `application/pdf`. `?page` is optional — supply it when the printed page number isn't legible in the shot.

## Setup

```bash
pnpm install
pnpm wrangler login
```

Provision the bound resources (one-time; names match `wrangler.jsonc`):

```bash
pnpm wrangler d1 create arabic-digitization      # paste database_id into wrangler.jsonc
pnpm wrangler d1 migrations apply arabic-digitization --remote
pnpm wrangler r2 bucket create arabic-digitization
pnpm wrangler queues create arabic-ocr
```

## Secrets

Two secrets, never committed:

- `MASTER_KEY` — the bearer token gating the API. Generate with `openssl rand -hex 32`.
- `GOOGLE_API_KEY` — Google AI Studio key for Gemini.

**Local** (`wrangler dev`): put both in `.dev.vars` (gitignored; see `.dev.vars.example`).
**Production**: `pnpm wrangler secret put MASTER_KEY` and `pnpm wrangler secret put GOOGLE_API_KEY`. These are separate stores — keep them in sync manually if you rotate.

## Develop

```bash
pnpm dev          # local Worker at http://localhost:8787 (runs the queue consumer in-process)
pnpm typecheck    # tsc --noEmit
pnpm check        # Biome lint + format (write)
```

Local `wrangler dev` simulates R2/D1/Queue in `.wrangler/state` — uploads and OCR run end-to-end locally (only the Gemini call leaves your machine).

## Deploy

```bash
pnpm wrangler deploy
```

Gives a free `*.workers.dev` URL (no custom domain or paid plan required — Queues are on the free tier). Set the production secrets first (above), or the API returns 500 until `MASTER_KEY` is configured.

## Layout

- `src/index.ts` — router; exports `{ fetch, queue }` (HTTP + queue consumer).
- `src/endpoints/` — one file per route.
- `src/ocr.ts` — OCR core (`transcribe()`), the OCR prompt, the Gemini call.
- `src/queue.ts` — queue consumer.
- `src/middleware/auth.ts` — master-key gate.
- `src/docs.ts` — the `/llms.txt` API reference.
- `migrations/` — D1 schema.
