#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import {
  type BookExportResponse,
  type BookStatusResponse,
  type BookWithStatus,
  type CreateBookResponse,
  DEFAULT_REVIEW_COST_PER_PAGE_USD,
  type DeleteBookResponse,
  type EditTextResponse,
  type FetchBookResponse,
  type FileStatus,
  type JobsResponse,
  type ListBooksResponse,
  type OcrEngine,
  type PageReview,
  type PageReviewsResponse,
  type PauseBookResponse,
  type QueuePageReviewResponse,
  type QueueReviewResponse,
  type ResumeBookResponse,
  type ReviewBatchJob,
  type ReviewSummaryResponse,
  type SpendResponse,
  type SpendTotals,
  type TextEdit,
  type TextHistoryResponse,
  type UpdateBookResponse,
} from "@qiraa/shared";
import { authCommand, UsageError } from "./auth.ts";
import { HttpError, request, requestText } from "./http.ts";

// Replaced at compile time (bun build --define CORPUS_VERSION='"1.2.3"').
declare const CORPUS_VERSION: string | undefined;
const VERSION = typeof CORPUS_VERSION === "string" ? CORPUS_VERSION : "dev";

const USAGE = `corpus: the Arabic digitization corpus from the command line

Credentials come from env vars (ARABIC_OCR_URL, ARABIC_OCR_KEY, MEILI_URL,
MEILI_SEARCH_KEY), otherwise the OS keychain (see \`corpus auth\`).
<book> is a book id or (part of) its title.

Auth
  corpus auth login               prompt for the API URL/key and Meilisearch URL/key,
                                  store them in the OS keychain
  corpus auth login --url <u> --key-stdin [--meili-url <u> --meili-key-stdin]
                                  non-interactive; key(s) on stdin, one per line
                                  (API key first)
  corpus auth login --1password   read all four from 1Password once (needs \`op\`)
  corpus auth status              which values are set and where (env/keychain)
  corpus auth logout              delete the stored values from the keychain

Books
  corpus books                    list books with per-state page counts
  corpus show <book>              one book: counts, OCR/review cost, review on/off,
                                  paused, engine, instructions
  corpus create --title <t> [--id <slug>] [--instructions <text>] [--work <id>]
                [--engine inkling|claude]
  corpus engine <book> <inkling|claude|default>
                                  OCR provider tried first (the other is the fallback);
                                  default = inkling. Does not re-OCR existing pages:
                                  run corpus retry <book> --states done for that
  corpus delete <book> --yes      delete a book and all its pages (irreversible)
  corpus pause <book>             stop OCR for this book only
  corpus resume <book>            resume OCR and re-queue its waiting pages

OCR
  corpus status <book> [--state <s>]      per-page states (filter, e.g. failed);
                                  lists failed and hand-edited pages by default
  corpus retry <book> [--states a,b]      re-queue pages (default failed,rate_limited)
  corpus ocr <book> <fileId...>           re-run OCR on specific pages and wait for the result
                                  Re-OCR overwrites hand edits (--states done included);
                                  the old text stays in the page's history. Check
                                  "edited" in corpus status first.
  corpus export <book>                    all pages + text as JSON (fetched in batches)
  corpus text <book> <fileId> [--rev <id>] one page's Markdown (or an earlier version)

Editing (every change keeps the replaced text in the page's history)
  corpus edit <book> <fileId> --old <text> --new <text> [--note <why>]
  corpus edit <book> <fileId> --edits <file.json|-> [--note <why>]
                                  exact find-and-replace; each old must match once,
                                  all or nothing. JSON: [{"old": "...", "new": "..."}]
  corpus history <book> <fileId>          changes to a page's text, newest first

Review (Opus proofreads OCR'd pages against the scan; costs money, ~$0.03/page)
  corpus review <book> on [--yes | --new-only]
                                  review pages as they finish OCR. If the book has
                                  done pages, asks whether to queue them too (with a
                                  cost estimate); --yes queues them, --new-only doesn't
  corpus review <book> off        stop reviewing new pages
  corpus review <book> --all [--yes]
                                  re-review every done page, even with review off
                                  (asks first, with page count and estimate)
  corpus review <book> <fileId|page...>
                                  review specific pages now (even with review off)
  corpus reviews [--days n] [--book <book>]
                                  review totals: pages, words added/removed, cost,
                                  batch timing
  corpus reviews <book> <fileId|page>
                                  a page's reviews: status, cost, words added/removed
                                  (older reviews: their find-and-replace edits)
                                  Reviews never touch hand-edited pages; each applied
                                  review is a "review" entry in corpus history.

Activity
  corpus jobs                     live OCR per book, review batches, pages that gave up
  corpus spend [--days n] [--book <book>]
                                  OCR vs review cost: by model, daily, top books

Search
  corpus search <query> [--book <book>] [--ratio 0..1] [--limit n]
                                  hybrid search; ratio 0 = keyword, 1 = semantic

Options
  --json     machine-readable output (every command)
  --version  print the version
  --help     this help
`;

const CLI_OPTIONS = {
  json: { type: "boolean", default: false },
  yes: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
  version: { type: "boolean", short: "v", default: false },
  url: { type: "string" },
  "key-stdin": { type: "boolean", default: false },
  "meili-url": { type: "string" },
  "meili-key-stdin": { type: "boolean", default: false },
  "1password": { type: "boolean", default: false },
  title: { type: "string" },
  id: { type: "string" },
  instructions: { type: "string" },
  engine: { type: "string" },
  work: { type: "string" },
  state: { type: "string" },
  states: { type: "string" },
  book: { type: "string" },
  ratio: { type: "string" },
  limit: { type: "string" },
  rev: { type: "string" },
  old: { type: "string" },
  new: { type: "string" },
  edits: { type: "string" },
  note: { type: "string" },
  days: { type: "string" },
  all: { type: "boolean", default: false },
  "new-only": { type: "boolean", default: false },
} as const;

