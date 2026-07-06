# Meilisearch — hybrid search for the Arabic library

Lexical (charabia, Arabic-aware) + vector (bge-m3 via Cloudflare Workers AI) +
hybrid, in one self-hosted Meilisearch instance on Fly.io. The `api` Worker
pushes documents and proxies queries; Meilisearch stores everything (docs,
lexical index, and vectors — no external vector DB).

```
R2 (transcribed text)
  └─ api Worker  ──push pages──►  Meilisearch (Fly)
        ▲                          │  charabia lexical + arroy vectors
        └──── /api/search ─────────┘  embeds via Workers AI bge-m3 (REST embedder)
```

Why Meili over Cloudflare AI Search here: CF only offers `porter`/`trigram`
tokenizers (no Arabic analyzer), so exact-term Arabic search is weak. charabia
normalizes Arabic (diacritics, tatweel, alef folding) natively. We keep CF for
what it's good at — embedding compute (bge-m3) — via Meili's REST embedder.

## Two separate steps — don't conflate them

Bringing this service up (or changing it) is always **two distinct actions**:

1. **`fly deploy`** — runs the **Meilisearch server** itself (the `meilisearch`
   binary + its persistent volume) on Fly. This is the only real "deploy." Use it
   to create the instance, bump the image version, or change `fly.toml`.
2. **`node setup-index.mjs`** — **configures the `books` index** (settings +
   the Cloudflare Workers AI `cfbge` embedder) **inside the already-running
   instance, over HTTP**. It is *not* a deploy and touches no Fly resources — it
   just POSTs settings to Meili. It's idempotent, so re-running is safe.

The embedder's Cloudflare `apiKey` lives **only** in Meili's stored settings
(written by step 2) — never in Fly env/secrets, never in the `meilisearch`
process. `setup-index.mjs` reads `CF_AI_TOKEN` from *its own* shell env (pull it
from 1Password) and writes it into those settings.

**Run `setup-index.mjs` after:** the first deploy · any settings/embedder change
· every Meili version upgrade (a version bump rebuilds the index from scratch —
see "Upgrading"). If you pass a stale `CF_AI_TOKEN` on any of those runs, it
silently overwrites the good key and embedding breaks — which is exactly why the
commands below pull the token from 1Password rather than hardcoding it.

## One-time deploy

Requires the `flyctl` CLI, authenticated (`fly auth login`).

```sh
cd infra/meili

# 1. Create the app + persistent volume (pick your region).
fly apps create arabic-digitization-search
fly volumes create meili_data --region yyz --size 1

# 2. Set the Meilisearch master key (generate a strong random one).
fly secrets set MEILI_MASTER_KEY="$(openssl rand -base64 32)"

# 3. Deploy.
fly deploy
```

Then configure the index + embedder (idempotent; re-run after settings changes):

```sh
# Pull secrets from 1Password so a re-run can't reintroduce a stale token.
# CF_AI_TOKEN in particular is written into Meili's embedder settings; passing
# an expired one here silently breaks embedding until the next reindex fails.
MEILI_URL="$(op read 'op://Arabic Digitization/Meilisearch/url')" \
MEILI_MASTER_KEY="$(op read 'op://Arabic Digitization/Meilisearch/master key')" \
CF_ACCOUNT_ID="$(op read 'op://Arabic Digitization/Cloudflare API Token/Account ID')" \
CF_AI_TOKEN="$(op read 'op://Arabic Digitization/Cloudflare API Token/credential')" \
node setup-index.mjs
```

## Keys

Two distinct secrets:

- **`MEILI_MASTER_KEY`** — you generate it (step 2 above: `openssl rand -base64
  32`) and set it as a Fly secret. Root admin key; required to boot in
  `production`. Store it in 1Password. Never give it to the Worker.
- **`MEILI_KEY`** (Worker **write** key) — used only by the Worker to index
  (auto-index on OCR + reindex). Scope: `documents.add` on `books`.
- **Client read-only key** — shipped to the desktop/mobile clients, which query
  Meilisearch **directly**. Scope: `search` on `books`. Safe to expose; can't
  write or read other indexes.

Mint both from the running instance with the master key (Meili's auto-created
"Default Search" key works as the read-only one too, but a scoped custom key is
cleaner):

```sh
MASTER=<the master key from step 2>
# write key -> Worker MEILI_KEY
curl -X POST https://arabic-digitization-search.fly.dev/keys \
  -H "Authorization: Bearer $MASTER" -H 'Content-Type: application/json' \
  -d '{"description":"api worker (write)","actions":["documents.add"],"indexes":["books"],"expiresAt":null}'
# read-only key -> clients
curl -X POST https://arabic-digitization-search.fly.dev/keys \
  -H "Authorization: Bearer $MASTER" -H 'Content-Type: application/json' \
  -d '{"description":"clients (search)","actions":["search"],"indexes":["books"],"expiresAt":null}'
# each response's "key" field is the value — store both in 1Password
```

