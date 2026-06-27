import type { ReactNode } from "react";
import { colors } from "@/theme";

const RUBY = /<ruby>(.*?)<rt>(.*?)<\/rt><\/ruby>/g;

/**
 * Renders the Markdown the OCR pipeline produces (see apps/api/src/ocr.ts):
 * `##`/`###` headings, `---` dividers, `### الحاشية` footnotes, and inline
 * `<ruby>base<rt>gloss</rt></ruby>` interlinear glosses — all right-to-left.
 * Mirrors apps/mobile/src/lib/markdown.tsx, rendered as HTML for the webview.
 * Intentionally small and dependency-free rather than a full CommonMark parser.
 *
 * Pass `highlight` (relevant passages from the search-highlight API) to wrap
 * matching text in <mark>. Highlighting is purely additive — the markup,
 * layout, and RTL flow are identical with or without it, so the search preview
 * and the reader render the page the same way.
 */

// Diacritic/footnote-tolerant matching, mirroring apps/api/src/lib/highlight.ts
// so passages located server-side against the *cleaned* text still match here
// against the *raw* markdown line (which keeps diacritics and OCR artifacts).
// Tested by code point, not a regex literal: the formatter rewrites \u escapes
// in a literal char class into literal combining marks, which silently
// corrupts the ranges (and broke this once).
const isDiacritic = (c: string): boolean => {
  const n = c.codePointAt(0) ?? 0;
  return (
    (n >= 0x0610 && n <= 0x061a) || // Arabic marks
    (n >= 0x064b && n <= 0x065f) || // tanwin / harakat
    n === 0x0670 || // superscript alef
    (n >= 0x06d6 && n <= 0x06ed) || // Quranic annotation marks
    n === 0x0640 // tatweel (kashida)
  );
};
const LETTER_SUB: Record<string, string> = {
  أ: "ا",
  إ: "ا",
  آ: "ا",
  ى: "ي",
  ؤ: "و",
  ئ: "ي",
  ة: "ه",
};

// Normalized skeleton + a map from each normalized char back to its raw index.
// Whitespace runs collapse to a single space — including runs left adjacent
// once a footnote marker like " (١) " between two words is stripped, which
// would otherwise leave a double space and break the match.
const normalize = (s: string): { norm: string; idx: number[] } => {
  const out: string[] = [];
  const idx: number[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i] as string;
    if (isDiacritic(c) || c === "(" || c === ")" || (c >= "٠" && c <= "٩")) {
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      if (out[out.length - 1] !== " ") {
        out.push(" ");
        idx.push(i);
      }
      while (i < s.length && /\s/.test(s[i] as string)) i++;
      continue;
    }
    out.push(LETTER_SUB[c] ?? c);
    idx.push(i);
    i++;
  }
  return { norm: out.join(""), idx };
};

// Wrap every occurrence of any `terms` passage within `text` in <mark>.
// Overlapping matches are merged (first/longest wins) so nothing is wrapped
// twice. Returns the text unchanged when there are no terms or no matches.
const markMatches = (
  text: string,
  terms: string[] | undefined,
  keyBase: string,
): ReactNode[] => {
  if (!terms || terms.length === 0) return [text];
  const { norm, idx } = normalize(text);
  const ranges: [number, number][] = [];
  for (const term of terms) {
    const nt = normalize(term).norm.trim();
    if (!nt) continue;
    let from = norm.indexOf(nt);
    while (from >= 0) {
      const start = idx[from] as number;
      const end = (idx[from + nt.length - 1] as number) + 1;
      ranges.push([start, end]);
      from = norm.indexOf(nt, from + nt.length);
    }
  }
  if (ranges.length === 0) return [text];
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const nodes: ReactNode[] = [];
  let pos = 0;
  let i = 0;
  for (const [start, end] of ranges) {
    if (start < pos) continue; // inside an already-wrapped span
    if (start > pos) nodes.push(text.slice(pos, start));
    nodes.push(
      <mark
        key={`${keyBase}-m${i}`}
        className="rounded bg-accent-soft px-0.5 text-ink ring-1 ring-accent/30"
      >
        {text.slice(start, end)}
      </mark>,
    );
    pos = end;
    i += 1;
  }
  if (pos < text.length) nodes.push(text.slice(pos));
  return nodes;
};

const inline = (
  text: string,
  keyBase: string,
  highlight?: string[],
): ReactNode[] => {
  const nodes: ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  RUBY.lastIndex = 0;
  let i = 0;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
  while ((match = RUBY.exec(text)) !== null) {
    if (match.index > last)
      nodes.push(
        ...markMatches(
          text.slice(last, match.index),
          highlight,
          `${keyBase}-t${i}`,
        ),
      );
    nodes.push(
      <span key={`${keyBase}-r${i}`}>
        {match[1]}
        <span style={{ fontSize: 13, color: colors.accent }}>
          {" "}
          ({match[2]})
        </span>
      </span>,
    );
    last = match.index + match[0].length;
    i += 1;
  }
  if (last < text.length)
    nodes.push(...markMatches(text.slice(last), highlight, `${keyBase}-t${i}`));
  return nodes.length > 0 ? nodes : [text];
};

export const Markdown = ({
  source,
  highlight,
}: {
  source: string;
  highlight?: string[];
}) => {
  const lines = source.split(/\r?\n/);
  const firstContent = lines.findIndex((l) => l.trim().length > 0);
  const blocks: ReactNode[] = [];
  let inFootnotes = false;

  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line) return;
    const key = `l${index}`;

    if (line === "---") {
      blocks.push(
        <hr
          key={key}
          style={{
            height: 1,
            border: 0,
            backgroundColor: colors.hairline,
            alignSelf: "stretch",
            width: "100%",
          }}
        />,
      );
      return;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const content = heading[2];
      if (content.includes("الحاشية")) {
        inFootnotes = true;
        blocks.push(
          <p
            key={key}
            dir="rtl"
            style={{
              textAlign: "right",
              color: colors.textMuted,
              fontSize: 13,
              fontWeight: 700,
              marginTop: 8,
            }}
          >
            {inline(content, key, highlight)}
          </p>,
        );
        return;
      }
      const major = level <= 2;
      blocks.push(
        <p
          key={key}
          dir="rtl"
          style={{
            textAlign: "right",
            marginTop: major ? 8 : 4,
            fontSize: major ? 22 : 17,
            fontWeight: major ? 700 : 600,
            color: major ? colors.accent : colors.ink,
          }}
        >
          {inline(content, key, highlight)}
        </p>,
      );
      return;
    }

    if (index === firstContent) {
      blocks.push(
        <p
          key={key}
          dir="rtl"
          style={{
            textAlign: "center",
            color: colors.textMuted,
            fontSize: 13,
          }}
        >
          {inline(line, key, highlight)}
        </p>,
      );
      return;
    }

    blocks.push(
      <p
        key={key}
        dir="rtl"
        style={{
          textAlign: "right",
          color: inFootnotes ? colors.textSecondary : colors.ink,
          fontSize: inFootnotes ? 15 : 19,
          lineHeight: inFootnotes ? "26px" : "34px",
        }}
      >
        {inline(line, key, highlight)}
      </p>,
    );
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {blocks}
    </div>
  );
};