const isParseArgsError = (err: unknown): err is Error => {
  const code: unknown =
    err instanceof Error && "code" in err ? err.code : undefined;
  return typeof code === "string" && code.startsWith("ERR_PARSE_ARGS_");
};

// Runs before main(), so a bad flag (unknown, or missing its value) must be
// reported here as a usage error rather than escaping as an uncaught throw.
const parseCliArgs = () => {
  try {
    return parseArgs({ allowPositionals: true, options: CLI_OPTIONS });
  } catch (err) {
    if (!isParseArgsError(err)) throw err;
    console.error(`corpus: ${err.message}\nRun \`corpus --help\` for usage.`);
    process.exit(2);
  }
};

const { values: opts, positionals } = parseCliArgs();

// Edits from --old/--new, or a JSON array from --edits <file> ("-" = stdin).
const readEdits = (): TextEdit[] => {
  if (opts.edits) {
    const raw = readFileSync(opts.edits === "-" ? 0 : opts.edits, "utf8");
    const parsed: unknown = JSON.parse(raw);
    const valid =
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every(
        (e) =>
          typeof e === "object" &&
          e !== null &&
          typeof (e as TextEdit).old === "string" &&
          typeof (e as TextEdit).new === "string",
      );
    if (!valid) {
      throw new UsageError(
        '--edits must be a JSON array of {"old": "...", "new": "..."}',
      );
    }
    return parsed as TextEdit[];
  }
  if (opts.old === undefined || opts.new === undefined) {
    throw new UsageError("pass --old and --new, or --edits <file.json>");
  }
  return [{ old: opts.old, new: opts.new }];
};

const OCR_WAIT_MS = 4 * 60_000;
const EXPORT_BATCH = 200;

const print = ({ data, human }: { data: unknown; human: () => string }) => {
  console.log(opts.json ? JSON.stringify(data, null, 2) : human());
};

const need = (value: string | undefined, what: string): string => {
  if (!value) throw new UsageError(`missing ${what}`);
  return value;
};

const OCR_ENGINES: readonly OcrEngine[] = ["inkling", "claude"];

const parseEngine = (value: string): OcrEngine => {
  const engine = OCR_ENGINES.find((e) => e === value);
  if (!engine) {
    throw new UsageError(
      `unknown engine "${value}" (expected ${OCR_ENGINES.join(" or ")})`,
    );
  }
  return engine;
};

const engineLabel = (engine: OcrEngine | null | undefined): string =>
  engine ?? "inkling (default)";

const countsLine = (counts: Record<string, number>): string =>
  Object.entries(counts)
    .map(([state, n]) => `${state} ${n}`)
    .join(" / ") || "no pages";

const listBooks = async (): Promise<BookWithStatus[]> =>
  (await request<ListBooksResponse>({ service: "api", path: "/api/books" }))
    .books;

// Exact id, then exact title, then a unique title substring.
const resolveBook = async (ref: string): Promise<BookWithStatus> => {
  const books = await listBooks();
  const byId = books.find((b) => b.id === ref);
  if (byId) return byId;
  const exact = books.filter((b) => b.title === ref);
  if (exact.length === 1 && exact[0]) return exact[0];
  const partial = books.filter((b) => b.title.includes(ref));
  if (partial.length === 1 && partial[0]) return partial[0];
  const candidates = (exact.length > 1 ? exact : partial)
    .map((b) => `  ${b.id}  ${b.title}`)
    .join("\n");
  throw new UsageError(
    candidates
      ? `"${ref}" matches several books; pass the id:\n${candidates}`
      : `no book matches "${ref}" (see \`corpus books\`)`,
  );
};

const bookPath = (id: string, rest = "") =>
  `/api/books/${encodeURIComponent(id)}${rest}`;

interface SearchHit {
  file_id: string;
  book_id: string;
  book_title: string;
  page_number: number | null;
  _formatted?: { text?: string };
}

// Provider errors ("Claude 529: {...}") embed the whole response body; the
// provider and status are the useful bit.
const shortError = (error: string): string =>
  /^(Inkling|Claude) \d{3}\b/.exec(error)?.[0] ?? error.slice(0, 120);

