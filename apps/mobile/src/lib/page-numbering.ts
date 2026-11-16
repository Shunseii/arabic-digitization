/**
 * Page numbers on the scan screen. Each page takes, in order:
 *   1. the number the user typed;
 *   2. the number read from the page, when the reader is sure and it fits
 *      the sequence;
 *   3. the previous page's number + 1 (or the book's next page).
 *
 * Calibrated on held-out pages in tools/page-number: with these limits the
 * reader filled about 55% of pages and got 0-1 in 308 wrong.
 */

/** The first page has no previous one to check against, so it must be surer. */
const MIN_CONFIDENCE_FIRST = 0.99;
const MIN_CONFIDENCE = 0.97;
/**
 * A read further than this from the sequence is rejected. A dropped digit is
 * always at least 10 away (11 read as 1, 86 as 6), so this also catches those.
 */
const MAX_JUMP = 5;

export interface PageNumberFields {
  page: string;
  /** The user edited this page's number; it is never overwritten. */
  typed: boolean;
  /** What the reader found on the page, if anything. */
  detected: { value: number; confidence: number } | null;
  /** The shown number came from the page itself. */
  fromPage: boolean;
}

const parse = (page: string | undefined): number | null =>
  page ? Number.parseInt(page, 10) : null;

export const resolvePageNumbers = <T extends PageNumberFields>({
  pages,
  startPage,
}: {
  pages: T[];
  startPage: number;
}): T[] => {
  const out: T[] = [];
  pages.forEach((p, i) => {
    if (p.typed) {
      out.push({ ...p, fromPage: false });
      return;
    }
    const prev = i > 0 ? parse(out[i - 1]?.page) : null;
    const expected = prev !== null ? prev + 1 : startPage + i;
    const d = p.detected;
    const accept =
      d !== null &&
      (i === 0
        ? d.confidence >= MIN_CONFIDENCE_FIRST
        : d.confidence >= MIN_CONFIDENCE &&
          Math.abs(d.value - expected) <= MAX_JUMP);
    out.push({
      ...p,
      page: String(accept ? d.value : expected),
      fromPage: accept,
    });
  });
  return out;
};
