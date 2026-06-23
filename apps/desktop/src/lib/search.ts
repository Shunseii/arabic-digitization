import { instantMeiliSearch } from "@meilisearch/instant-meilisearch";

// Clients query Meilisearch directly with a read-only key. Hybrid (lexical +
// vector) is baked into every query here, so the search UI stays a plain
// InstantSearch app.
export const SEARCH_INDEX = "books";
const EMBEDDER = "cfbge";
const SEMANTIC_RATIO = 0.5;
// Drop hybrid matches below this ranking score (0-1). Tune to taste.
const SCORE_THRESHOLD = 0.5;

export type SearchHit = {
  id: string;
  book_id: string;
  book_title: string;
  page_number: number | null;
  text: string;
  _formatted?: { text?: string };
};

// react-instantsearch re-initialises (and can infinite-loop) if the
// searchClient prop changes identity between renders. useMemo isn't a stability
// guarantee, so cache by config and always return the same instance.
type SearchClient = ReturnType<typeof instantMeiliSearch>["searchClient"];
const clientCache = new Map<string, SearchClient>();

export const makeSearchClient = (config: {
  url: string;
  key: string;
}): SearchClient => {
  const cacheKey = `${config.url}|${config.key}`;
  let client = clientCache.get(cacheKey);
  if (!client) {
    client = instantMeiliSearch(config.url, config.key, {
      primaryKey: "id",
      // No empty-query "show everything" — blank box shows nothing.
      placeholderSearch: false,
      meiliSearchParams: {
        hybrid: { embedder: EMBEDDER, semanticRatio: SEMANTIC_RATIO },
        rankingScoreThreshold: SCORE_THRESHOLD,
        attributesToCrop: ["text"],
        cropLength: 50,
      },
    }).searchClient;
    clientCache.set(cacheKey, client);
  }
  return client;
};

// Stable object reference for the InstantSearch `future` prop.
export const SEARCH_FUTURE = { preserveSharedStateOnUnmount: true } as const;

// Remember the last query so navigating to the reader and back restores it
// (the search route unmounts on navigation). Session-lived; resets on reload.
let lastQuery = "";
export const getLastQuery = (): string => lastQuery;
export const setLastQuery = (q: string): void => {
  lastQuery = q;
};

// Turn an OCR markdown snippet into clean plain text for the result preview:
// drop interlinear ruby glosses, strip HTML tags, markdown headers/dividers/
// emphasis, and Meilisearch's highlight markers.
export const cleanSnippet = (s: string): string =>
  s
    .replace(/__\/?ais-highlight__/g, "") // highlight markers
    .replace(/<rt>[\s\S]*?<\/rt>/g, "") // interlinear gloss content
    .replace(/<[^>]+>/g, "") // remaining HTML (ruby, em, …)
    .replace(/^\s*#{1,6}\s+/gm, "") // md headers
    .replace(/^\s*-{3,}\s*$/gm, "") // md dividers
    .replace(/[*_`>]/g, "") // emphasis / blockquote markers
    .replace(/\s+/g, " ")
    .trim();
