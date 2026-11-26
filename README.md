# Arabic Book Digitization

A Cloudflare Worker that turns scanned pages of classical Arabic books into clean Markdown. You upload page images; they are OCR'd by Inkling, with Claude as the fallback (preserving tashkeel, section headings, footnotes, and interlinear glosses) and the text is retrievable per-page or in bulk for assembly into your notes.

Built on [Effect](https://effect.website) HttpApi: the endpoints, their schemas and the OpenAPI spec (`/openapi.json`) come from one definition. Single-user: the whole API is gated by one shared master key — there are no accounts.

## How it works

```
upload image ──▶ R2 (scan)         enqueue {fileId}
                 D1 row (queued) ──────────────▶ Queue ──▶ consumer ──▶ Inkling OCR
                                                                          │
                          text/<fileId>.md ◀── R2  ◀───────── writes ─────┘
                                                  D1 row → done
```

- **R2** (`BUCKET`) stores both the uploaded scans (`books/<bookId>/scans/<fileId>`) and the transcribed Markdown (`books/<bookId>/text/<fileId>.md`). Each earlier version of a page's text, saved whenever a hand edit or re-OCR replaces it, is under `books/<bookId>/text-history/<fileId>/` and listed in D1's `text_revisions`.
- **D1** (`DB`) stores metadata only: `books` and a flat `files` table. A "page" is **not** a stored entity — files carry a `page_number`, and you group/stitch them at assembly time (locally).
- **Queue** (`OCR_Q`, `arabic-ocr`) decouples OCR from the upload request. Uploading a file enqueues it; the consumer (`src/queue.ts`) runs the transcription off the request path, with retries.
- **OCR** (`src/ocr.ts`) calls Inkling (`inkling-2-small`) directly on Ollama Cloud, with thinking set to `low`, the cheapest stable setting. Claude (`claude-sonnet-5-5`, through the Cloudflare AI Gateway) is the fallback when Inkling is rate-limited, down, or cuts a page off at its length cap; a book's `ocr_engine` can flip the order. Search highlighting (`src/lib/highlight.ts`) uses Claude Haiku (`claude-haiku-5-5`) through the same gateway. The Worker holds the Ollama key and the gateway token; the Anthropic key lives in the gateway.

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
| GET | `/api/books/:bookId/export` | All files + transcription text, for local assembly; `?limit=<1-200>[&cursor=<next_cursor>]` returns one batch with `files_total` and `next_cursor` (null on the last batch) |
| POST | `/api/books/:bookId/files?page=<n>` | Upload a page (raw image body); auto-enqueues OCR |
| POST | `/api/books/:bookId/files/:fileId/ocr` | Re-run OCR on one file (synchronous) |
| GET | `/api/books/:bookId/files/:fileId/text` | One file's transcription (raw `text/markdown`); `?rev=<id>` for an earlier version |
| PATCH | `/api/books/:bookId/files/:fileId/text` | Hand-edit a transcription with exact find-and-replace edits (`{edits: [{old, new}], note?}`) |
| GET | `/api/books/:bookId/files/:fileId/text/history` | Every change to a page's text (hand edits and re-OCRs), newest first |
| PATCH | `/api/books/:bookId` | Update a book (`{title?, ocr_instructions?, ocr_engine?, review_enabled?, review_effort?}`); `review_enabled` switches the Opus review on or off |
| POST | `/api/books/:bookId/review` | Queue the book's done pages for the Opus review: no body adds the pages done before review was turned on; `{all: true}` re-reviews every done page, even with review off. Returns `{queued, skipped_hand_edited, already_queued}` |
| POST | `/api/books/:bookId/files/:fileId/review` | Review one page now (even with the book's review off), starting a review run if none is running. 409 if the page isn't done or is hand-edited |
| GET | `/api/books/:bookId/files/:fileId/reviews` | A page's Opus reviews, newest first, with each edit and whether it applied |
| GET | `/api/reviews/summary` | Review totals (`?days=<1-90>&book=<bookId>`): pages, edits by category, cost per page, batch timing |
| GET | `/api/spend` | OCR vs review cost (`?days=<1-90>&book=<bookId>`): by model, daily, top books |
| GET | `/api/jobs` | Running work: OCR per book, review batches, messages that ran out of retries. Refresh on demand; don't poll |
| POST | `/api/search/reindex` | Rebuild the search index from R2 (`{bookId?}`) |

**Hand edits and history.** Every change to a page's text, whether a hand edit (`PATCH …/text`) or a re-OCR, first saves the text it replaces; `…/text/history` lists the changes and `…/text?rev=<id>` reads an earlier version back. Re-OCR is not blocked by hand edits: re-running a page, or requeueing a book with `states: ["done"]`, overwrites hand-fixed pages (their edited text stays in history). `text_edited_at` in the status rows marks pages with hand edits, so check it before re-OCRing finished pages. Details and the restore recipe are in `/llms.txt`.

**Opus review.** A book with review on gets each page proofread by Claude Opus against the scan after OCR, through the Message Batches API (a batch every 3 hours, roughly $0.03 a page). Applied edits are one `review` entry in the page's history, so they can be undone. A review never touches a hand-edited page. It costs money: estimate with `cost_per_page_usd` from `/api/reviews/summary` before queueing a whole book.

Search *queries* don't go through the Worker — clients query Meilisearch
directly with a read-only key (see `infra/meili`). The Worker only *writes* to
the index (auto-index on OCR + the reindex above).

Upload accepts `image/jpeg`, `image/png`, `image/webp`. Anything else, including PDF, gets a 415: neither OCR provider reads PDFs, so export each page as an image first. `?page` is optional — supply it when the printed page number isn't legible in the shot.

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
- `OLLAMA_API_KEY` — Ollama Cloud key for Inkling OCR.
- `CF_AIG_TOKEN` — Cloudflare AI Gateway token (`cf-aig-authorization`) for Claude: the OCR fallback and search highlighting. The Anthropic key itself is stored in the gateway.
- `MEILI_KEY` — Meilisearch **write** key (`documents.add`) for the Worker's indexing (only needed once search is set up; see `infra/meili`). Not the master key. Clients use a separate **read-only** search key, which never touches the Worker.

`MEILI_URL` is a non-secret var in `wrangler.jsonc` (the Meilisearch instance URL).

**Command line:** the `corpus` CLI keeps the API URL/key and the Meilisearch URL/read-only key in the OS keychain (or reads them from env vars); see [Command line](#command-line-corpus).

**Local** (`wrangler dev`): put the secrets in `.dev.vars` (gitignored; see `.dev.vars.example`).
**Production**: `pnpm wrangler secret put <NAME>` for each. These are separate stores — keep them in sync manually if you rotate.

## Command line (`corpus`)

`corpus` (`packages/cli`) manages books, OCR, edits, review, spend and search from a terminal, for you and for agents. Each `v*` release ships it as a standalone binary for Linux, macOS and Windows:

```sh
curl -fsSL https://github.com/Shunseii/arabic-digitization/releases/latest/download/install.sh | sh      # Linux / macOS
irm https://github.com/Shunseii/arabic-digitization/releases/latest/download/install.ps1 | iex            # Windows (PowerShell)
corpus auth login     # store the API URL/key and Meilisearch URL/key in the OS keychain
corpus books
```

Install details, non-interactive auth, env vars, update, uninstall and building from source: [`packages/cli/README.md`](packages/cli/README.md).

## Develop

```bash
pnpm dev          # local Worker at http://localhost:8787 (runs the queue consumer in-process)
pnpm typecheck    # tsc --noEmit
pnpm check        # Biome lint + format (write)
```

Local `wrangler dev` simulates R2/D1/Queue in `.wrangler/state` — uploads and OCR run end-to-end locally (only the OCR and highlight calls leave your machine).

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

### Releasing (desktop + mobile OTA)

Publishing a GitHub release with a version tag runs the **release** workflow
(`.github/workflows/release.yml`):

```bash
gh release create v0.6.0 --title "v0.6.0" --notes "What changed"
```

- **Desktop:** builds the Windows `.exe` and Linux `.deb` / `.AppImage` with
  the tag's version, attaches them to that release, and recreates the rolling
  **`desktop-latest`** release.
- **Mobile:** publishes an over-the-air update to the EAS `preview` channel,
  with the first line of the notes as its message. If native code changed since
  the last release that published an OTA (compared by Expo fingerprint,
  recorded on that release as `mobile-fingerprint.json`), the OTA job fails instead: bump the
  app version, run an EAS build, then release again.
- **Skipped when unchanged:** desktop runs only if `apps/desktop/`,
  `packages/shared/` or the root package files changed since the last release
  that shipped desktop installers; mobile likewise for `apps/mobile/` since the
  last release that published an OTA. The CLI always builds.
- Needs the `EXPO_TOKEN` repository secret. The API deploy and remote D1
  migrations stay manual.

Get the latest desktop installers:

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

- `src/index.ts` — exports `{ fetch, queue }` (HTTP + queue consumer).
- `src/http/` — the HttpApi definition (`app.ts`), auth and validation middleware, error responses.
- `src/endpoints/` — one file per route: its endpoint definition (schemas) and handler.
- `src/ocr.ts` — OCR core (`transcribe()`), the OCR prompt, the Inkling and Claude calls.
- `src/queue.ts` — queue consumer.
- `src/docs.ts` — the `/llms.txt` API reference.
- `migrations/` — D1 schema.