const cleanSnippet = (text: string): string =>
  text
    .replace(/__\/?ais-highlight__/g, "")
    .replace(/<\/?(ruby|rt|rp|em|mark)>/g, "")
    .replace(/[*_#>`]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const usd = (n: number | null | undefined): string =>
  n == null ? "-" : `$${n.toFixed(2)}`;

const perPage = (n: number): string => `$${n.toFixed(3)}/page`;

const formatDuration = (ms: number | null | undefined): string => {
  if (ms == null) return "-";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
};

const ago = (at: number | null | undefined): string =>
  at == null ? "-" : `${formatDuration(Date.now() - at)} ago`;

const timestamp = (at: number): string =>
  new Date(at).toISOString().slice(0, 16).replace("T", " ");

const parseDays = (): number | undefined => {
  if (opts.days === undefined) return undefined;
  const days = Number(opts.days);
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    throw new UsageError("--days is a whole number from 1 to 90");
  }
  return days;
};

// ?days=&book= for the summary and spend endpoints.
const windowQuery = ({
  days,
  bookId,
}: {
  days: number | undefined;
  bookId: string | undefined;
}): string => {
  const params = new URLSearchParams();
  if (days !== undefined) params.set("days", String(days));
  if (bookId) params.set("book", bookId);
  const query = params.toString();
  return query ? `?${query}` : "";
};

// Billed spend split by kind; older API responses only have the OCR cost of
// the current text.
const costLine = (usage: BookWithStatus["usage"]): string | null => {
  if (!usage) return null;
  if (usage.ocr || usage.review) {
    const part = (label: string, t: SpendTotals | undefined) =>
      `${label} ${usd(t?.cost_usd ?? 0)}${t?.pages ? ` (${t.pages} pages)` : ""}`;
    return `Cost ${usd(usage.total_cost_usd ?? (usage.ocr?.cost_usd ?? 0) + (usage.review?.cost_usd ?? 0))}: ${part("OCR", usage.ocr)} · ${part("review", usage.review)}`;
  }
  return usage.cost_usd != null ? `OCR cost ${usd(usage.cost_usd)}` : null;
};

const fetchStatus = async (bookId: string): Promise<FileStatus[]> =>
  (
    await request<BookStatusResponse>({
      service: "api",
      path: bookPath(bookId, "/status"),
    })
  ).files;

// What the server will queue: done pages with text that nobody edited by hand.
// Without `all`, only pages never reviewed (no review cost yet).
const reviewablePages = ({
  files,
  all,
}: {
  files: FileStatus[];
  all: boolean;
}): FileStatus[] =>
  files.filter(
    (f) =>
      f.state === "done" &&
      f.preview !== "" &&
      f.text_edited_at === null &&
      (all || f.review_cost_usd == null),
  );

// Measured cost per page over the last 90 days, else the shared default.
const reviewCostPerPage = async (): Promise<{
  usd: number;
  measured: boolean;
}> => {
  const summary = await request<ReviewSummaryResponse>({
    service: "api",
    path: "/api/reviews/summary?days=90",
  });
  return summary.cost_per_page_usd != null
    ? { usd: summary.cost_per_page_usd, measured: true }
    : { usd: DEFAULT_REVIEW_COST_PER_PAGE_USD, measured: false };
};

const estimateLine = async (pages: number): Promise<string> => {
  const cost = await reviewCostPerPage();
  return `${pages} page${pages === 1 ? "" : "s"} × ${perPage(cost.usd)}${cost.measured ? " (measured, last 90 days)" : " (default estimate)"} ≈ ${usd(pages * cost.usd)}`;
};

// --yes answers for agents; otherwise ask on a terminal, or refuse.
const confirm = async ({
  question,
  refusal,
}: {
  question: string;
  refusal: string;
}): Promise<boolean> => {
  if (opts.yes) return true;
  if (!process.stdin.isTTY) throw new UsageError(refusal);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
};

// Each ref is a file id or a printed page number (which may match several
// fragments of one page).
const resolvePages = ({
  files,
  refs,
}: {
  files: FileStatus[];
  refs: string[];
}): FileStatus[] => {
  const picked = new Map<string, FileStatus>();
  for (const ref of refs) {
    const byId = files.find((f) => f.file_id === ref);
    const matches = byId
      ? [byId]
      : /^\d+$/.test(ref)
        ? files.filter((f) => f.page_number === Number(ref))
        : [];
    if (matches.length === 0) {
      throw new UsageError(
        `no page "${ref}" in this book (pass a file id or page number; see \`corpus status <book> --state done\`)`,
      );
    }
    for (const f of matches) picked.set(f.file_id, f);
  }
  return [...picked.values()];
};

type PageReviewResult = Omit<QueuePageReviewResponse, "success"> & {
  file_id: string;
  page_number: number | null;
  success: boolean;
  /** Why the page wasn't queued (404/409 from the API). */
  error: string | null;
};

// What a review changed: a full-page review's word diff, or an older
// find-and-replace review's edit counts.
const reviewChange = (r: PageReview): string => {
  if (r.format === "full_page") {
    return r.words_added === null
      ? "not compared"
      : `+${r.words_added} / -${r.words_removed} words`;
  }
  if (r.format === "edits") {
    return `${r.edits_applied}/${r.edits_proposed} edits applied${r.edits_failed ? `, ${r.edits_failed} failed` : ""}`;
  }
  return "no answer";
};

const pageLabel = (f: Pick<FileStatus, "page_number" | "file_id">): string =>
  `p${f.page_number ?? "?"}  ${f.file_id}`;

const batchLine = (b: ReviewBatchJob): string => {
  const counts = Object.entries(b.request_counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k} ${n}`)
    .join(", ");
  const duration =
    b.submitted_at != null && b.anthropic_ended_at != null
      ? `took ${formatDuration(b.anthropic_ended_at - b.submitted_at)}`
      : b.submitted_at != null
        ? `submitted ${ago(b.submitted_at)}`
        : `created ${ago(b.created_at)}`;
  return [
    `  ${b.stage}${b.instance_status ? ` (${b.instance_status})` : ""}  ${b.reviewed}/${b.pages} pages reviewed`,
    duration,
    counts ? `anthropic: ${counts}` : null,
    b.changed
      ? `${b.changed} changed (+${b.words_added} / -${b.words_removed} words)`
      : null,
    b.errors ? `${b.errors} without review` : null,
    usd(b.cost_usd),
    b.checks != null ? `${b.checks} checks / ${b.steps ?? "?"} steps` : null,
    b.error ? `error: ${b.error.slice(0, 120)}` : null,
    `\n      ${b.instance_id}${b.batch_id ? `  ${b.batch_id}` : ""}`,
  ]
    .filter(Boolean)
    .join(" · ")
    .replace(" · \n", "\n");
};

const switchReview = async ({
  book,
  enabled,
}: {
  book: BookWithStatus;
  enabled: boolean;
}) => {
  if (opts.yes && opts["new-only"]) {
    throw new UsageError("pass --yes or --new-only, not both");
  }
  let pending: FileStatus[] = [];
  let estimate = "";
  let queueExisting = false;
  if (enabled) {
    pending = reviewablePages({
      files: await fetchStatus(book.id),
      all: false,
    });
    if (pending.length > 0 && !opts["new-only"]) {
      estimate = await estimateLine(pending.length);
      queueExisting = await confirm({
        question: `${book.title} has ${pending.length} done pages not reviewed yet. Queue them too? ${estimate}`,
        refusal: `${book.title} has ${pending.length} done pages not reviewed yet (${estimate}). Pass --yes to turn review on and queue them, or --new-only to review only pages OCR'd from now on.`,
      });
    }
  }
  const { book: updated } = await request<UpdateBookResponse>({
    service: "api",
    path: bookPath(book.id),
    method: "PATCH",
    body: { review_enabled: enabled },
  });
  const queuedRes = queueExisting
    ? await request<QueueReviewResponse>({
        service: "api",
        path: bookPath(book.id, "/review"),
        method: "POST",
      })
    : null;
  print({
    data: {
      book_id: updated.id,
      review_enabled: updated.review_enabled ?? false,
      existing_pages: pending.length,
      queued: queuedRes,
    },
    human: () =>
      !enabled
        ? `Review off for ${updated.title}. Waiting pages are dropped from the next batch (pages asked for one by one still run); a batch already submitted finishes.`
        : [
            `Review on for ${updated.title}: pages are reviewed as they finish OCR (a batch every 3 hours).`,
            queuedRes
              ? `Queued ${queuedRes.queued} existing pages${queuedRes.already_queued ? `, ${queuedRes.already_queued} already queued` : ""}${queuedRes.skipped_hand_edited ? `, ${queuedRes.skipped_hand_edited} hand-edited skipped` : ""}.`
              : pending.length > 0
                ? `${pending.length} done pages were not queued; \`corpus review ${updated.id} on --yes\` queues them.`
                : null,
          ]
            .filter(Boolean)
            .join("\n"),
  });
};

