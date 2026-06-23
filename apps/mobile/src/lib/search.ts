import { instantMeiliSearch } from "@meilisearch/instant-meilisearch";

// Clients query Meilisearch directly with a read-only key. Hybrid (lexical +
// vector) is baked into every query here, so the search UI stays a plain
// InstantSearch app.
export const SEARCH_INDEX = "books";
const EMBEDDER = "cfbge";
const SEMANTIC_RATIO = 0.5;

export type SearchHit = {
  id: string;
  book_id: string;
  book_title: string;
  page_number: number | null;
  text: string;
  _formatted?: { text?: string };
};

export const makeSearchClient = (config: { url: string; key: string }) =>
  instantMeiliSearch(config.url, config.key, {
    primaryKey: "id",
    meiliSearchParams: {
      hybrid: { embedder: EMBEDDER, semanticRatio: SEMANTIC_RATIO },
      attributesToCrop: ["text"],
      cropLength: 40,
    },
  }).searchClient;

// Meilisearch wraps matches in these markers (instant-meilisearch defaults).
// Strip them for plain RN text rendering.
export const stripHighlight = (s: string): string =>
  s.replace(/<\/?(ais-highlight|em)>|__\/?ais-highlight__/g, "");
