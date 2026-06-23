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
MEILI_URL=https://arabic-digitization-search.fly.dev \
MEILI_MASTER_KEY=<the master key from step 2> \
CF_ACCOUNT_ID=<cloudflare account id> \
CF_AI_TOKEN=<cloudflare token with Workers AI: Read> \
node setup-index.mjs
```

## Wire up the api Worker

```sh
cd ../../apps/api
# MEILI_URL is already in wrangler.jsonc vars. Set the key secret:
wrangler secret put MEILI_KEY    # a Meili API key with search + documents.add
wrangler types                   # regenerate Env so MEILI_URL/MEILI_KEY type-check
wrangler deploy
```

Create a scoped Meili API key (not the master key) for the Worker via the Meili
`/keys` API, with actions `search` + `documents.add` on the `books` index.

## Index + query

```sh
# Build/refresh the index from R2 (the source of truth):
curl -X POST https://<api>/api/search/reindex -H "Authorization: Bearer $MASTER_KEY"

# Search (semanticRatio: 0 = keyword only, 1 = semantic only):
curl "https://<api>/api/search?q=أحكام%20الوضوء&semanticRatio=0.5" \
  -H "Authorization: Bearer $MASTER_KEY"
```

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
node setup-index.mjs                          # re-apply settings/embedder
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