const reviewAll = async (book: BookWithStatus) => {
  const files = await fetchStatus(book.id);
  const pages = reviewablePages({ files, all: true });
  const handEdited = files.filter(
    (f) => f.state === "done" && f.text_edited_at !== null,
  ).length;
  if (pages.length === 0) {
    print({
      data: { queued: 0, skipped_hand_edited: handEdited, already_queued: 0 },
      human: () => `${book.title} has no done pages to review.`,
    });
    return;
  }
  const estimate = await estimateLine(pages.length);
  const go = await confirm({
    question: `Re-review all ${pages.length} done pages of ${book.title}${handEdited ? ` (${handEdited} hand-edited left out)` : ""}? ${estimate}`,
    refusal: `refusing to queue ${pages.length} pages of "${book.title}" for review without --yes (${estimate}).`,
  });
  if (!go) {
    console.error("Nothing queued.");
    return;
  }
  const res = await request<QueueReviewResponse>({
    service: "api",
    path: bookPath(book.id, "/review"),
    method: "POST",
    body: { all: true },
  });
  print({
    data: res,
    human: () =>
      `Queued ${res.queued} pages of ${book.title} for review${res.already_queued ? `; ${res.already_queued} already queued` : ""}${res.skipped_hand_edited ? `; ${res.skipped_hand_edited} hand-edited skipped` : ""}. The next batch picks them up (up to 100 pages per batch); watch with corpus jobs.`,
  });
};

const reviewPages = async ({
  book,
  refs,
}: {
  book: BookWithStatus;
  refs: string[];
}) => {
  const pages = resolvePages({ files: await fetchStatus(book.id), refs });
  const results: PageReviewResult[] = [];
  for (const page of pages) {
    try {
      const res = await request<QueuePageReviewResponse>({
        service: "api",
        path: bookPath(
          book.id,
          `/files/${encodeURIComponent(page.file_id)}/review`,
        ),
        method: "POST",
      });
      results.push({
        file_id: page.file_id,
        page_number: page.page_number,
        ...res,
        error: null,
      });
    } catch (err) {
      if (!(err instanceof HttpError) || ![404, 409].includes(err.status)) {
        throw err;
      }
      results.push({
        file_id: page.file_id,
        page_number: page.page_number,
        success: false,
        queued: false,
        already_queued: false,
        run_started: false,
        instance_id: null,
        error: err.message.replace(/^.*?→ \d{3}: /, ""),
      });
    }
  }
  print({
    data: results,
    human: () =>
      [
        ...results.map(
          (r) =>
            `  ${pageLabel(r)}  ${r.error ? `not queued: ${r.error}` : r.already_queued ? "already queued" : "queued"}`,
        ),
        results.some((r) => r.run_started)
          ? "Started a review run; watch it with corpus jobs."
          : results.some((r) => r.queued || r.already_queued)
            ? "A review run is already going; these pages join the next batch (corpus jobs)."
            : null,
      ]
        .filter(Boolean)
        .join("\n"),
  });
  if (results.some((r) => r.error)) process.exitCode = 1;
};

