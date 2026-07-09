import { instantMeiliSearch } from "@meilisearch/instant-meilisearch";

// Clients query Meilisearch directly with a read-only key. Hybrid (lexical +
// vector) is baked into every query here, so the search UI stays a plain
// InstantSearch app.
export const SEARCH_INDEX = "books";
const EMBEDDER = "cfbge";
const SEMANTIC_RATIO = 0.5;
// Absolute floor: drop hybrid matches below this ranking score (0-1). Applied
// server-side by Meili, so pagination counts stay correct.
const SCORE_THRESHOLD = 0.5;
// Adaptive tail cutoff: within a result page, drop hits more than this far below
// the top hit's score. The semantic half always returns *something* for any
// query; a weak query yields a low, flat score band, and this trims the long
// tail of barely-relevant pages that the absolute floor alone lets through.
const RELATIVE_SCORE_GAP = 0.2;

export type SearchHit = {
  id: string; // chunk id (`${file_id}#${i}`) — unique per result, list key
  file_id: string; // page id — reader nav + highlight target
  book_id: string;
  book_title: string;
  page_number: number | null;
  text: string; // matched chunk text
  page_text?: string; // full page markdown — preview render
  _rankingScore?: number;
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
    const base = instantMeiliSearch(config.url, config.key, {
      primaryKey: "id",
      // No empty-query "show everything" — blank box shows nothing.
      placeholderSearch: false,
      meiliSearchParams: {
        hybrid: { embedder: EMBEDDER, semanticRatio: SEMANTIC_RATIO },
        rankingScoreThreshold: SCORE_THRESHOLD,
        showRankingScore: true,
        attributesToCrop: ["text"],
        cropLength: 50,
      },
    }).searchClient;
    client = withRelativeScoreCutoff(base);
    clientCache.set(cacheKey, client);
  }
  return client;
};

// Wrap the search client to trim each result page's weak tail relative to its
// top hit (see RELATIVE_SCORE_GAP). Best-effort: if a response carries no
// `_rankingScore`, hits fall back to being kept, so this only ever tightens.
const withRelativeScoreCutoff = (base: SearchClient): SearchClient => {
  const trim = (response: { results: unknown[] }) => ({
    ...response,
    results: response.results.map((raw) => {
      const result = raw as { hits?: SearchHit[] };
      const hits = result.hits;
      if (!hits?.length) return raw;
      const top = hits[0]._rankingScore ?? 1;
      return {
        ...result,
        hits: hits.filter(
          (h) => (h._rankingScore ?? 1) >= top - RELATIVE_SCORE_GAP,
        ),
      };
    }),
  });
  // The client's `search` is an overload union (query vs composition); wrapping
  // it precisely isn't worth it, so delegate and re-type the response.
  const rawSearch = base.search as (
    r: unknown,
  ) => Promise<{ results: unknown[] }>;
  return {
    ...base,
    search: (requests: unknown) => rawSearch(requests).then(trim),
  } as SearchClient;
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
