// Neutral counts over one page of OCR output, stored on each ocr_runs row as a
// cache: a few fixed columns plus a JSON `metrics` blob. They are recomputable
// from the run's text in R2, so bump METRICS_VERSION whenever a definition
// changes and run the backfill (POST /api/admin/ocr-runs/recompute-metrics).
//
// Counts only, never pass/fail: what is "right" depends on the page.
//
// The page layout these read is the one the OCR system prompt asks for:
//
//   <running header>
//
//   ---
//
//   <matn>
//
//   ---
//
//   ### الحاشية
//   <footnotes>

export const METRICS_VERSION = 1;

export interface PageColumns {
  words: number;
  chars: number;
  blank: 0 | 1;
  // First line, then a blank line, then "---".
  has_header: 0 | 1;
  // null when the page has no footnote heading at all.
  footnote_block_ok: 0 | 1 | null;
  // Markdown headings in the matn, not counting the footnote heading.
  headings: number;
}

export interface PageMetrics {
  quran_spans: number;
  // Spans holding an Uthmani mark (see UTHMANI_MARK).
  quran_spans_uthmani: number;
  uthmani_marks: number;
  ruby_glosses: number;
  // Matn lines made up only of [ … ] groups, outside the footnote block.
  loose_bracket_lines: number;
  // Distinct marker numbers in the matn, e.g. (١) or ⁽¹⁾.
  footnote_markers: number;
  // Distinct numbered entries in the footnote block.
  footnotes: number;
  // Numbers present on only one side.
  footnote_marker_mismatch: number;
}

export interface PageMeasurement {
  columns: PageColumns;
  metrics: PageMetrics;
}

const DIVIDER = "---";
const FOOTNOTE_HEADING = "### الحاشية";
const FOOTNOTE_HEADING_LOOSE = /^#{1,6}\s*الحاشية\s*$/;
const HEADING = /^#{1,6}\s+\S/;
const QURAN_SPAN = /﴿[^﴿﴾]*﴾/g;
// Alif wasla, dagger alif, the small high signs and small waw/ya of the mushaf.
const UTHMANI_MARK = /[ٰٱۖ-ۜ۟-۪ۨ-ۭ]/;
const UTHMANI_MARKS = new RegExp(UTHMANI_MARK.source, "g");
const RUBY = /<ruby[\s>]/g;
const LOOSE_BRACKET_LINE = /^\s*(?:\[[^\]\n]*\]\s*)+$/;
const MATN_MARKER = /\(([0-9٠-٩۰-۹]+)\)|⁽([⁰¹²³⁴-⁹]+)⁾/g;
const FOOTNOTE_ENTRY =
  /^\s*(?:\(([0-9٠-٩۰-۹]+)\)|⁽([⁰¹²³⁴-⁹]+)⁾|([0-9٠-٩۰-۹]+)\s*[-–.)])/;
const TAG = /<[^>]+>/g;
const LETTER = /\p{L}/u;

const SUPERSCRIPT_DIGITS: Record<string, string> = {
  "⁰": "0",
  "¹": "1",
  "²": "2",
  "³": "3",
  "⁴": "4",
  "⁵": "5",
  "⁶": "6",
  "⁷": "7",
  "⁸": "8",
  "⁹": "9",
};

function toAsciiDigits(digits: string): string {
  let out = "";
  for (const c of digits) {
    const code = c.charCodeAt(0);
    if (code >= 0x0660 && code <= 0x0669) out += String(code - 0x0660);
    else if (code >= 0x06f0 && code <= 0x06f9) out += String(code - 0x06f0);
    else out += SUPERSCRIPT_DIGITS[c] ?? c;
  }
  return String(Number(out));
}

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

function hasHeader(lines: string[]): boolean {
  return (
    (lines[0] ?? "").trim() !== "" &&
    (lines[1] ?? "").trim() === "" &&
    (lines[2] ?? "").trim() === DIVIDER
  );
}

// The block must be a blank line, "---", a blank line, then "### الحاشية".
function isWellFormedFootnoteBlock(
  lines: string[],
  headingAt: number,
): boolean {
  return (
    (lines[headingAt] ?? "").trim() === FOOTNOTE_HEADING &&
    (lines[headingAt - 1] ?? "").trim() === "" &&
    (lines[headingAt - 2] ?? "").trim() === DIVIDER &&
    (lines[headingAt - 3] ?? "").trim() === ""
  );
}

// Matn lines: after the running header, before the footnote divider.
function matnLines({
  lines,
  withHeader,
  footnoteHeadingAt,
}: {
  lines: string[];
  withHeader: boolean;
  footnoteHeadingAt: number;
}): string[] {
  const body = lines.slice(
    withHeader ? 3 : 0,
    footnoteHeadingAt >= 0 ? footnoteHeadingAt : lines.length,
  );
  while (body.length > 0) {
    const last = (body.at(-1) ?? "").trim();
    if (last !== "" && last !== DIVIDER) break;
    body.pop();
  }
  return body;
}

function matnMarkerNumbers(matn: string): Set<string> {
  const numbers = new Set<string>();
  for (const match of matn.matchAll(MATN_MARKER)) {
    const digits = match[1] ?? match[2];
    if (digits) numbers.add(toAsciiDigits(digits));
  }
  return numbers;
}

function footnoteEntryNumbers(lines: string[]): Set<string> {
  const numbers = new Set<string>();
  for (const line of lines) {
    const match = FOOTNOTE_ENTRY.exec(line);
    const digits = match?.[1] ?? match?.[2] ?? match?.[3];
    if (digits) numbers.add(toAsciiDigits(digits));
  }
  return numbers;
}

function countWords(text: string): number {
  let words = 0;
  for (const token of text.replace(TAG, " ").split(/\s+/)) {
    if (LETTER.test(token)) words++;
  }
  return words;
}

export function measurePage(text: string): PageMeasurement {
  const lines = text.split(/\r?\n/);
  const withHeader = hasHeader(lines);
  const footnoteHeadingAt = lines.findLastIndex((line) =>
    FOOTNOTE_HEADING_LOOSE.test(line.trim()),
  );
  const matn = matnLines({ lines, withHeader, footnoteHeadingAt });
  const footnoteLines =
    footnoteHeadingAt >= 0 ? lines.slice(footnoteHeadingAt + 1) : [];

  const markers = matnMarkerNumbers(matn.join("\n"));
  const entries = footnoteEntryNumbers(footnoteLines);
  let mismatch = 0;
  for (const n of markers) if (!entries.has(n)) mismatch++;
  for (const n of entries) if (!markers.has(n)) mismatch++;

  const quranSpans = text.match(QURAN_SPAN) ?? [];

  return {
    columns: {
      words: countWords(text),
      chars: [...text].length,
      blank: text.trim() === "" ? 1 : 0,
      has_header: withHeader ? 1 : 0,
      footnote_block_ok:
        footnoteHeadingAt < 0
          ? null
          : isWellFormedFootnoteBlock(lines, footnoteHeadingAt)
            ? 1
            : 0,
      headings: matn.filter((line) => HEADING.test(line.trim())).length,
    },
    metrics: {
      quran_spans: quranSpans.length,
      quran_spans_uthmani: quranSpans.filter((span) => UTHMANI_MARK.test(span))
        .length,
      uthmani_marks: countMatches(text, UTHMANI_MARKS),
      ruby_glosses: countMatches(text, RUBY),
      loose_bracket_lines: matn.filter((line) => LOOSE_BRACKET_LINE.test(line))
        .length,
      footnote_markers: markers.size,
      footnotes: entries.size,
      footnote_marker_mismatch: mismatch,
    },
  };
}