const reviewSummary = async () => {
  const book = opts.book ? await resolveBook(opts.book) : null;
  const days = parseDays();
  const s = await request<ReviewSummaryResponse>({
    service: "api",
    path: `/api/reviews/summary${windowQuery({ days, bookId: book?.id })}`,
  });
  const statuses = Object.entries(s.by_status)
    .map(([k, n]) => `${k} ${n}`)
    .join(" / ");
  const b = s.batches;
  print({
    data: s,
    human: () =>
      [
        `Reviews since ${timestamp(s.since).slice(0, 10)} (${book ? book.title : "all books"})`,
        `  ${s.pages_reviewed} pages reviewed · ${s.pages_changed} changed · ${s.pages_not_reviewed} tries without a review · ${s.pages_skipped} not applied (page changed meanwhile)`,
        statuses ? `  status: ${statuses}` : null,
        `  words: ${s.words.added} added, ${s.words.removed} removed${s.text_changed_share != null ? ` · ${(s.text_changed_share * 100).toFixed(2)}% of text changed` : ""}`,
        `  cost ${usd(s.cost_usd)}${s.cost_per_page_usd != null ? ` (${perPage(s.cost_per_page_usd)})` : ""}${s.hand_edited_after_review ? ` · ${s.hand_edited_after_review} pages hand-edited after review` : ""}`,
        `Batches started in the window (all books): ${b.count}${b.pages_avg != null ? `, avg ${b.pages_avg.toFixed(1)} pages` : ""}`,
        b.count
          ? [
              `  duration p50 ${formatDuration(b.duration_ms.p50)} · p90 ${formatDuration(b.duration_ms.p90)} · max ${formatDuration(b.duration_ms.max)}`,
              `  polling lag p50 ${formatDuration(b.polling_lag_ms.p50)} · max ${formatDuration(b.polling_lag_ms.max)}`,
              `  checks avg ${b.checks.avg?.toFixed(1) ?? "-"} / max ${b.checks.max ?? "-"} · steps avg ${b.steps.avg?.toFixed(1) ?? "-"} / max ${b.steps.max ?? "-"}`,
            ].join("\n")
          : null,
      ]
        .filter(Boolean)
        .join("\n"),
  });
};

const pageReviews = async ({
  book,
  ref,
}: {
  book: BookWithStatus;
  ref: string;
}) => {
  const pages = resolvePages({
    files: await fetchStatus(book.id),
    refs: [ref],
  });
  const histories: { page: FileStatus; reviews: PageReview[] }[] = [];
  for (const page of pages) {
    const res = await request<PageReviewsResponse>({
      service: "api",
      path: bookPath(
        book.id,
        `/files/${encodeURIComponent(page.file_id)}/reviews`,
      ),
    });
    histories.push({ page, reviews: res.reviews });
  }
  print({
    data: histories.map(({ page, reviews }) => ({
      file_id: page.file_id,
      page_number: page.page_number,
      hand_edited: page.text_edited_at !== null,
      reviews,
    })),
    human: () =>
      histories
        .map(({ page, reviews }) =>
          [
            `${pageLabel(page)}${page.text_edited_at !== null ? "  (hand-edited: no further reviews)" : ""}`,
            reviews.length === 0
              ? "  not reviewed yet"
              : reviews
                  .map((r) =>
                    [
                      `  ${timestamp(r.created_at)}  ${r.status}  ${r.model} (${r.effort})${r.attempt ? ` try ${r.attempt + 1}` : ""}  ${reviewChange(r)}  ${usd(r.cost_usd)}${r.revision_id != null ? `  rev ${r.revision_id}` : ""}`,
                      r.error
                        ? `      ${r.error_type ? `${r.error_type}: ` : ""}${r.error.slice(0, 160)}`
                        : null,
                      ...r.edits.map(
                        (e) =>
                          `      ${e.applied ? "applied" : "skipped"}  [${e.category}]  ${JSON.stringify(e.find)} → ${JSON.stringify(e.replace)}`,
                      ),
                    ]
                      .filter(Boolean)
                      .join("\n"),
                  )
                  .join("\n"),
          ].join("\n"),
        )
        .join("\n\n") +
      "\n(text before a review: corpus text <book> <fileId> --rev <rev>)",
  });
};

