import { diffArrays } from "diff";

export type ChangeKind = "same" | "added" | "removed";

export type DiffSegment =
  | { kind: ChangeKind; text: string }
  /** A long unchanged stretch, folded until the reader opens it. */
  | { kind: "folded"; text: string; lines: number };

export interface WordDiff {
  segments: DiffSegment[];
  wordsAdded: number;
  wordsRemoved: number;
}

/** Unchanged lines kept visible on each side of a change. */
const CONTEXT_LINES = 2;
/** Fold an unchanged stretch only when it hides at least this many lines. */
const MIN_FOLDED_LINES = 3;

const TOKEN_SEPARATOR = /(\s+|<[^>]+>)/;
const WHITESPACE = /^\s+$/;
const MARKUP = /^<[^>]+>$/;

/**
 * Words, whitespace runs and HTML tags (the <ruby>/<rt> glosses) as separate
 * tokens, so a change inside a gloss doesn't mark the whole ruby as changed.
 */
export const tokenize = (text: string): string[] =>
  text.split(TOKEN_SEPARATOR).filter((token) => token !== "");

export const isMarkup = (token: string) => MARKUP.test(token);

const countWords = (tokens: string[]) =>
  tokens.filter((token) => !WHITESPACE.test(token) && !isMarkup(token)).length;

/** The end index of the line `count` lines into `text` (after its newline). */
const afterLines = ({ text, count }: { text: string; count: number }) => {
  let index = 0;
  for (let line = 0; line < count; line++) {
    const next = text.indexOf("\n", index);
    if (next === -1) return text.length;
    index = next + 1;
  }
  return index;
};

/** The start index of the last `count` lines of `text`. */
const beforeLastLines = ({ text, count }: { text: string; count: number }) => {
  let index = text.length;
  for (let line = 0; line <= count; line++) {
    const previous = text.lastIndexOf("\n", index - 1);
    if (previous === -1) return 0;
    index = previous;
  }
  return index + 1;
};

const foldUnchanged = ({
  text,
  isFirst,
  isLast,
}: {
  text: string;
  isFirst: boolean;
  isLast: boolean;
}): DiffSegment[] => {
  const headEnd = isFirst ? 0 : afterLines({ text, count: CONTEXT_LINES });
  const tailStart = isLast
    ? text.length
    : beforeLastLines({ text, count: CONTEXT_LINES });
  const folded = text.slice(headEnd, tailStart);
  const lines = folded.split("\n").length - (folded.endsWith("\n") ? 1 : 0);
  if (tailStart <= headEnd || lines < MIN_FOLDED_LINES) {
    return [{ kind: "same", text }];
  }
  return [
    { kind: "same" as const, text: text.slice(0, headEnd) },
    { kind: "folded" as const, text: folded, lines },
    { kind: "same" as const, text: text.slice(tailStart) },
  ].filter((segment) => segment.text !== "");
};

/** A word-level diff of two texts, with long unchanged stretches folded. */
export const wordDiff = ({
  before,
  after,
}: {
  before: string;
  after: string;
}): WordDiff => {
  const changes = diffArrays(tokenize(before), tokenize(after));
  let wordsAdded = 0;
  let wordsRemoved = 0;
  const segments = changes.flatMap((change, index): DiffSegment[] => {
    const text = change.value.join("");
    if (change.added) {
      wordsAdded += countWords(change.value);
      return [{ kind: "added", text }];
    }
    if (change.removed) {
      wordsRemoved += countWords(change.value);
      return [{ kind: "removed", text }];
    }
    return foldUnchanged({
      text,
      isFirst: index === 0,
      isLast: index === changes.length - 1,
    });
  });
  return { segments, wordsAdded, wordsRemoved };
};
