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
| POST | `/api/search/reindex` | Rebuild the search index from R2 (`{bookId?}`) |

Search *queries* don't go through the Worker — clients query Meilisearch
directly with a read-only key (see `infra/meili`). The Worker only *writes* to
the index (auto-index on OCR + the reindex above).

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

Secrets, never committed:

- `MASTER_KEY` — the bearer token gating the API. Generate with `openssl rand -hex 32`.
- `GOOGLE_API_KEY` — Google AI Studio key for Gemini.
- `MEILI_KEY` — Meilisearch **write** key (`documents.add`) for the Worker's indexing (only needed once search is set up; see `infra/meili`). Not the master key. Clients use a separate **read-only** search key, which never touches the Worker.

`MEILI_URL` is a non-secret var in `wrangler.jsonc` (the Meilisearch instance URL).

**Local** (`wrangler dev`): put the secrets in `.dev.vars` (gitignored; see `.dev.vars.example`).
**Production**: `pnpm wrangler secret put <NAME>` for each. These are separate stores — keep them in sync manually if you rotate.

## Develop

```bash
pnpm dev          # local Worker at http://localhost:8787 (runs the queue consumer in-process)
pnpm typecheck    # tsc --noEmit
pnpm check        # Biome lint + format (write)
```

Local `wrangler dev` simulates R2/D1/Queue in `.wrangler/state` — uploads and OCR run end-to-end locally (only the Gemini call leaves your machine).

## Deploy

This is a monorepo with three deployables: the **API** (Cloudflare Worker), the
**mobile** app (Expo/EAS), and the **desktop** app (Electron). All commands run
from the repo root unless noted.

### API (Cloudflare Worker)

Auto-deploys on push to `master` via Cloudflare's Git integration (Workers
Builds) — merging to `master` ships the Worker, including any change under
`apps/api/`. For a manual/local deploy:

```bash
pnpm deploy        # = pnpm --filter @qiraa/api deploy = wrangler deploy
```

Runs on a free `*.workers.dev` URL (no custom domain or paid plan required —
Queues are on the free tier). Production secrets must be set in Cloudflare
first (see Secrets above) — the API returns 500 until `MASTER_KEY` is
configured, and search depends on `MEILI_KEY`/`MEILI_URL`.

### Search (Meilisearch)

Search (`GET /api/search`, auto-indexing on OCR, `POST /api/search/reindex`)
needs a running Meilisearch instance. Unlike the Worker, Meilisearch is **not**
auto-deployed — it's a separate, stateful service on Fly.io that you deploy
**manually** (long-lived volume; you don't want a push restarting the DB).
Full deploy + upgrade + indexing docs in
[`infra/meili/README.md`](infra/meili/README.md). In short:

```bash
# 1. deploy the instance (one-time; see infra/meili/README.md for full steps)
cd infra/meili && fly deploy -c fly.toml -a <app> --ha=false
node setup-index.mjs            # configure index + Workers AI embedder

# 2. mint two scoped keys via Meili /keys (see infra/meili/README.md):
#      - write key (documents.add) → the Worker's MEILI_KEY
#      - read-only key (search)     → the clients
pnpm wrangler secret put MEILI_KEY    # the WRITE key; push to master to deploy
#    ship the read-only key + MEILI_URL to the desktop/mobile clients

# 3. backfill existing scans (new scans auto-index on OCR going forward)
curl -X POST https://<api>/api/search/reindex -H "Authorization: Bearer $MASTER_KEY"
```

### Mobile (Expo / EAS)

Cloud builds on EAS (profiles in `apps/mobile/eas.json`). Run from `apps/mobile`:

```bash
cd apps/mobile
eas build --profile preview    --platform android   # internal-distribution APK
eas build --profile production --platform android   # store build, auto-increments
```

`--no-wait` queues without blocking. The build page (printed on launch, or
`eas build:list`) has the installable APK / store artifact. First run needs
`eas login`; Android credentials (keystore) are managed on the Expo server.

### Desktop (Electron)

Released by hand from the **desktop-release** workflow
(`.github/workflows/desktop-release.yml`): Actions tab → *desktop-release* →
**Run workflow**, pick a semver `bump` (patch/minor/major) and write the
**release notes** (required). CI bumps the version in `apps/desktop/package.json`,
commits it back to `master`, builds the Windows `.exe` and Linux `.deb` /
`.AppImage` with electron-builder, and publishes them to an immutable
**`desktop-v<X.Y.Z>`** release plus the rolling **`desktop-latest`** pointer.
Full steps: `apps/desktop/README.md`. Get the latest installers:

```bash
gh release download desktop-latest --pattern '*.deb' --dir ~/Downloads --clobber
```

Build installers locally instead (output in `apps/desktop/release/`):

```bash
pnpm desktop:build        # = pnpm --filter @qiraa/desktop desktop:build
```

The desktop app calls the API with the renderer's native fetch, so the Worker's
CORS headers (above) must be deployed for it to connect. More detail:
`apps/desktop/README.md`.

## Layout

- `src/index.ts` — router; exports `{ fetch, queue }` (HTTP + queue consumer).
- `src/endpoints/` — one file per route.
- `src/ocr.ts` — OCR core (`transcribe()`), the OCR prompt, the Gemini call.
- `src/queue.ts` — queue consumer.
- `src/middleware/auth.ts` — master-key gate.
- `src/docs.ts` — the `/llms.txt` API reference.
- `migrations/` — D1 schema.