const commands: Record<string, (args: string[]) => Promise<void>> = {
  async auth([sub]) {
    print(
      await authCommand({
        sub,
        options: {
          url: opts.url,
          keyStdin: opts["key-stdin"],
          meiliUrl: opts["meili-url"],
          meiliKeyStdin: opts["meili-key-stdin"],
          onePassword: opts["1password"],
        },
      }),
    );
  },

  async books() {
    const books = await listBooks();
    print({
      data: books,
      human: () =>
        books
          .map(
            (b) =>
              `${b.id}  ${b.title}${b.paused ? "  [paused]" : ""}${b.ocr_engine ? `  [${b.ocr_engine}]` : ""}\n    ${b.files_total} pages · ${countsLine(b.counts)}`,
          )
          .join("\n"),
    });
  },

  async show([ref]) {
    const { id } = await resolveBook(need(ref, "<book>"));
    const { book } = await request<FetchBookResponse>({
      service: "api",
      path: bookPath(id),
    });
    print({
      data: book,
      human: () =>
        [
          `${book.title}  (${book.id})${book.paused ? "  [paused]" : ""}`,
          `${book.files_total} pages · ${countsLine(book.counts)}`,
          costLine(book.usage),
          `OCR engine ${engineLabel(book.ocr_engine)}`,
          `Review ${book.review_enabled ? `on (effort ${book.review_effort ?? "low"})` : "off"}`,
          book.work_id ? `work ${book.work_id}` : null,
          book.ocr_instructions
            ? `instructions:\n  ${book.ocr_instructions.replace(/\n/g, "\n  ")}`
            : null,
        ]
          .filter(Boolean)
          .join("\n"),
    });
  },

  async create() {
    const body = {
      title: need(opts.title, "--title"),
      ...(opts.id ? { id: opts.id } : {}),
      ...(opts.instructions ? { ocr_instructions: opts.instructions } : {}),
      ...(opts.work ? { work_id: opts.work } : {}),
      ...(opts.engine ? { ocr_engine: parseEngine(opts.engine) } : {}),
    };
    const { book } = await request<CreateBookResponse>({
      service: "api",
      path: "/api/books",
      method: "POST",
      body,
    });
    print({ data: book, human: () => `Created ${book.id}  ${book.title}` });
  },

  async engine([ref, value]) {
    const book = await resolveBook(need(ref, "<book>"));
    const choice = need(value, "<inkling|claude|default>");
    const ocr_engine = choice === "default" ? null : parseEngine(choice);
    const { book: updated } = await request<UpdateBookResponse>({
      service: "api",
      path: bookPath(book.id),
      method: "PATCH",
      body: { ocr_engine },
    });
    print({
      data: updated,
      human: () =>
        `OCR engine for ${updated.title}: ${engineLabel(updated.ocr_engine)}. Done pages keep their text; \`corpus retry ${updated.id} --states done\` re-OCRs them (overwriting hand edits).`,
    });
  },

  async delete([ref]) {
    const book = await resolveBook(need(ref, "<book>"));
    if (!opts.yes) {
      throw new UsageError(
        `refusing to delete "${book.title}" (${book.id}, ${book.files_total} pages) without --yes. This removes its scans and text permanently.`,
      );
    }
    const { deleted } = await request<DeleteBookResponse>({
      service: "api",
      path: bookPath(book.id),
      method: "DELETE",
    });
    print({
      data: deleted,
      human: () =>
        `Deleted ${book.title}: ${deleted.files} pages, ${deleted.r2_objects} stored files.`,
    });
  },

  async pause([ref]) {
    const book = await resolveBook(need(ref, "<book>"));
    const res = await request<PauseBookResponse>({
      service: "api",
      path: bookPath(book.id, "/pause"),
      method: "POST",
    });
    print({ data: res, human: () => `Paused OCR for ${book.title}.` });
  },

  async resume([ref]) {
    const book = await resolveBook(need(ref, "<book>"));
    const res = await request<ResumeBookResponse>({
      service: "api",
      path: bookPath(book.id, "/resume"),
      method: "POST",
    });
    print({
      data: res,
      human: () =>
        `Resumed OCR for ${book.title}; ${res.requeued} pages re-queued.`,
    });
  },

  async status([ref]) {
    const book = await resolveBook(need(ref, "<book>"));
    const { files } = await request<BookStatusResponse>({
      service: "api",
      path: bookPath(book.id, "/status"),
    });
    const shown = opts.state
      ? files.filter((f) => f.state === opts.state)
      : files;
    const edited = files.filter((f) => f.text_edited_at !== null).length;
    print({
      data: shown,
      human: () =>
        [
          `${book.title}: ${countsLine(book.counts)}${book.paused ? "  [paused]" : ""}${edited ? `  ${edited} hand-edited` : ""}`,
          // Without --state: the pages that need attention (failed) or that a
          // re-OCR would overwrite (hand-edited).
          ...shown
            .filter(
              (f) =>
                opts.state || f.state === "failed" || f.text_edited_at !== null,
            )
            .map(
              (f) =>
                `  p${f.page_number ?? "?"}  ${f.state}${f.text_edited_at !== null ? " (edited)" : ""}  ${f.file_id}${f.error ? `  ${shortError(f.error)}` : ""}`,
            ),
        ].join("\n"),
    });
  },

  async retry([ref]) {
    const book = await resolveBook(need(ref, "<book>"));
    const states = opts.states?.split(",").map((s) => s.trim());
    const res = await request<{ requeued: number; states: string[] }>({
      service: "api",
      path: bookPath(book.id, "/requeue"),
      method: "POST",
      body: states ? { states } : {},
    });
    print({
      data: res,
      human: () =>
        `Re-queued ${res.requeued} pages (${res.states.join(", ")}) of ${book.title}.`,
    });
  },

  async ocr([ref, ...fileIds]) {
    const book = await resolveBook(need(ref, "<book>"));
    if (fileIds.length === 0) throw new UsageError("missing <fileId>");
    const since = Date.now() - 60_000;
    for (const fileId of fileIds) {
      await request({
        service: "api",
        path: bookPath(book.id, `/files/${encodeURIComponent(fileId)}/ocr`),
        method: "POST",
      });
    }
    // OCR runs on the queue; wait for these pages using cheap delta reads.
    const wanted = new Set(fileIds);
    const latest = new Map<string, FileStatus>();
    const deadline = Date.now() + OCR_WAIT_MS;
    const settled = (f?: FileStatus) =>
      f != null && !["queued", "processing", "rate_limited"].includes(f.state);
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5_000));
      const { files } = await request<BookStatusResponse>({
        service: "api",
        path: bookPath(book.id, `/status?since=${since}`),
      });
      for (const f of files)
        if (wanted.has(f.file_id)) latest.set(f.file_id, f);
      if (fileIds.every((id) => settled(latest.get(id)))) break;
    }
    const results = fileIds.map((id) => {
      const f = latest.get(id);
      const detail = !settled(f)
        ? "still running; check `corpus status`"
        : f?.state === "failed"
          ? shortError(f.error ?? "")
          : f?.preview === ""
            ? "blank page"
            : (f?.preview ?? "").slice(0, 40);
      return {
        file_id: id,
        page_number: f?.page_number ?? null,
        state: f?.state ?? "queued",
        detail,
      };
    });
    print({
      data: results,
      human: () =>
        results
          .map(
            (r) =>
              `  p${r.page_number ?? "?"}  ${r.state}  ${r.file_id}  ${r.detail}`,
          )
          .join("\n"),
    });
    if (results.some((r) => r.state === "failed")) process.exitCode = 1;
  },

  async export([ref]) {
    const book = await resolveBook(need(ref, "<book>"));
    const files: BookExportResponse["files"] = [];
    let cursor: string | null = null;
    do {
      const query = `?limit=${EXPORT_BATCH}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const res: BookExportResponse = await request<BookExportResponse>({
        service: "api",
        path: bookPath(book.id, `/export${query}`),
      });
      files.push(...res.files);
      cursor = res.next_cursor ?? null;
      if (process.stderr.isTTY && res.files_total !== undefined) {
        process.stderr.write(`\rexported ${files.length}/${res.files_total}`);
      }
    } while (cursor);
    if (process.stderr.isTTY) process.stderr.write("\n");
    console.log(
      JSON.stringify(
        { success: true, book_id: book.id, files, title: book.title },
        null,
        2,
      ),
    );
  },

  async text([ref, fileId]) {
    const book = await resolveBook(need(ref, "<book>"));
    const rev = opts.rev ? `?rev=${encodeURIComponent(opts.rev)}` : "";
    const text = await requestText({
      service: "api",
      path: bookPath(
        book.id,
        `/files/${encodeURIComponent(need(fileId, "<fileId>"))}/text${rev}`,
      ),
    });
    print({
      data: { file_id: fileId, rev: opts.rev ?? null, text },
      human: () => text,
    });
  },

  async edit([ref, fileId]) {
    const book = await resolveBook(need(ref, "<book>"));
    const id = need(fileId, "<fileId>");
    const edits = readEdits();
    const res = await request<EditTextResponse>({
      service: "api",
      method: "PATCH",
      path: bookPath(book.id, `/files/${encodeURIComponent(id)}/text`),
      body: { edits, ...(opts.note ? { note: opts.note } : {}) },
    });
    print({
      data: res,
      human: () =>
        res.changed
          ? `Edited ${id} (${edits.length} edit${edits.length === 1 ? "" : "s"}); previous text is revision ${res.revision_id} (corpus text ${ref} ${id} --rev ${res.revision_id}).`
          : `No change: the edits left ${id} as it was.`,
    });
  },

  async history([ref, fileId]) {
    const book = await resolveBook(need(ref, "<book>"));
    const id = need(fileId, "<fileId>");
    const res = await request<TextHistoryResponse>({
      service: "api",
      path: bookPath(book.id, `/files/${encodeURIComponent(id)}/text/history`),
    });
    print({
      data: res,
      human: () =>
        res.revisions.length === 0
          ? `No changes to ${id} yet.`
          : res.revisions
              .map(
                (r) =>
                  `#${r.id}  ${new Date(r.created_at).toISOString().slice(0, 16).replace("T", " ")}  ${r.change}${r.model ? ` (${r.model})` : ""}${r.note ? `  ${r.note}` : ""}`,
              )
              .join("\n") +
            "\n(each entry's text before the change: corpus text <book> <fileId> --rev <id>)",
    });
  },

  async review([ref, ...rest]) {
    const book = await resolveBook(need(ref, "<book>"));
    const [first] = rest;
    if (opts.all) {
      if (rest.length > 0) {
        throw new UsageError("--all reviews every page; don't list pages");
      }
      await reviewAll(book);
      return;
    }
    if (rest.length === 1 && (first === "on" || first === "off")) {
      await switchReview({ book, enabled: first === "on" });
      return;
    }
    if (rest.length === 0) {
      throw new UsageError(
        "usage: corpus review <book> on|off | --all | <fileId|page...>",
      );
    }
    await reviewPages({ book, refs: rest });
  },

  async reviews([ref, page]) {
    if (!ref) {
      await reviewSummary();
      return;
    }
    const book = await resolveBook(ref);
    await pageReviews({ book, ref: need(page, "<fileId|page>") });
  },

  async spend() {
    const book = opts.book ? await resolveBook(opts.book) : null;
    const s = await request<SpendResponse>({
      service: "api",
      path: `/api/spend${windowQuery({ days: parseDays(), bookId: book?.id })}`,
    });
    const byKind = (kind: "ocr" | "review") =>
      s.by_model
        .filter((m) => m.kind === kind)
        .reduce((sum, m) => sum + m.cost_usd, 0);
    print({
      data: s,
      human: () =>
        [
          `Spend since ${s.since_day} (${book ? book.title : "all books"}): ${usd(s.total_cost_usd)} · OCR ${usd(byKind("ocr"))} · review ${usd(byKind("review"))}`,
          "By model",
          ...s.by_model.map(
            (m) =>
              `  ${m.kind.padEnd(6)}  ${m.model.padEnd(28)}  ${usd(m.cost_usd).padStart(8)}  ${m.pages} pages · ${m.calls} calls · ${m.input_tokens + m.cache_read_input_tokens + m.cache_creation_input_tokens} in / ${m.output_tokens} out tokens`,
          ),
          "Daily (UTC)",
          ...(s.daily.length === 0
            ? ["  no spend"]
            : s.daily.map(
                (d) =>
                  `  ${d.day}  OCR ${usd(d.ocr_cost_usd).padStart(7)}  review ${usd(d.review_cost_usd).padStart(7)}`,
              )),
          ...(s.top_books.length === 0
            ? []
            : [
                "Top books",
                ...s.top_books.map(
                  (b) =>
                    `  ${b.kind.padEnd(6)}  ${usd(b.cost_usd).padStart(8)}  ${b.pages} pages  ${b.title ?? b.book_id}  (${b.book_id})`,
                ),
              ]),
        ].join("\n"),
    });
  },

  async jobs() {
    const j = await request<JobsResponse>({
      service: "api",
      path: "/api/jobs",
    });
    const { ocr, review, failed } = j;
    print({
      data: j,
      human: () =>
        [
          `OCR (recent runs since ${ago(ocr.recent_since)})`,
          ...(ocr.books.length === 0
            ? ["  idle"]
            : ocr.books.map(
                (b) =>
                  `  ${b.title}  (${b.book_id})${b.paused ? "  [paused]" : ""}\n    queued ${b.queued} · processing ${b.processing} · rate_limited ${b.rate_limited} · failed ${b.failed}${b.oldest_queued_at != null ? ` · oldest queued ${ago(b.oldest_queued_at)}` : ""} · done last hour ${b.done_last_hour} · runs ${b.recent_runs} (fell back ${b.fell_back}, retried ${b.retried})`,
              )),
          ...(ocr.problem_pages.length === 0
            ? []
            : [
                "Problem OCR runs (fell back, failed, or third delivery+)",
                ...ocr.problem_pages.map(
                  (p) =>
                    `  ${p.status}  ${p.file_id}  ${p.book_id}  ${ago(p.created_at)}${p.final_model ? `  ${p.final_model}` : ""}${p.fell_back ? `  fell back${p.fallback_reason ? `: ${p.fallback_reason}` : ""}` : ""}${p.delivery_attempt > 1 ? `  delivery ${p.delivery_attempt}` : ""}${p.error_type ? `  ${p.error_type}` : ""}`,
                ),
              ]),
          "Review batches in flight",
          ...(review.in_flight.length === 0
            ? ["  none"]
            : review.in_flight.map(batchLine)),
          ...(review.waiting.length === 0
            ? []
            : [
                "Waiting for the next batch",
                ...review.waiting.map(
                  (w) =>
                    `  ${w.pages} pages  ${w.title}  (${w.book_id})${w.retrying ? `  ${w.retrying} retrying` : ""}`,
                ),
              ]),
          "Recent review batches",
          ...(review.recent.length === 0
            ? ["  none"]
            : review.recent.map(batchLine)),
          `Gave up (${failed.count} unresolved)`,
          ...failed.recent.map(
            (f) =>
              `  ${f.kind}  ${f.book_title ?? f.book_id ?? "-"}${f.page_number != null ? ` p${f.page_number}` : ""}${f.file_id ? `  ${f.file_id}` : ""}  ${f.attempts} attempts, last ${ago(f.last_failed_at)}${f.error ? `\n      ${shortError(f.error)}` : ""}`,
          ),
        ].join("\n"),
    });
  },

  async search(words) {
    const q = need(words.join(" ").trim(), "<query>");
    const ratio = opts.ratio === undefined ? 0.5 : Number(opts.ratio);
    if (!(ratio >= 0 && ratio <= 1)) throw new UsageError("--ratio is 0..1");
    const limit = opts.limit === undefined ? 20 : Number(opts.limit);
    const book = opts.book ? await resolveBook(opts.book) : null;
    const res = await request<{ hits: SearchHit[] }>({
      service: "meili",
      path: "/indexes/books/search",
      method: "POST",
      body: {
        q,
        hybrid: { embedder: "cfbge", semanticRatio: ratio },
        limit,
        attributesToRetrieve: [
          "file_id",
          "book_id",
          "book_title",
          "page_number",
        ],
        attributesToCrop: ["text"],
        cropLength: 40,
        ...(book
          ? { filter: `book_id = '${book.id.replace(/'/g, "\\'")}'` }
          : {}),
      },
    });
    const hits = res.hits.map((h) => ({
      file_id: h.file_id,
      book_id: h.book_id,
      book_title: h.book_title,
      page_number: h.page_number,
      snippet: cleanSnippet(h._formatted?.text ?? ""),
    }));
    print({
      data: hits,
      human: () =>
        hits.length === 0
          ? "No results. Try a concrete phrase instead of a category word."
          : hits
              .map(
                (h) =>
                  `${h.book_title} · ص ${h.page_number ?? "?"}  (${h.file_id})\n    ${h.snippet}`,
              )
              .join("\n"),
    });
  },
};

const main = async () => {
  const [name, ...args] = positionals;
  if (opts.version) {
    console.log(VERSION);
    return;
  }
  if (opts.help || !name) {
    console.log(USAGE);
    return;
  }
  const command = commands[name];
  if (!command) throw new UsageError(`unknown command "${name}"`);
  await command(args);
};

main().catch((err: unknown) => {
  if (err instanceof UsageError) {
    console.error(`corpus: ${err.message}\nRun \`corpus --help\` for usage.`);
    process.exit(2);
  }
  // Some fetch network errors carry the reason in `cause`.
  const cause =
    err instanceof Error && err.cause instanceof Error
      ? ` (${(err.cause as NodeJS.ErrnoException).code ?? err.cause.message})`
      : "";
  console.error(
    `corpus: ${err instanceof HttpError || err instanceof Error ? err.message : String(err)}${cause}`,
  );
  process.exit(1);
});
