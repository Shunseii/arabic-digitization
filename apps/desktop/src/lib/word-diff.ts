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

const RUBY_OPEN = "<ruby>";
const RUBY_CLOSE = "</ruby>";

const rubyDepthChange = (token: string) =>
  token === RUBY_OPEN ? 1 : token === RUBY_CLOSE ? -1 : 0;

/**
 * Indexes just after each newline in `text` that sits outside any gloss, given
 * the gloss depth at the start of `text`. A fold may only start or end there,
 * so it never cuts a <ruby> in half.
 */
const lineStartsOutsideGlosses = ({
  text,
  startDepth,
}: {
  text: string;
  startDepth: number;
}) => {
  const starts: number[] = [];
  let depth = startDepth;
  let offset = 0;
  for (const token of tokenize(text)) {
    depth += rubyDepthChange(token);
    if (depth === 0 && WHITESPACE.test(token)) {
      let newline = token.indexOf("\n");
      while (newline !== -1) {
        starts.push(offset + newline + 1);
        newline = token.indexOf("\n", newline + 1);
      }
    }
    offset += token.length;
  }
  return starts;
};

const foldUnchanged = ({
  text,
  startDepth,
  isFirst,
  isLast,
}: {
  text: string;
  startDepth: number;
  isFirst: boolean;
  isLast: boolean;
}): DiffSegment[] => {
  const starts = lineStartsOutsideGlosses({ text, startDepth });
  const headEnd = isFirst ? 0 : starts[CONTEXT_LINES - 1];
  const tailStart = isLast
    ? text.length
    : starts[starts.length - CONTEXT_LINES - 1];
  if (
    headEnd === undefined ||
    tailStart === undefined ||
    tailStart <= headEnd
  ) {
    return [{ kind: "same", text }];
  }
  const folded = text.slice(headEnd, tailStart);
  const lines = folded.split("\n").length - (folded.endsWith("\n") ? 1 : 0);
  if (lines < MIN_FOLDED_LINES) return [{ kind: "same", text }];
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
  // Gloss depth in the after text (unchanged + added tokens), which is the
  // structure the diff is drawn in.
  let afterDepth = 0;
  const segments = changes.flatMap((change, index): DiffSegment[] => {
    const text = change.value.join("");
    if (change.removed) {
      wordsRemoved += countWords(change.value);
      return [{ kind: "removed", text }];
    }
    const startDepth = afterDepth;
    for (const token of change.value) afterDepth += rubyDepthChange(token);
    if (change.added) {
      wordsAdded += countWords(change.value);
      return [{ kind: "added", text }];
    }
    return foldUnchanged({
      text,
      startDepth,
      isFirst: index === 0,
      isLast: index === changes.length - 1,
    });
  });
  return { segments, wordsAdded, wordsRemoved };
};

export interface DiffPiece {
  kind: ChangeKind;
  text: string;
}

export type DiffNode =
  | ({ type: "text" } & DiffPiece)
  | { type: "gloss"; base: DiffPiece[]; gloss: DiffPiece[] };

const pushPiece = ({
  pieces,
  piece,
}: {
  pieces: DiffPiece[];
  piece: DiffPiece;
}) => {
  const last = pieces.at(-1);
  if (last?.kind === piece.kind) last.text += piece.text;
  else pieces.push({ ...piece });
};

/**
 * Turns diffed pieces back into running text and glosses, so a gloss renders
 * the way the reader shows it rather than as raw <ruby>/<rt> tags. The gloss
 * structure comes from the after text; tags that only the before text had are
 * dropped, and their words show as removed wherever they now fall.
 */
export const toDiffNodes = (pieces: DiffPiece[]): DiffNode[] => {
  const nodes: DiffNode[] = [];
  let open: { base: DiffPiece[]; gloss: DiffPiece[] } | null = null;
  let inGloss = false;
  const closeGloss = () => {
    if (open) nodes.push({ type: "gloss", ...open });
    open = null;
    inGloss = false;
  };
  for (const { kind, text } of pieces) {
    for (const token of tokenize(text)) {
      if (isMarkup(token)) {
        if (kind === "removed") continue;
        if (token === RUBY_OPEN) {
          closeGloss();
          open = { base: [], gloss: [] };
          continue;
        }
        if (token === "<rt>") {
          inGloss = open !== null;
          continue;
        }
        if (token === "</rt>") {
          inGloss = false;
          continue;
        }
        if (token === RUBY_CLOSE) {
          closeGloss();
          continue;
        }
      }
      const piece = { kind, text: token };
      if (open) pushPiece({ pieces: inGloss ? open.gloss : open.base, piece });
      else {
        const last = nodes.at(-1);
        if (last?.type === "text" && last.kind === kind) last.text += token;
        else nodes.push({ type: "text", ...piece });
      }
    }
  }
  closeGloss();
  return nodes;
};
