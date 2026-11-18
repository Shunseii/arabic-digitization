#!/usr/bin/env -S node --no-warnings
import { parseArgs } from "node:util";
import type {
  BookExportResponse,
  BookStatusResponse,
  BookWithStatus,
  CreateBookResponse,
  DeleteBookResponse,
  FetchBookResponse,
  ListBooksResponse,
  PauseBookResponse,
  ResumeBookResponse,
} from "@qiraa/shared";
import { HttpError, request, requestText } from "./http.ts";
import { cacheStatus, clearCache, loadSecrets } from "./secrets.ts";

const USAGE = `corpus: the Arabic digitization corpus from the command line

Secrets come from 1Password once, then a RAM-only cache (see \`corpus auth\`).
<book> is a book id or (part of) its title.

Auth
  corpus auth login               read secrets from 1Password and cache them
  corpus auth status              show whether secrets are cached and until when
  corpus auth logout              wipe the cache

Books
  corpus books                    list books with per-state page counts
  corpus show <book>              one book: counts, OCR cost, paused, instructions
  corpus create --title <t> [--id <slug>] [--instructions <text>] [--work <id>]
  corpus delete <book> --yes      delete a book and all its pages (irreversible)
  corpus pause <book>             stop OCR for this book only
  corpus resume <book>            resume OCR and re-queue its waiting pages

OCR
  corpus status <book> [--state <s>]      per-page states (filter, e.g. failed)
  corpus retry <book> [--states a,b]      re-queue pages (default failed,rate_limited)
  corpus ocr <book> <fileId...>           re-run OCR on specific pages now (waits)
  corpus export <book>                    all pages + text as JSON
  corpus text <book> <fileId>             one page's Markdown transcription

Search
  corpus search <query> [--book <book>] [--ratio 0..1] [--limit n]
                                  hybrid search; ratio 0 = keyword, 1 = semantic

Options
  --json    machine-readable output (every command)
  --help    this help
`;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    json: { type: "boolean", default: false },
    yes: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
    title: { type: "string" },
    id: { type: "string" },
    instructions: { type: "string" },
    work: { type: "string" },
    state: { type: "string" },
    states: { type: "string" },
    book: { type: "string" },
    ratio: { type: "string" },
    limit: { type: "string" },
  },
});

class UsageError extends Error {}

const print = ({ data, human }: { data: unknown; human: () => string }) => {
  console.log(opts.json ? JSON.stringify(data, null, 2) : human());
};

const need = (value: string | undefined, what: string): string => {
  if (!value) throw new UsageError(`missing ${what}`);
  return value;
};

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

// Gemini errors embed the whole response JSON; the finish reason is the useful bit.
const shortError = (error: string): string => {
  const reason = /"finishReason":\s*"([A-Z_]+)"/.exec(error)?.[1];
  return reason ? `no text (${reason})` : error.slice(0, 120);
};

const cleanSnippet = (text: string): string =>
  text
    .replace(/__\/?ais-highlight__/g, "")
    .replace(/<\/?(ruby|rt|rp|em|mark)>/g, "")
    .replace(/[*_#>`]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const commands: Record<string, (args: string[]) => Promise<void>> = {
  async auth([sub]) {
    if (sub === "login") {
      const { source } = await loadSecrets({ refresh: true });
      const status = cacheStatus();
      print({
        data: { source, ...status },
        human: () =>
          source === "env"
            ? "Using secrets from environment variables; nothing cached."
            : `Secrets cached in RAM until ${status.expiresAt}.`,
      });
      return;
    }
    if (sub === "status") {
      const status = cacheStatus();
      print({
        data: status,
        human: () =>
          status.envOverride
            ? "Secrets come from environment variables."
            : status.cached
              ? `Cached until ${status.expiresAt} (${status.path}).`
              : "Not cached. The next command reads 1Password once (or run `corpus auth login`).",
      });
      return;
    }
    if (sub === "logout") {
      const removed = clearCache();
      print({
        data: { removed },
        human: () => (removed ? "Secret cache wiped." : "Nothing cached."),
      });
      return;
    }
    throw new UsageError("usage: corpus auth login|status|logout");
  },

  async books() {
    const books = await listBooks();
    print({
      data: books,
      human: () =>
        books
          .map(
            (b) =>
              `${b.id}  ${b.title}${b.paused ? "  [paused]" : ""}\n    ${b.files_total} pages · ${countsLine(b.counts)}`,
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
          book.usage?.cost_usd != null
            ? `OCR cost $${book.usage.cost_usd.toFixed(2)}`
            : null,
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
    };
    const { book } = await request<CreateBookResponse>({
      service: "api",
      path: "/api/books",
      method: "POST",
      body,
    });
    print({ data: book, human: () => `Created ${book.id}  ${book.title}` });
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
    print({
      data: shown,
      human: () =>
        [
          `${book.title}: ${countsLine(book.counts)}${book.paused ? "  [paused]" : ""}`,
          ...shown
            .filter((f) => opts.state || f.state === "failed")
            .map(
              (f) =>
                `  p${f.page_number ?? "?"}  ${f.state}  ${f.file_id}${f.error ? `  ${shortError(f.error)}` : ""}`,
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
    const results: { file_id: string; ok: boolean; detail: string }[] = [];
    // One at a time: each call runs OCR synchronously on the server.
    for (const fileId of fileIds) {
      try {
        const res = await request<{ text: string; model: string }>({
          service: "api",
          path: bookPath(book.id, `/files/${encodeURIComponent(fileId)}/ocr`),
          method: "POST",
        });
        results.push({
          file_id: fileId,
          ok: true,
          detail:
            res.text.trim() === "" ? "blank page" : `${res.text.length} chars`,
        });
      } catch (err) {
        results.push({
          file_id: fileId,
          ok: false,
          detail: shortError(err instanceof Error ? err.message : String(err)),
        });
      }
    }
    print({
      data: results,
      human: () =>
        results
          .map(
            (r) => `${r.ok ? "done  " : "failed"}  ${r.file_id}  ${r.detail}`,
          )
          .join("\n"),
    });
    if (results.some((r) => !r.ok)) process.exitCode = 1;
  },

  async export([ref]) {
    const book = await resolveBook(need(ref, "<book>"));
    const res = await request<BookExportResponse>({
      service: "api",
      path: bookPath(book.id, "/export"),
    });
    console.log(JSON.stringify({ ...res, title: book.title }, null, 2));
  },

  async text([ref, fileId]) {
    const book = await resolveBook(need(ref, "<book>"));
    const text = await requestText({
      service: "api",
      path: bookPath(
        book.id,
        `/files/${encodeURIComponent(need(fileId, "<fileId>"))}/text`,
      ),
    });
    print({ data: { file_id: fileId, text }, human: () => text });
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
  console.error(
    `corpus: ${err instanceof HttpError || err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
