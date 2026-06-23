#!/usr/bin/env node
// One-time (idempotent) bootstrap of the `books` index on a running Meilisearch
// instance: index settings + the Cloudflare Workers AI embedder for hybrid
// search. Re-run any time settings change (Meili applies them as async tasks).
//
// Run:
//   MEILI_URL=https://arabic-digitization-search.fly.dev \
//   MEILI_MASTER_KEY=... \
//   CF_ACCOUNT_ID=... \
//   CF_AI_TOKEN=...        # Cloudflare token with Workers AI: Read
//   node infra/meili/setup-index.mjs
//
// Notes:
// - charabia (Meili's tokenizer) normalizes Arabic itself (diacritics, tatweel,
//   alef folding) for the lexical half — no manual normalization needed.
// - The embedder calls Workers AI at index AND query time; embeddings live in
//   Meili's own vector store (arroy). No external vector DB.

const required = [
  "MEILI_URL",
  "MEILI_MASTER_KEY",
  "CF_ACCOUNT_ID",
  "CF_AI_TOKEN",
];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing env: ${missing.join(", ")}`);
  process.exit(1);
}

const MEILI_URL = process.env.MEILI_URL.replace(/\/$/, "");
const { MEILI_MASTER_KEY, CF_ACCOUNT_ID, CF_AI_TOKEN } = process.env;
const INDEX = "books";
const EMBEDDER = "cfbge";
const EMBED_DIMENSIONS = 1024; // @cf/baai/bge-m3

async function meili({ method, path, body }) {
  const res = await fetch(`${MEILI_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${MEILI_MASTER_KEY}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `${method} ${path} -> ${res.status}: ${JSON.stringify(json)}`,
    );
  }
  return json;
}

async function main() {
  // Create the index (ignore "index already exists").
  try {
    const task = await meili({
      method: "POST",
      path: "/indexes",
      body: { uid: INDEX, primaryKey: "id" },
    });
    console.log(`create index task ${task.taskUid}`);
  } catch (err) {
    if (!String(err).includes("index_already_exists")) throw err;
    console.log("index already exists");
  }

  // Embedder: Cloudflare Workers AI bge-m3 over the REST source. Meili posts
  // {text:[...]} and reads vectors from response.result.data.
  const settings = {
    searchableAttributes: ["text", "book_title"],
    filterableAttributes: ["book_id", "role", "page_number"],
    sortableAttributes: ["page_number"],
    embedders: {
      [EMBEDDER]: {
        source: "rest",
        url: `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/@cf/baai/bge-m3`,
        apiKey: CF_AI_TOKEN,
        dimensions: EMBED_DIMENSIONS,
        request: { text: ["{{text}}", "{{..}}"] },
        response: { result: { data: ["{{embedding}}", "{{..}}"] } },
        documentTemplate: "{{doc.text}}",
      },
    },
  };

  const task = await meili({
    method: "PATCH",
    path: `/indexes/${INDEX}/settings`,
    body: settings,
  });
  console.log(`settings task ${task.taskUid} enqueued`);
  console.log(
    `Watch: curl -H "Authorization: Bearer <key>" ${MEILI_URL}/tasks/${task.taskUid}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
