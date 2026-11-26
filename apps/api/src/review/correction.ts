// Checks and measures a corrected page from the Opus review before it
// replaces the stored text: the guards that reject a correction outright, and
// the word diff that the page_reviews stats come from.

import { diffArrays } from "diff";

// A correction with this share of the page's Arabic letters missing has
// dropped or summarised text rather than fixed it...
export const MAX_ARABIC_LETTER_LOSS = 0.15;
// ...as long as that is at least this many letters, so removing one wrongly
// transcribed word from a short page isn't mistaken for it.
export const MIN_ARABIC_LETTERS_LOST = 25;

// The footnote heading the transcription standard prescribes (ocr.ts).
const FOOTNOTE_HEADING = /^###\s*الحاشية\s*$/m;

// Base letters only (hamza through ya, and the extended letters such as alif
// wasla), not tashkeel or tatweel, so adding or removing diacritics never
// counts as losing text.
const ARABIC_LETTER = /[ء-غف-يٱ-ۓ]/g;

export const countArabicLetters = (text: string) =>
  text.match(ARABIC_LETTER)?.length ?? 0;

export type CorrectionRejection =
  | { reason: "empty_text"; detail: string }
  | { reason: "text_loss"; detail: string }
  | { reason: "footnotes_lost"; detail: string };

// Why a corrected page must not replace the original, or null if it may.
export function rejectCorrection({
  original,
  corrected,
}: {
  original: string;
  corrected: string;
}): CorrectionRejection | null {
  if (corrected.trim() === "") {
    return {
      reason: "empty_text",
      detail: "the corrected page is empty",
    };
  }
  const before = countArabicLetters(original);
  const lost = before - countArabicLetters(corrected);
  if (
    lost >= MIN_ARABIC_LETTERS_LOST &&
    lost > before * MAX_ARABIC_LETTER_LOSS
  ) {
    return {
      reason: "text_loss",
      detail: `the corrected page has ${lost} fewer Arabic letters (${Math.round((lost / before) * 100)}% of ${before})`,
    };
  }
  if (FOOTNOTE_HEADING.test(original) && !FOOTNOTE_HEADING.test(corrected)) {
    return {
      reason: "footnotes_lost",
      detail: "the corrected page has no footnote section (### الحاشية)",
    };
  }
  return null;
}

export interface PageDiffStats {
  wordsAdded: number;
  wordsRemoved: number;
  // Per changed stretch, the longer of what was removed and what was added:
  // the same measure an applied edit counted (the longer of find and replace).
  charsChanged: number;
}

// Words, whitespace runs and HTML tags (the ruby glosses) as separate tokens,
// the same split the desktop's diff view draws (apps/desktop/src/lib/word-diff.ts).
const TOKEN_SEPARATOR = /(\s+|<[^>]+>)/;
const WHITESPACE = /^\s+$/;
const MARKUP = /^<[^>]+>$/;

const tokenize = (text: string): string[] =>
  text.split(TOKEN_SEPARATOR).filter((token) => token !== "");

const countWords = (tokens: readonly string[]) =>
  tokens.filter((token) => !WHITESPACE.test(token) && !MARKUP.test(token))
    .length;

const charsOf = (tokens: readonly string[]) =>
  tokens.reduce((n, token) => n + token.length, 0);

const NO_CHANGE: PageDiffStats = {
  wordsAdded: 0,
  wordsRemoved: 0,
  charsChanged: 0,
};

const addStats = (a: PageDiffStats, b: PageDiffStats): PageDiffStats => ({
  wordsAdded: a.wordsAdded + b.wordsAdded,
  wordsRemoved: a.wordsRemoved + b.wordsRemoved,
  charsChanged: a.charsChanged + b.charsChanged,
});

// The diff's work grows with tokens x edits, and the queue consumer's CPU
// time is small (a whole-page word diff of a heavily corrected dense page
// took over 100 ms). So the page is diffed by line first, and only changed
// lines word by word; a stretch whose word diff would need more edits than
// this counts as rewritten.
const MAX_WORD_EDITS = 400;

function diffWords({
  before,
  after,
}: {
  before: string;
  after: string;
}): PageDiffStats {
  const beforeTokens = tokenize(before);
  const afterTokens = tokenize(after);
  const changes = diffArrays(beforeTokens, afterTokens, {
    maxEditLength: MAX_WORD_EDITS,
  });
  if (!changes) {
    return {
      wordsAdded: countWords(afterTokens),
      wordsRemoved: countWords(beforeTokens),
      charsChanged: Math.max(before.length, after.length),
    };
  }
  let stats = NO_CHANGE;
  let removed: string[] = [];
  let added: string[] = [];
  const closeStretch = () => {
    stats = addStats(stats, {
      wordsAdded: countWords(added),
      wordsRemoved: countWords(removed),
      charsChanged: Math.max(charsOf(removed), charsOf(added)),
    });
    removed = [];
    added = [];
  };
  for (const change of changes) {
    if (change.removed) removed.push(...change.value);
    else if (change.added) added.push(...change.value);
    else closeStretch();
  }
  closeStretch();
  return stats;
}

const splitLines = (text: string) => text.split(/(?<=\n)/);

// A stretch of changed lines: line by line when it kept its line count (the
// usual case: words fixed in place), else as one piece.
function diffChangedLines({
  removed,
  added,
}: {
  removed: string[];
  added: string[];
}): PageDiffStats {
  if (removed.length !== added.length) {
    return diffWords({ before: removed.join(""), after: added.join("") });
  }
  return removed.reduce(
    (stats, line, index) =>
      addStats(stats, diffWords({ before: line, after: added[index] ?? "" })),
    NO_CHANGE,
  );
}

// How much of the page the correction changed, from a word diff.
export function diffPageWords({
  before,
  after,
}: {
  before: string;
  after: string;
}): PageDiffStats {
  let stats = NO_CHANGE;
  let removed: string[] = [];
  let added: string[] = [];
  const closeStretch = () => {
    if (removed.length > 0 || added.length > 0) {
      stats = addStats(stats, diffChangedLines({ removed, added }));
    }
    removed = [];
    added = [];
  };
  for (const change of diffArrays(splitLines(before), splitLines(after))) {
    if (change.removed) removed.push(...change.value);
    else if (change.added) added.push(...change.value);
    else closeStretch();
  }
  closeStretch();
  return stats;
}