### Wire up the api Worker

```sh
cd ../../apps/api
# MEILI_URL is already in wrangler.jsonc vars. Set the WRITE key from above:
wrangler secret put MEILI_KEY    # the documents.add key
wrangler types                   # regenerate Env so MEILI_URL/MEILI_KEY type-check
# the Worker auto-deploys on push to master (Workers Builds); or `pnpm deploy`
```

## Index + query

```sh
# Build/refresh the index from R2 (the source of truth) — via the Worker:
curl -X POST https://<api>/api/search/reindex -H "Authorization: Bearer $MASTER_KEY"

# Search — clients hit Meilisearch DIRECTLY with the read-only key
# (semanticRatio: 0 = keyword only, 1 = semantic only):
curl -X POST https://arabic-digitization-search.fly.dev/indexes/books/search \
  -H "Authorization: Bearer $READONLY_KEY" -H 'Content-Type: application/json' \
  -d '{"q":"أحكام الوضوء","hybrid":{"embedder":"cfbge","semanticRatio":0.5}}'
```

## How indexing works

Two paths keep the `books` index in sync with the transcriptions in R2.

### Automatic (per page, on OCR completion)

When a page finishes OCR, `transcribe()` (`apps/api/src/ocr.ts`) writes the
text to R2, marks the file `done`, then pushes that one page to Meilisearch:

```
upload scan → queue → transcribe() → R2 text + state=done → upsert page to Meili
```

This is **best-effort**: if Meilisearch is down, cold-starting, or `MEILI_URL`/
`MEILI_KEY` aren't configured, the upsert is caught and logged — OCR still
succeeds. The page is safe in R2/D1, and the reindex below re-syncs it. So new
scans become searchable on their own, with no manual step.

### Manual (bulk backfill / repair)

`POST /api/search/reindex` rebuilds the index from R2 (the source of truth):
reads every `done`/`needs_review`/`approved` page's text and upserts it.

```sh
# all books:
curl -X POST https://<api>/api/search/reindex -H "Authorization: Bearer $MASTER_KEY"
# one book:
curl -X POST https://<api>/api/search/reindex -H "Authorization: Bearer $MASTER_KEY" \
  -H "Content-Type: application/json" -d '{"bookId":"nur-al-idah"}'
```

Use it to: backfill pages scanned before search existed, recover anything the
auto-index missed (Meili was asleep/down), or rebuild after a Meili version
upgrade (the index is disposable — see "Upgrading").

## Autostop

`fly.toml` scales the machine to zero when idle; the volume (hence the index)
persists across stop/start. First query after idle pays a ~1-5s cold start.

**Do not let autostop kill a long task.** A bulk reindex or a version migration
runs with no client connections and could be stopped mid-flight. Before either,
temporarily disable autostop:

```sh
fly scale count 1            # keep one machine running
# ... run reindex / upgrade, wait for completion ...
# autostop resumes on next deploy (auto_stop_machines = "stop" in fly.toml)
```

## Upgrading Meilisearch

A Meili database is only compatible with the version that created it — bumping
the image tag alone will not open the old DB. Three options, simplest first:

### A. Reindex from source (recommended)

The index is derived, disposable data (source = R2 + CF embeddings):

```sh
fly volumes snapshot create <volume-id>      # optional safety
# bump the image tag in fly.toml, then:
fly deploy
# Re-apply settings/embedder. Pull CF_AI_TOKEN (+ the rest) from 1Password —
# see the setup-index block above — so the upgrade can't restore a stale key.
CF_ACCOUNT_ID="$(op read 'op://Arabic Digitization/Cloudflare API Token/Account ID')" \
CF_AI_TOKEN="$(op read 'op://Arabic Digitization/Cloudflare API Token/credential')" \
MEILI_URL="$(op read 'op://Arabic Digitization/Meilisearch/url')" \
MEILI_MASTER_KEY="$(op read 'op://Arabic Digitization/Meilisearch/master key')" \
node setup-index.mjs
curl -X POST https://<api>/api/search/reindex -H "Authorization: Bearer $MASTER_KEY"
```

For this corpus that's minutes and ~free. No migration risk.

### B. Dumpless in-place upgrade (≥1.12 → ≥1.13)

1. `fly volumes snapshot create <volume-id>` (still experimental — snapshot first).
2. Bump the image tag AND add `--experimental-dumpless-upgrade` to the start
   command, `fly deploy`. Meili runs an `UpgradeDatabase` task in place; search
   keeps working. Watch `GET /tasks?types=UpgradeDatabase`.
3. Remove the flag on the next deploy. On failure, cancel the task to auto-roll-back.

### C. Dump → import

For large version jumps where dumpless isn't supported: create a dump on the old
version, launch the new version with `--import-dump`.

Check Meili's version-specific upgrade warnings when skipping multiple majors.
