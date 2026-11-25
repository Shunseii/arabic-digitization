// HTTP contract of the Worker: every route, run end to end in workerd with
// real local bindings. These tests pin what clients (packages/cli,
// apps/mobile, apps/desktop, packages/shared, the llms.txt reference) rely on:
// status codes, JSON shapes, headers, queue messages, and how many D1/R2/KV
// operations the hot routes cost.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LLMS_TXT } from "../../src/docs";
import { costUsd } from "../../src/lib/cost";
import { hashQuery } from "../../src/lib/highlight";
import { signScanUrl } from "../../src/lib/scanUrl";
import {
  type Harness,
  MASTER_KEY,
  PUBLIC_API_URL,
  startHarness,
} from "./harness";
import {
  JPEG_BYTES,
  JSON_HEADERS,
  measured,
  postJson,
  scanKey,
  seedBook,
  seedFiles,
  seedWork,
  wideEvents,
} from "./support";

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
}, 60_000);

afterAll(() => h?.close());

const JSON_TYPE = "application/json";
const VALIDATION_TYPE = "application/json;charset=UTF-8";

async function expectValidationError({
  response,
  paths,
}: {
  response: Response;
  paths: string[][];
}) {
  expect(response.status).toBe(400);
  expect(response.headers.get("content-type")).toBe(VALIDATION_TYPE);
  const body = (await response.json()) as { errors: { path: string[] }[] };
  expect(body).toMatchObject({ success: false, result: {} });
  expect(body.errors.map((e) => e.path)).toEqual(expect.arrayContaining(paths));
  for (const error of body.errors) {
    expect(error).toEqual(
      expect.objectContaining({ code: 7001, message: expect.any(String) }),
    );
  }
}

async function expectError({
  response,
  status,
  error,
}: {
  response: Response;
  status: number;
  error: string;
}) {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toBe(JSON_TYPE);
  expect(await response.json()).toEqual({ success: false, error });
}

describe("auth, CORS and fallbacks", () => {
  it("rejects /api requests without the master key", async () => {
    const response = await h.fetch("/api/books");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    await expectError({ response, status: 401, error: "Unauthorized" });
  });

  it("rejects a wrong key, a key without the Bearer scheme, and a lowercase scheme", async () => {
    for (const authorization of [
      "Bearer wrong",
      MASTER_KEY,
      `bearer ${MASTER_KEY}`,
      `Bearer ${MASTER_KEY}x`,
      "Bearer ",
    ]) {
      const response = await h.fetch("/api/books", {
        headers: { Authorization: authorization },
      });
      await expectError({ response, status: 401, error: "Unauthorized" });
    }
  });

  it("rejects unknown /api paths without a key before routing", async () => {
    const response = await h.fetch("/api/nope");
    await expectError({ response, status: 401, error: "Unauthorized" });
  });

  it("answers an unknown authenticated /api path with a plain 404", async () => {
    const response = await h.api("/api/nope");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe(
      "text/plain; charset=UTF-8",
    );
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(await response.text()).toBe("404 Not Found");
  });

  it("answers a wrong method on a known path with 404", async () => {
    const response = await h.api("/api/books", { method: "PUT" });
    expect(response.status).toBe(404);
  });

  it("answers an unknown public path with a plain 404 and no CORS header", async () => {
    const response = await h.fetch("/nope");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe(
      "text/plain; charset=UTF-8",
    );
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(await response.text()).toBe("404 Not Found");
  });

  it("answers a CORS preflight without a key", async () => {
    const response = await h.fetch("/api/books/b1/files", {
      method: "OPTIONS",
      headers: {
        Origin: "http://tauri.localhost",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-methods")).toBe(
      "GET,POST,PATCH,DELETE,OPTIONS",
    );
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "Authorization,Content-Type",
    );
    expect(response.headers.get("access-control-max-age")).toBe("86400");
    expect(await response.text()).toBe("");
  });

  it("adds the CORS origin header to authenticated responses", async () => {
    const response = await h.api("/api/books", {
      headers: { Origin: "http://tauri.localhost" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("public routes", () => {
  it("serves llms.txt as Markdown", async () => {
    const response = await h.fetch("/llms.txt");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/markdown; charset=utf-8",
    );
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(await response.text()).toBe(LLMS_TXT);
  });

  it("serves the Swagger UI page at /", async () => {
    const response = await h.fetch("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/html/);
    const html = await response.text();
    expect(html).toContain("swagger-ui");
    expect(html).toContain("SwaggerUIBundle");
    expect(html).toContain("/openapi.json");
  });

  it("serves an OpenAPI document covering every API route", async () => {
    const response = await h.fetch("/openapi.json");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    const spec = (await response.json()) as {
      openapi: string;
      paths: Record<string, Record<string, unknown>>;
    };
    expect(spec.openapi).toMatch(/^3\./);
    const operations = Object.entries(spec.paths)
      .flatMap(([path, methods]) =>
        Object.keys(methods).map((m) => `${m.toUpperCase()} ${path}`),
      )
      .sort();
    expect(operations).toEqual(
      [
        "POST /api/books",
        "GET /api/books",
        "GET /api/books/{bookId}",
        "PATCH /api/books/{bookId}",
        "DELETE /api/books/{bookId}",
        "GET /api/books/{bookId}/status",
        "GET /api/files/recent",
        "GET /api/books/{bookId}/export",
        "POST /api/books/{bookId}/requeue",
        "POST /api/books/{bookId}/pause",
        "POST /api/books/{bookId}/resume",
        "POST /api/books/{bookId}/review",
        "POST /api/works",
        "GET /api/works",
        "GET /api/works/{workId}",
        "PATCH /api/works/{workId}",
        "DELETE /api/works/{workId}",
        "GET /api/tags",
        "POST /api/books/{bookId}/files",
        "PATCH /api/books/{bookId}/files/{fileId}",
        "DELETE /api/books/{bookId}/files/{fileId}",
        "POST /api/books/{bookId}/files/{fileId}/ocr",
        "GET /api/books/{bookId}/files/{fileId}/text",
        "PATCH /api/books/{bookId}/files/{fileId}/text",
        "GET /api/books/{bookId}/files/{fileId}/text/history",
        "POST /api/books/{bookId}/files/{fileId}/review",
        "GET /api/books/{bookId}/files/{fileId}/reviews",
        "GET /api/books/{bookId}/files/{fileId}/image",
        "POST /api/books/{bookId}/files/{fileId}/highlight",
        "POST /api/search/reindex",
        "GET /api/jobs",
        "GET /api/reviews/summary",
        "GET /api/spend",
        "POST /api/admin/ocr-runs/recompute-metrics",
      ].sort(),
    );
  });
});

describe("books", () => {
  it("creates a book with an auto-created work and its tags", async () => {
    const { response, counts, messages } = await measured({
      h,
      request: () =>
        postJson({
          h,
          path: "/api/books",
          body: {
            title: "كتاب التوحيد",
            id: "create-1",
            ocr_instructions: "two columns",
            ocr_engine: "claude",
            tags: ["عقيدة", "متن"],
            ignored_field: true,
          },
        }),
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toBe(JSON_TYPE);
    expect(messages).toEqual([]);
    expect(counts.d1RoundTrips).toBe(4);

    const fetched = await (await h.api("/api/books/create-1")).json();
    expect(fetched).toMatchObject({
      book: {
        id: "create-1",
        title: "كتاب التوحيد",
        ocr_instructions: "two columns",
        ocr_engine: "claude",
      },
    });
    const workId = (fetched as { book: { work_id: string } }).book.work_id;
    const work = await (await h.api(`/api/works/${workId}`)).json();
    expect(work).toEqual({
      success: true,
      work: {
        id: workId,
        name: "كتاب التوحيد",
        author: null,
        created_at: expect.any(Number),
        tags: ["عقيدة", "متن"],
      },
    });
  });

  it("returns the created book", async () => {
    const response = await postJson({
      h,
      path: "/api/books",
      body: { title: "Plain" },
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      success: true,
      book: {
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        title: "Plain",
        created_at: expect.any(Number),
        ocr_instructions: null,
        ocr_engine: null,
        work_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      },
    });
  });

  it("attaches a new copy to an existing work", async () => {
    await seedWork({ h, id: "work-attach" });
    const response = await postJson({
      h,
      path: "/api/books",
      body: {
        title: "Copy",
        id: "copy-attach",
        work_id: "work-attach",
        tags: ["x"],
      },
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      book: { id: "copy-attach", work_id: "work-attach" },
    });
    const tags = await h.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM work_tags WHERE work_id = ?",
      ["work-attach"],
    );
    expect(tags[0]?.n).toBe(0);
  });

  it("refuses a duplicate book id with 409", async () => {
    await seedBook({ h, id: "dup-book" });
    const response = await postJson({
      h,
      path: "/api/books",
      body: { title: "Again", id: "dup-book" },
    });
    await expectError({
      response,
      status: 409,
      error: "Book 'dup-book' already exists",
    });
  });

  it("validates the create body", async () => {
    await expectValidationError({
      response: await postJson({ h, path: "/api/books", body: {} }),
      paths: [["body", "title"]],
    });
    await expectValidationError({
      response: await postJson({ h, path: "/api/books", body: { title: "" } }),
      paths: [["body", "title"]],
    });
    await expectValidationError({
      response: await postJson({
        h,
        path: "/api/books",
        body: { title: "t", id: "Not A Slug" },
      }),
      paths: [["body", "id"]],
    });
    await expectValidationError({
      response: await postJson({
        h,
        path: "/api/books",
        body: { title: "t", ocr_engine: "gemini" },
      }),
      paths: [["body", "ocr_engine"]],
    });
    const notJson = await h.api("/api/books", {
      method: "POST",
      headers: JSON_HEADERS,
      body: "{not json",
    });
    expect(notJson.status).toBe(400);
    expect(notJson.headers.get("content-type")).toBe(VALIDATION_TYPE);
    expect(await notJson.json()).toMatchObject({ success: false, result: {} });
  });

  it("lists books newest first with per-state counts, in one D1 query", async () => {
    await seedWork({ h, id: "list-work" });
    await seedBook({
      h,
      id: "list-old",
      title: "Old",
      createdAt: 4_000_000_000_000,
      workId: "list-work",
      ocrEngine: "inkling",
      ocrInstructions: "never listed",
    });
    await seedBook({
      h,
      id: "list-new",
      title: "New",
      createdAt: 4_000_000_000_001,
      paused: true,
    });
    await seedFiles({
      h,
      bookId: "list-old",
      files: [
        { fileId: "lo-1", text: "a" },
        { fileId: "lo-2", text: "b" },
        { fileId: "lo-3", state: "failed", error: "boom" },
      ],
    });

    const { response, counts } = await measured({
      h,
      request: () => h.api("/api/books"),
    });
    expect(response.status).toBe(200);
    expect(counts).toMatchObject({ d1Queries: 1, r2Reads: 0, kvReads: 0 });

    const { books } = (await (await h.api("/api/books")).json()) as {
      books: Record<string, unknown>[];
    };
    expect(books.slice(0, 2)).toEqual([
      {
        id: "list-new",
        title: "New",
        created_at: 4_000_000_000_001,
        work_id: null,
        ocr_engine: null,
        paused: true,
        files_total: 0,
        counts: {},
      },
      {
        id: "list-old",
        title: "Old",
        created_at: 4_000_000_000_000,
        work_id: "list-work",
        ocr_engine: "inkling",
        paused: false,
        files_total: 3,
        counts: { done: 2, failed: 1 },
      },
    ]);
  });

  it("fetches one book with counts and priced usage", async () => {
    await seedBook({
      h,
      id: "fetch-1",
      title: "Fetch",
      createdAt: 123,
      ocrInstructions: "notes",
      ocrEngine: "claude",
    });
    await seedFiles({
      h,
      bookId: "fetch-1",
      files: [
        {
          fileId: "f1-1",
          text: "x",
          inputTokens: 1000,
          outputTokens: 500,
          ocrModel: "inkling-2-small",
        },
        {
          fileId: "f1-2",
          text: "y",
          inputTokens: 2000,
          outputTokens: 100,
          ocrModel: "claude-sonnet-5-5",
        },
        { fileId: "f1-3", state: "queued" },
      ],
    });
    const { response, counts } = await measured({
      h,
      request: () => h.api("/api/books/fetch-1"),
    });
    expect(response.status).toBe(200);
    expect(counts).toMatchObject({ d1Queries: 4, r2Reads: 0 });
    const expectedCost =
      (costUsd({
        model: "inkling-2-small",
        inputTokens: 1000,
        outputTokens: 500,
      }) ?? 0) +
      (costUsd({
        model: "claude-sonnet-5-5",
        inputTokens: 2000,
        outputTokens: 100,
      }) ?? 0);
    const body = (await (await h.api("/api/books/fetch-1")).json()) as {
      book: { usage: { cost_usd: number } };
    };
    expect(body).toEqual({
      success: true,
      book: {
        id: "fetch-1",
        title: "Fetch",
        created_at: 123,
        ocr_instructions: "notes",
        ocr_engine: "claude",
        work_id: null,
        paused: false,
        review_enabled: false,
        review_effort: null,
        files_total: 3,
        counts: { done: 2, queued: 1 },
        usage: {
          input_tokens: 3000,
          output_tokens: 600,
          cost_usd: expect.any(Number),
          ocr: {
            cost_usd: 0,
            input_tokens: 0,
            output_tokens: 0,
            calls: 0,
            pages: 0,
          },
          review: {
            cost_usd: 0,
            input_tokens: 0,
            output_tokens: 0,
            calls: 0,
            pages: 0,
          },
          total_cost_usd: 0,
        },
      },
    });
    expect(body.book.usage.cost_usd).toBeCloseTo(expectedCost, 12);
  });

  it("reports null usage for a book without OCR usage, and null cost for an unpriced model", async () => {
    await seedBook({ h, id: "fetch-empty" });
    expect(await (await h.api("/api/books/fetch-empty")).json()).toMatchObject({
      book: { files_total: 0, counts: {}, usage: null },
    });
    await seedBook({ h, id: "fetch-unpriced" });
    await seedFiles({
      h,
      bookId: "fetch-unpriced",
      files: [
        {
          fileId: "fu-1",
          text: "x",
          inputTokens: 10,
          outputTokens: 5,
          ocrModel: "mystery-model",
        },
      ],
    });
    expect(
      await (await h.api("/api/books/fetch-unpriced")).json(),
    ).toMatchObject({
      book: { usage: { input_tokens: 10, output_tokens: 5, cost_usd: null } },
    });
  });

  it("queues done pages for review only once the book opts in", async () => {
    await seedBook({ h, id: "rev-1" });
    await seedFiles({
      h,
      bookId: "rev-1",
      files: [
        { fileId: "rev-done", text: "نص", preview: "نص" },
        { fileId: "rev-edited", text: "نص", preview: "نص", textEditedAt: 5 },
        { fileId: "rev-blank", text: "", preview: "" },
        { fileId: "rev-queued" },
      ],
    });
    await expectError({
      response: await h.api("/api/books/rev-1/review", { method: "POST" }),
      status: 409,
      error:
        "Review is off for this book; PATCH it with review_enabled: true first, or pass all: true for a one-off",
    });

    const patched = await postJson({
      h,
      method: "PATCH",
      path: "/api/books/rev-1",
      body: { review_enabled: true, review_effort: "medium" },
    });
    expect(await patched.json()).toMatchObject({
      book: { review_enabled: true, review_effort: "medium" },
    });
    const queued = await h.api("/api/books/rev-1/review", { method: "POST" });
    expect(await queued.json()).toEqual({
      success: true,
      queued: 1,
      skipped_hand_edited: 1,
      already_queued: 0,
    });
    expect(
      await h.query(
        "SELECT file_id, instance_id, requested FROM review_queue WHERE book_id = 'rev-1'",
      ),
    ).toEqual([{ file_id: "rev-done", instance_id: null, requested: 0 }]);
  });

  it("reviews every done page on demand, even with the book's review off", async () => {
    await seedBook({ h, id: "rev-all" });
    await seedFiles({
      h,
      bookId: "rev-all",
      files: [
        { fileId: "ra-new", text: "نص", preview: "نص" },
        { fileId: "ra-reviewed", text: "نص", preview: "نص" },
        { fileId: "ra-waiting", text: "نص", preview: "نص" },
        { fileId: "ra-in-batch", text: "نص", preview: "نص" },
        { fileId: "ra-edited", text: "نص", preview: "نص", textEditedAt: 5 },
        { fileId: "ra-blank", text: "", preview: "" },
        { fileId: "ra-queued-ocr" },
      ],
    });
    await h.sql([
      {
        sql: `INSERT INTO page_reviews (file_id, batch_id, book_id, created_at, model, effort, status)
              VALUES ('ra-reviewed', 'mb', 'rev-all', 1, 'claude-opus-5-5', 'low', 'applied')`,
      },
      {
        sql: `INSERT INTO review_queue (file_id, book_id, queued_at, instance_id, attempts, requested)
              VALUES ('ra-waiting', 'rev-all', 1, NULL, 2, 0),
                     ('ra-in-batch', 'rev-all', 1, 'review-9', 0, 0)`,
      },
    ]);
    const { response, counts } = await measured({
      h,
      request: () =>
        postJson({ h, path: "/api/books/rev-all/review", body: { all: true } }),
    });
    expect(counts).toMatchObject({ d1RoundTrips: 2 });
    expect(
      await (
        await postJson({
          h,
          path: "/api/books/rev-all/review",
          body: { all: true },
        })
      ).json(),
    ).toEqual({
      success: true,
      queued: 0,
      skipped_hand_edited: 1,
      already_queued: 4,
    });
    expect(response.status).toBe(200);
    expect(
      await h.query(
        "SELECT file_id, instance_id, attempts, requested FROM review_queue WHERE book_id = 'rev-all' ORDER BY file_id",
      ),
    ).toEqual([
      // Already in a running batch: left as it is.
      {
        file_id: "ra-in-batch",
        instance_id: "review-9",
        attempts: 0,
        requested: 0,
      },
      { file_id: "ra-new", instance_id: null, attempts: 0, requested: 1 },
      // Already reviewed: reviewed again.
      { file_id: "ra-reviewed", instance_id: null, attempts: 0, requested: 1 },
      // Already waiting: now asked for, with its tries reset.
      { file_id: "ra-waiting", instance_id: null, attempts: 0, requested: 1 },
    ]);
  });

  it("answers 404 for a missing book", async () => {
    await expectError({
      response: await h.api("/api/books/missing-book"),
      status: 404,
      error: "Book 'missing-book' not found",
    });
  });

  it("updates a book and reindexes it when its title changes", async () => {
    await seedBook({ h, id: "upd-1", title: "Before", createdAt: 55 });
    h.meili.calls.length = 0;
    const response = await postJson({
      h,
      method: "PATCH",
      path: "/api/books/upd-1",
      body: {
        title: "After",
        ocr_instructions: "new notes",
        ocr_engine: "claude",
      },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      book: {
        id: "upd-1",
        title: "After",
        created_at: 55,
        ocr_instructions: "new notes",
        ocr_engine: "claude",
        work_id: null,
        paused: false,
        review_enabled: false,
        review_effort: null,
      },
    });
    expect(h.meili.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /indexes/books/documents/delete",
    ]);
  });

  it("clears nullable book fields without reindexing", async () => {
    await seedBook({
      h,
      id: "upd-2",
      ocrInstructions: "x",
      ocrEngine: "claude",
    });
    h.meili.calls.length = 0;
    const response = await postJson({
      h,
      method: "PATCH",
      path: "/api/books/upd-2",
      body: { ocr_instructions: null, ocr_engine: null },
    });
    expect(await response.json()).toMatchObject({
      book: { ocr_instructions: null, ocr_engine: null },
    });
    expect(h.meili.calls).toEqual([]);
  });

  it("validates the update body and 404s a missing book", async () => {
    await seedBook({ h, id: "upd-3" });
    const empty = await postJson({
      h,
      method: "PATCH",
      path: "/api/books/upd-3",
      body: {},
    });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toMatchObject({ success: false, result: {} });
    await expectValidationError({
      response: await postJson({
        h,
        method: "PATCH",
        path: "/api/books/upd-3",
        body: { ocr_engine: "gemini" },
      }),
      paths: [["body", "ocr_engine"]],
    });
    await expectValidationError({
      response: await postJson({
        h,
        method: "PATCH",
        path: "/api/books/upd-3",
        body: { title: "" },
      }),
      paths: [["body", "title"]],
    });
    await expectError({
      response: await postJson({
        h,
        method: "PATCH",
        path: "/api/books/upd-missing",
        body: { title: "x" },
      }),
      status: 404,
      error: "Book 'upd-missing' not found",
    });
  });

  it("deletes a book with its files and R2 objects", async () => {
    await seedBook({ h, id: "del-1" });
    await seedFiles({
      h,
      bookId: "del-1",
      files: [
        { fileId: "d1-1", text: "x", scan: JPEG_BYTES },
        { fileId: "d1-2", scan: JPEG_BYTES },
      ],
    });
    h.meili.calls.length = 0;
    const response = await h.api("/api/books/del-1", { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      deleted: { book_id: "del-1", files: 2, r2_objects: 3 },
    });
    expect(await h.listObjects("books/del-1/")).toEqual([]);
    expect(
      await h.query("SELECT file_id FROM files WHERE book_id = ?", ["del-1"]),
    ).toEqual([]);
    expect(h.meili.calls.map((c) => c.path)).toEqual([
      "/indexes/books/documents/delete",
    ]);
    await expectError({
      response: await h.api("/api/books/del-1", { method: "DELETE" }),
      status: 404,
      error: "Book 'del-1' not found",
    });
  });
});

describe("book status", () => {
  const FILE_COUNT = 120;

  beforeAll(async () => {
    await seedBook({ h, id: "status-1" });
    await seedFiles({
      h,
      bookId: "status-1",
      files: Array.from({ length: FILE_COUNT }, (_, i) => ({
        fileId: `st-${String(i).padStart(4, "0")}`,
        state: i % 10 === 0 ? "failed" : "done",
        page: i % 7 === 0 ? null : FILE_COUNT - i,
        orderHint: i % 3,
        role: i % 2 ? "matn" : null,
        preview: `preview ${i}`,
        error: i % 10 === 0 ? "boom" : null,
        updatedAt: 1_000 + i,
        textEditedAt: i === 5 ? 9_999 : null,
        inputTokens: i % 10 === 0 ? null : 100 + i,
        outputTokens: i % 10 === 0 ? null : 50 + i,
        ocrModel: i % 10 === 0 ? null : i % 4 ? "inkling-2-small" : "unknown",
      })),
    });
  });

  it("lists every file in page order with usage and cost", async () => {
    const { response, counts } = await measured({
      h,
      request: () => h.api("/api/books/status-1/status"),
    });
    expect(response.status).toBe(200);
    expect(counts).toMatchObject({ d1Queries: 3, r2Reads: 0 });
    // The book lookup, the counters, then the book's files: D1 counts about
    // two rows read per file (index entry plus row).
    expect(counts.d1RowsRead).toBeLessThanOrEqual(2 * FILE_COUNT + 10);

    const body = (await (await h.api("/api/books/status-1/status")).json()) as {
      success: boolean;
      files_total: number;
      files: Record<string, unknown>[];
    };
    expect(body.success).toBe(true);
    expect(body.files_total).toBe(FILE_COUNT);
    expect(body.files).toHaveLength(FILE_COUNT);
    const pages = body.files.map((f) => f.page_number as number | null);
    const numbered = pages.filter((p): p is number => p !== null);
    expect(numbered).toEqual([...numbered].sort((a, b) => a - b));
    expect(pages.slice(numbered.length).every((p) => p === null)).toBe(true);

    const f5 = body.files.find((f) => f.file_id === "st-0005");
    expect(f5).toEqual({
      file_id: "st-0005",
      page_number: FILE_COUNT - 5,
      state: "done",
      role: "matn",
      order_hint: 2,
      preview: "preview 5",
      error: null,
      updated_at: 1_005,
      text_edited_at: 9_999,
      input_tokens: 105,
      output_tokens: 55,
      cost_usd: costUsd({
        model: "inkling-2-small",
        inputTokens: 105,
        outputTokens: 55,
      }),
      ocr_cost_usd: costUsd({
        model: "inkling-2-small",
        inputTokens: 105,
        outputTokens: 55,
      }),
      review_cost_usd: null,
    });
    expect(body.files.find((f) => f.file_id === "st-0000")).toMatchObject({
      state: "failed",
      error: "boom",
      input_tokens: null,
      output_tokens: null,
      cost_usd: null,
    });
    expect(body.files.find((f) => f.file_id === "st-0004")).toMatchObject({
      cost_usd: null,
    });
  });

  it("returns only files updated after `since`", async () => {
    const response = await h.api(
      `/api/books/status-1/status?since=${1_000 + FILE_COUNT - 3}`,
    );
    const body = (await response.json()) as {
      files: { file_id: string }[];
      files_total: number;
    };
    expect(body.files_total).toBe(FILE_COUNT);
    expect(body.files.map((f) => f.file_id).sort()).toEqual([
      `st-0${FILE_COUNT - 2}`,
      `st-0${FILE_COUNT - 1}`,
    ]);
  });

  it("reads only the changed files for a delta", async () => {
    const { counts } = await measured({
      h,
      request: () =>
        h.api(`/api/books/status-1/status?since=${1_000 + FILE_COUNT - 3}`),
    });
    // The book lookup, the counters, and the two changed files.
    expect(counts.d1RowsRead).toBeLessThanOrEqual(15);
  });

  it("validates since and 404s a missing book", async () => {
    for (const since of ["abc", "-1", "1.5"]) {
      await expectValidationError({
        response: await h.api(`/api/books/status-1/status?since=${since}`),
        paths: [["query", "since"]],
      });
    }
    await expectError({
      response: await h.api("/api/books/status-missing/status"),
      status: 404,
      error: "Book 'status-missing' not found",
    });
  });

  it("treats an empty since as 0", async () => {
    const response = await h.api("/api/books/status-1/status?since=");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { files: unknown[] };
    expect(body.files).toHaveLength(FILE_COUNT);
    await expectError({
      response: await h.api("/api/books/status-missing/status?since="),
      status: 404,
      error: "Book 'status-missing' not found",
    });
  });
});

describe("recent files", () => {
  // Newer than anything else seeded, so these are the newest files overall.
  const BASE = 9_000_000_000_000;

  beforeAll(async () => {
    await seedBook({ h, id: "recent-a", title: "كتاب أ" });
    await seedBook({ h, id: "recent-b", title: "كتاب ب" });
    await seedFiles({
      h,
      bookId: "recent-a",
      files: Array.from({ length: 60 }, (_, i) => ({
        fileId: `ra-${String(i).padStart(3, "0")}`,
        page: i + 1,
        updatedAt: BASE + 2 * i,
        state: "done",
        inputTokens: 100,
        outputTokens: 50,
        ocrModel: "inkling-2-small",
      })),
    });
    await seedFiles({
      h,
      bookId: "recent-b",
      files: [
        {
          fileId: "rb-new",
          page: null,
          updatedAt: BASE + 1_000,
          state: "failed",
          error: "boom",
        },
        { fileId: "rb-old", page: 3, updatedAt: BASE + 1, state: "queued" },
      ],
    });
  });

  it("lists the newest files across books with their book", async () => {
    const { response, counts } = await measured({
      h,
      request: () => h.api("/api/files/recent?limit=3"),
    });
    expect(response.status).toBe(200);
    // One query: an index walk over three files plus their books' rows,
    // not a scan of every file.
    expect(counts).toMatchObject({ d1Queries: 1, r2Reads: 0 });
    expect(counts.d1RowsRead).toBeLessThanOrEqual(12);

    const body = (await (await h.api("/api/files/recent?limit=3")).json()) as {
      success: boolean;
      files: Record<string, unknown>[];
    };
    expect(body.success).toBe(true);
    expect(body.files.map((f) => f.file_id)).toEqual([
      "rb-new",
      "ra-059",
      "ra-058",
    ]);
    expect(body.files[0]).toEqual({
      file_id: "rb-new",
      page_number: null,
      state: "failed",
      role: null,
      order_hint: null,
      preview: null,
      error: "boom",
      updated_at: BASE + 1_000,
      text_edited_at: null,
      input_tokens: null,
      output_tokens: null,
      cost_usd: null,
      ocr_cost_usd: null,
      review_cost_usd: null,
      book_id: "recent-b",
      book_title: "كتاب ب",
    });
    expect(body.files[1]).toMatchObject({
      book_id: "recent-a",
      book_title: "كتاب أ",
      page_number: 60,
      cost_usd: costUsd({
        model: "inkling-2-small",
        inputTokens: 100,
        outputTokens: 50,
      }),
    });
  });

  it("returns 25 files by default and validates limit", async () => {
    const body = (await (await h.api("/api/files/recent")).json()) as {
      files: { updated_at: number }[];
    };
    expect(body.files).toHaveLength(25);
    const times = body.files.map((f) => f.updated_at);
    expect(times).toEqual([...times].sort((a, b) => b - a));

    for (const limit of ["0", "101", "x"]) {
      await expectValidationError({
        response: await h.api(`/api/files/recent?limit=${limit}`),
        paths: [["query", "limit"]],
      });
    }
  });
});

describe("book export", () => {
  beforeAll(async () => {
    await seedBook({ h, id: "exp-1" });
    await seedFiles({
      h,
      bookId: "exp-1",
      files: [
        {
          fileId: "e-c",
          page: 2,
          orderHint: 1,
          text: "page two b",
          role: "matn",
        },
        { fileId: "e-a", page: 1, text: "page one" },
        { fileId: "e-b", page: 2, orderHint: 0, text: "page two a" },
        { fileId: "e-d", page: null, state: "queued" },
        { fileId: "e-e", page: null, text: "loose" },
      ],
    });
  });

  it("exports every file with its text in one response", async () => {
    const { response, counts } = await measured({
      h,
      request: () => h.api("/api/books/exp-1/export"),
    });
    expect(response.status).toBe(200);
    // Book check + files query, then one R2 read per transcribed file.
    expect(counts).toMatchObject({ d1Queries: 2, r2Reads: 4 });

    expect(await (await h.api("/api/books/exp-1/export")).json()).toEqual({
      success: true,
      book_id: "exp-1",
      files: [
        {
          file_id: "e-a",
          page_number: 1,
          role: null,
          order_hint: null,
          state: "done",
          text: "page one",
        },
        {
          file_id: "e-b",
          page_number: 2,
          role: null,
          order_hint: 0,
          state: "done",
          text: "page two a",
        },
        {
          file_id: "e-c",
          page_number: 2,
          role: "matn",
          order_hint: 1,
          state: "done",
          text: "page two b",
        },
        {
          file_id: "e-d",
          page_number: null,
          role: null,
          order_hint: null,
          state: "queued",
          text: null,
        },
        {
          file_id: "e-e",
          page_number: null,
          role: null,
          order_hint: null,
          state: "done",
          text: "loose",
        },
      ],
    });
  });

  it("exports in batches with a keyset cursor", async () => {
    const first = (await (
      await h.api("/api/books/exp-1/export?limit=2")
    ).json()) as {
      files: { file_id: string }[];
      next_cursor: string | null;
      files_total: number;
    };
    expect(first).toMatchObject({
      success: true,
      book_id: "exp-1",
      files_total: 5,
    });
    expect(first.files.map((f) => f.file_id)).toEqual(["e-a", "e-b"]);
    expect(first.next_cursor).toEqual(expect.any(String));

    const { response, counts } = await measured({
      h,
      request: () =>
        h.api(
          `/api/books/exp-1/export?limit=2&cursor=${encodeURIComponent(first.next_cursor ?? "")}`,
        ),
    });
    // e-c has text, e-d is still queued.
    expect(counts).toMatchObject({ d1Queries: 3, r2Reads: 1 });
    expect(response.status).toBe(200);

    const second = (await (
      await h.api(
        `/api/books/exp-1/export?limit=2&cursor=${encodeURIComponent(first.next_cursor ?? "")}`,
      )
    ).json()) as { files: { file_id: string }[]; next_cursor: string | null };
    expect(second.files.map((f) => f.file_id)).toEqual(["e-c", "e-d"]);
    const third = (await (
      await h.api(
        `/api/books/exp-1/export?limit=2&cursor=${encodeURIComponent(second.next_cursor ?? "")}`,
      )
    ).json()) as { files: { file_id: string }[]; next_cursor: string | null };
    expect(third).toEqual({
      success: true,
      book_id: "exp-1",
      files_total: 5,
      next_cursor: null,
      files: [
        {
          file_id: "e-e",
          page_number: null,
          role: null,
          order_hint: null,
          state: "done",
          text: "loose",
        },
      ],
    });
  });

  it("seeks to the cursor instead of reading the whole book", async () => {
    await seedBook({ h, id: "exp-big" });
    await seedFiles({
      h,
      bookId: "exp-big",
      files: Array.from({ length: 300 }, (_, i) => ({
        fileId: `eb-${String(i).padStart(3, "0")}`,
        page: i % 50 === 0 ? null : Math.floor(i / 2),
        orderHint: i % 3 === 0 ? null : i % 2,
        state: "queued",
      })),
    });
    const ids: string[] = [];
    let cursor: string | null = null;
    let maxRowsRead = 0;
    do {
      const path: string = `/api/books/exp-big/export?limit=10${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
      }`;
      const { response, counts } = await measured({
        h,
        request: () => h.api(path),
      });
      expect(response.status).toBe(200);
      maxRowsRead = Math.max(maxRowsRead, counts.d1RowsRead);
      const body = (await (await h.api(path)).json()) as {
        files: { file_id: string }[];
        next_cursor: string | null;
      };
      ids.push(...body.files.map((f) => f.file_id));
      cursor = body.next_cursor;
    } while (cursor);

    const all = (await (await h.api("/api/books/exp-big/export")).json()) as {
      files: { file_id: string }[];
    };
    expect(ids).toHaveLength(300);
    expect(ids).toEqual(all.files.map((f) => f.file_id));
    // Each batch: the book, its counters, and about two rows per file for the
    // eleven it fetches; never all 300 files of the book.
    expect(maxRowsRead).toBeLessThanOrEqual(40);
  });

  it("accepts a cursor issued before the sort columns existed", async () => {
    const cursor = btoa(
      JSON.stringify({ page_number: 2, order_hint: 0, file_id: "e-b" }),
    ).replace(/=+$/, "");
    const body = (await (
      await h.api(`/api/books/exp-1/export?limit=2&cursor=${cursor}`)
    ).json()) as { files: { file_id: string }[] };
    expect(body.files.map((f) => f.file_id)).toEqual(["e-c", "e-d"]);
  });

  it("rejects a bad limit or cursor", async () => {
    for (const limit of ["0", "201", "x"]) {
      await expectValidationError({
        response: await h.api(`/api/books/exp-1/export?limit=${limit}`),
        paths: [["query", "limit"]],
      });
    }
    await expectError({
      response: await h.api("/api/books/exp-1/export?cursor=abc"),
      status: 400,
      error: "cursor requires limit",
    });
    await expectError({
      response: await h.api("/api/books/exp-1/export?limit=2&cursor=!!!"),
      status: 400,
      error: "Malformed cursor; pass next_cursor as-is",
    });
    await expectError({
      response: await h.api("/api/books/exp-missing/export"),
      status: 404,
      error: "Book 'exp-missing' not found",
    });
  });
});

describe("requeue, pause and resume", () => {
  beforeAll(async () => {
    await seedBook({ h, id: "rq-1" });
    await seedFiles({
      h,
      bookId: "rq-1",
      files: [
        { fileId: "rq-failed", state: "failed", error: "x" },
        { fileId: "rq-limited", state: "rate_limited", error: "429" },
        { fileId: "rq-done", text: "t" },
      ],
    });
  });

  it("requeues failed and rate-limited files by default as retries", async () => {
    const { response, messages } = await measured({
      h,
      request: () => postJson({ h, path: "/api/books/rq-1/requeue", body: {} }),
    });
    expect(response.status).toBe(200);
    expect(await (await h.api("/api/books/rq-1/status")).json()).toMatchObject({
      files: expect.arrayContaining([
        expect.objectContaining({
          file_id: "rq-failed",
          state: "queued",
          error: null,
        }),
      ]),
    });
    expect(messages).toEqual(
      expect.arrayContaining([
        { fileId: "rq-failed", trigger: "retry" },
        { fileId: "rq-limited", trigger: "retry" },
      ]),
    );
    expect(messages).toHaveLength(2);
  });

  it("returns the requeue result, and accepts a request without a body", async () => {
    await h.sql([
      { sql: "UPDATE files SET state = 'failed' WHERE file_id = 'rq-failed'" },
    ]);
    const response = await h.api("/api/books/rq-1/requeue", { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      requeued: 1,
      states: ["failed", "rate_limited"],
    });
    const none = await postJson({
      h,
      path: "/api/books/rq-1/requeue",
      body: {},
    });
    expect(await none.json()).toEqual({
      success: true,
      requeued: 0,
      states: ["failed", "rate_limited"],
    });
  });

  it("requeues done files as requeues", async () => {
    const { response, messages } = await measured({
      h,
      request: () =>
        postJson({
          h,
          path: "/api/books/rq-1/requeue",
          body: { states: ["done"] },
        }),
    });
    expect(response.status).toBe(200);
    expect(messages).toEqual([{ fileId: "rq-done", trigger: "requeue" }]);
  });

  it("validates states and 404s a missing book", async () => {
    await expectValidationError({
      response: await postJson({
        h,
        path: "/api/books/rq-1/requeue",
        body: { states: [] },
      }),
      paths: [["body", "states"]],
    });
    await expectValidationError({
      response: await postJson({
        h,
        path: "/api/books/rq-1/requeue",
        body: { states: ["bogus"] },
      }),
      paths: [["body", "states", "0"]],
    });
    await expectError({
      response: await postJson({
        h,
        path: "/api/books/rq-missing/requeue",
        body: {},
      }),
      status: 404,
      error: "Book 'rq-missing' not found",
    });
  });

  it("pauses and resumes a book, re-enqueueing waiting pages", async () => {
    await seedBook({ h, id: "pause-1" });
    await seedFiles({
      h,
      bookId: "pause-1",
      files: [
        { fileId: "p-queued", state: "queued" },
        { fileId: "p-limited", state: "rate_limited" },
        { fileId: "p-done", text: "t" },
      ],
    });
    const paused = await h.api("/api/books/pause-1/pause", { method: "POST" });
    expect(paused.status).toBe(200);
    expect(await paused.json()).toEqual({ success: true, paused: true });
    expect(await (await h.api("/api/books/pause-1")).json()).toMatchObject({
      book: { paused: true },
    });

    const { response, messages } = await measured({
      h,
      request: () => h.api("/api/books/pause-1/resume", { method: "POST" }),
    });
    expect(response.status).toBe(200);
    expect(messages).toEqual(
      expect.arrayContaining([
        { fileId: "p-queued", trigger: "requeue" },
        { fileId: "p-limited", trigger: "requeue" },
      ]),
    );
    expect(messages).toHaveLength(2);
    const again = await h.api("/api/books/pause-1/resume", { method: "POST" });
    expect(await again.json()).toEqual({
      success: true,
      paused: false,
      requeued: 2,
    });
  });

  it("404s pause and resume for a missing book", async () => {
    for (const action of ["pause", "resume"]) {
      await expectError({
        response: await h.api(`/api/books/pr-missing/${action}`, {
          method: "POST",
        }),
        status: 404,
        error: "Book 'pr-missing' not found",
      });
    }
  });
});

describe("works and tags", () => {
  it("creates a work with tags, and refuses a duplicate id", async () => {
    const response = await postJson({
      h,
      path: "/api/works",
      body: {
        id: "w-create",
        name: "المغني",
        author: "ابن قدامة",
        tags: ["فقه", "فقه", " "],
      },
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      success: true,
      work: {
        id: "w-create",
        name: "المغني",
        author: "ابن قدامة",
        created_at: expect.any(Number),
        tags: ["فقه", "فقه", " "],
      },
    });
    expect(await (await h.api("/api/works/w-create")).json()).toMatchObject({
      work: { tags: ["فقه"] },
    });
    await expectError({
      response: await postJson({
        h,
        path: "/api/works",
        body: { id: "w-create", name: "x" },
      }),
      status: 409,
      error: "Work 'w-create' already exists",
    });
  });

  it("creates a work with a generated id and no tags", async () => {
    const response = await postJson({
      h,
      path: "/api/works",
      body: { name: "Bare" },
    });
    expect(await response.json()).toEqual({
      success: true,
      work: {
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        name: "Bare",
        author: null,
        created_at: expect.any(Number),
        tags: [],
      },
    });
  });

  it("validates the work body", async () => {
    await expectValidationError({
      response: await postJson({ h, path: "/api/works", body: { name: "" } }),
      paths: [["body", "name"]],
    });
    await expectValidationError({
      response: await postJson({
        h,
        path: "/api/works",
        body: { name: "x", id: "Bad Id" },
      }),
      paths: [["body", "id"]],
    });
  });

  it("lists works with copy counts and sorted tags", async () => {
    await seedWork({
      h,
      id: "w-list",
      createdAt: 5_000_000_000_000,
      tags: ["b", "a"],
      author: "Someone",
    });
    await seedBook({ h, id: "w-list-copy-1", workId: "w-list" });
    await seedBook({ h, id: "w-list-copy-2", workId: "w-list" });
    const { counts } = await measured({
      h,
      request: () => h.api("/api/works"),
    });
    expect(counts.d1Queries).toBe(2);
    const body = (await (await h.api("/api/works")).json()) as {
      success: boolean;
      works: Record<string, unknown>[];
    };
    expect(body.success).toBe(true);
    expect(body.works[0]).toEqual({
      id: "w-list",
      name: "Work w-list",
      author: "Someone",
      created_at: 5_000_000_000_000,
      copies_total: 2,
      tags: ["a", "b"],
    });
  });

  it("fetches a work, and 404s a missing one", async () => {
    await seedWork({ h, id: "w-fetch", createdAt: 77, tags: ["z", "y"] });
    expect(await (await h.api("/api/works/w-fetch")).json()).toEqual({
      success: true,
      work: {
        id: "w-fetch",
        name: "Work w-fetch",
        author: null,
        created_at: 77,
        tags: ["y", "z"],
      },
    });
    await expectError({
      response: await h.api("/api/works/w-missing"),
      status: 404,
      error: "Work 'w-missing' not found",
    });
  });

  it("updates a work's name, author and tags", async () => {
    await seedWork({ h, id: "w-upd", createdAt: 88, tags: ["old"] });
    await seedBook({ h, id: "w-upd-copy", workId: "w-upd" });
    h.meili.calls.length = 0;
    const response = await postJson({
      h,
      method: "PATCH",
      path: "/api/works/w-upd",
      body: { name: "Renamed", author: "A", tags: ["new"] },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      work: {
        id: "w-upd",
        name: "Renamed",
        author: "A",
        created_at: 88,
        tags: ["new"],
      },
    });
    expect(h.meili.calls.map((c) => c.path)).toEqual([
      "/indexes/books/documents/delete",
    ]);
    const cleared = await postJson({
      h,
      method: "PATCH",
      path: "/api/works/w-upd",
      body: { author: null, tags: [] },
    });
    expect(await cleared.json()).toMatchObject({
      work: { author: null, tags: [] },
    });
  });

  it("validates a work update and 404s a missing work", async () => {
    await seedWork({ h, id: "w-upd-2" });
    const empty = await postJson({
      h,
      method: "PATCH",
      path: "/api/works/w-upd-2",
      body: {},
    });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toMatchObject({ success: false, result: {} });
    await expectError({
      response: await postJson({
        h,
        method: "PATCH",
        path: "/api/works/w-nope",
        body: { name: "x" },
      }),
      status: 404,
      error: "Work 'w-nope' not found",
    });
  });

  it("deletes a work, unlinking its copies by default", async () => {
    await seedWork({ h, id: "w-del", tags: ["t"] });
    await seedBook({ h, id: "w-del-copy", workId: "w-del" });
    const response = await h.api("/api/works/w-del", { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      deleted: { work_id: "w-del", mode: "unlink", copies: 1 },
    });
    expect(await (await h.api("/api/books/w-del-copy")).json()).toMatchObject({
      book: { work_id: null },
    });
  });

  it("cascade-deletes a work's copies", async () => {
    await seedWork({ h, id: "w-cascade" });
    await seedBook({ h, id: "w-cascade-copy", workId: "w-cascade" });
    await seedFiles({
      h,
      bookId: "w-cascade-copy",
      files: [{ fileId: "wc-1", scan: JPEG_BYTES }],
    });
    const response = await h.api("/api/works/w-cascade?copies=delete", {
      method: "DELETE",
    });
    expect(await response.json()).toEqual({
      success: true,
      deleted: { work_id: "w-cascade", mode: "delete", copies: 1 },
    });
    expect((await h.api("/api/books/w-cascade-copy")).status).toBe(404);
    expect(await h.listObjects("books/w-cascade-copy/")).toEqual([]);
  });

  it("validates the delete mode and 404s a missing work", async () => {
    await seedWork({ h, id: "w-del-2" });
    await expectValidationError({
      response: await h.api("/api/works/w-del-2?copies=bogus", {
        method: "DELETE",
      }),
      paths: [["query", "copies"]],
    });
    await expectError({
      response: await h.api("/api/works/w-del-missing", { method: "DELETE" }),
      status: 404,
      error: "Work 'w-del-missing' not found",
    });
  });

  it("lists tags alphabetically", async () => {
    const body = (await (await h.api("/api/tags")).json()) as {
      success: boolean;
      tags: { id: string; name: string }[];
    };
    expect(body.success).toBe(true);
    expect(body.tags.length).toBeGreaterThan(0);
    expect(Object.keys(body.tags[0] ?? {}).sort()).toEqual(["id", "name"]);
    const names = body.tags.map((t) => t.name);
    expect(names).toEqual([...names].sort());
  });
});

describe("files", () => {
  beforeAll(async () => {
    await seedBook({ h, id: "files-1" });
  });

  it("uploads a raw image body into R2 and enqueues it for OCR", async () => {
    const { response, messages, counts } = await measured({
      h,
      request: () =>
        h.api("/api/books/files-1/files?page=12", {
          method: "POST",
          headers: { "Content-Type": "image/jpeg" },
          body: JPEG_BYTES,
        }),
    });
    expect(response.status).toBe(201);
    expect(counts).toMatchObject({ d1Queries: 2, r2Writes: 1, queueSends: 1 });
    const fileId = (messages[0] as { fileId: string }).fileId;
    expect(messages).toEqual([{ fileId, trigger: "upload" }]);

    const stored = await h.getObject(scanKey({ bookId: "files-1", fileId }));
    expect(stored.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await stored.arrayBuffer())).toEqual(JPEG_BYTES);
    const rows = await h.query(
      "SELECT state, page_number FROM files WHERE file_id = ?",
      [fileId],
    );
    expect(rows).toEqual([{ state: "queued", page_number: 12 }]);
  });

  it("returns the created file record", async () => {
    const response = await h.api("/api/books/files-1/files", {
      method: "POST",
      headers: { "Content-Type": "image/webp; charset=binary" },
      body: JPEG_BYTES,
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { file: { file_id: string } };
    expect(body).toEqual({
      success: true,
      file: {
        file_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        book_id: "files-1",
        r2_key: `books/files-1/scans/${body.file.file_id}`,
        state: "queued",
        text_key: null,
        page_number: null,
        role: null,
        order_hint: null,
        created_at: expect.any(Number),
        updated_at: expect.any(Number),
      },
    });
    const stored = await h.getObject(
      scanKey({ bookId: "files-1", fileId: body.file.file_id }),
    );
    expect(stored.headers.get("content-type")).toBe("image/webp");
  });

  it("refuses a PDF with 415, a missing book with 404 and a bad page with 400", async () => {
    await expectError({
      response: await h.api("/api/books/files-1/files", {
        method: "POST",
        headers: { "Content-Type": "application/pdf" },
        body: JPEG_BYTES,
      }),
      status: 415,
      error:
        "Unsupported Content-Type 'application/pdf'. Upload a page image (image/jpeg, image/png, image/webp); PDFs aren't supported, export each page as an image first.",
    });
    await expectError({
      response: await h.api("/api/books/files-missing/files", {
        method: "POST",
        headers: { "Content-Type": "application/pdf" },
        body: JPEG_BYTES,
      }),
      status: 404,
      error: "Book 'files-missing' not found",
    });
    for (const page of ["0", "x", "1.5"]) {
      await expectValidationError({
        response: await h.api(`/api/books/files-1/files?page=${page}`, {
          method: "POST",
          headers: { "Content-Type": "image/jpeg" },
          body: JPEG_BYTES,
        }),
        paths: [["query", "page"]],
      });
    }
  });

  // workerd hands an empty POST a zero-length body stream, never null, so the
  // "Missing request body" branch is unreachable over HTTP: an empty upload is
  // stored as an empty scan. Pinned as-is (OCR then fails it as unreadable).
  it("stores an upload with an empty body", async () => {
    const response = await h.api("/api/books/files-1/files", {
      method: "POST",
      headers: { "Content-Type": "image/png" },
    });
    expect(response.status).toBe(201);
    const { file } = (await response.json()) as { file: { file_id: string } };
    const stored = await h.getObject(
      scanKey({ bookId: "files-1", fileId: file.file_id }),
    );
    expect((await stored.arrayBuffer()).byteLength).toBe(0);
  });

  it("changes and clears a file's page number", async () => {
    await seedFiles({
      h,
      bookId: "files-1",
      files: [{ fileId: "fu-page", page: 3 }],
    });
    const response = await postJson({
      h,
      method: "PATCH",
      path: "/api/books/files-1/files/fu-page",
      body: { page_number: 7 },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      file: {
        file_id: "fu-page",
        book_id: "files-1",
        r2_key: "books/files-1/scans/fu-page",
        state: "queued",
        text_key: null,
        page_number: 7,
        role: null,
        order_hint: null,
        created_at: 1_000,
        updated_at: expect.any(Number),
      },
    });
    const cleared = await postJson({
      h,
      method: "PATCH",
      path: "/api/books/files-1/files/fu-page",
      body: { page_number: null },
    });
    expect(await cleared.json()).toMatchObject({ file: { page_number: null } });
  });

  it("validates a page number update and 404s a missing file", async () => {
    for (const body of [
      { page_number: 0 },
      { page_number: "3" },
      {},
      { page_number: 1.5 },
    ]) {
      await expectValidationError({
        response: await postJson({
          h,
          method: "PATCH",
          path: "/api/books/files-1/files/fu-page",
          body,
        }),
        paths: [["body", "page_number"]],
      });
    }
    await expectError({
      response: await postJson({
        h,
        method: "PATCH",
        path: "/api/books/files-1/files/fu-missing",
        body: { page_number: 2 },
      }),
      status: 404,
      error: "File 'fu-missing' not found",
    });
  });

  it("deletes a file with its scan, text and history", async () => {
    await seedFiles({
      h,
      bookId: "files-1",
      files: [{ fileId: "fd-1", text: "t", scan: JPEG_BYTES }],
    });
    await h.putObject({
      key: "books/files-1/text-history/fd-1/1-a.md",
      body: "old",
    });
    await h.putObject({ key: "books/files-1/ocr-runs/fd-1/1.md", body: "run" });
    await h.sql([
      {
        sql: "INSERT INTO text_revisions (file_id, book_id, change, prev_key, created_at) VALUES ('fd-1', 'files-1', 'edit', 'books/files-1/text-history/fd-1/1-a.md', 1)",
      },
    ]);
    const response = await h.api("/api/books/files-1/files/fd-1", {
      method: "DELETE",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      deleted: { file_id: "fd-1", r2_objects: 4 },
    });
    expect(
      (await h.listObjects("books/files-1/")).filter((k) => k.includes("fd-1")),
    ).toEqual([]);
    expect(
      await h.query("SELECT id FROM text_revisions WHERE file_id = 'fd-1'"),
    ).toEqual([]);
    await expectError({
      response: await h.api("/api/books/files-1/files/fd-1", {
        method: "DELETE",
      }),
      status: 404,
      error: "File 'fd-1' not found",
    });
  });

  it("queues one file for OCR", async () => {
    await seedFiles({
      h,
      bookId: "files-1",
      files: [{ fileId: "fo-1", state: "failed", error: "x" }],
    });
    const { response, messages } = await measured({
      h,
      request: () =>
        h.api("/api/books/files-1/files/fo-1/ocr", { method: "POST" }),
    });
    expect(response.status).toBe(202);
    expect(messages).toEqual([{ fileId: "fo-1", trigger: "manual" }]);
    const body = await (
      await h.api("/api/books/files-1/files/fo-1/ocr", { method: "POST" })
    ).json();
    expect(body).toEqual({ success: true, file_id: "fo-1", state: "queued" });
    expect(
      await h.query("SELECT state, error FROM files WHERE file_id = 'fo-1'"),
    ).toEqual([{ state: "queued", error: null }]);
    await expectError({
      response: await h.api("/api/books/files-1/files/fo-missing/ocr", {
        method: "POST",
      }),
      status: 404,
      error: "File 'fo-missing' not found",
    });
  });
});

describe("page review", () => {
  const ON_DEMAND_ID = /^review-ondemand-\d+$/;
  const reviewPage = (fileId: string) =>
    h.api(`/api/books/pr-1/files/${fileId}/review`, { method: "POST" });
  const queueRow = async (fileId: string) =>
    (
      await h.query(
        "SELECT instance_id, attempts, requested FROM review_queue WHERE file_id = ?",
        [fileId],
      )
    )[0] ?? null;

  beforeAll(async () => {
    // Review is off for the book: a page asked for is reviewed anyway.
    await seedBook({ h, id: "pr-1" });
    await seedFiles({
      h,
      bookId: "pr-1",
      files: [
        { fileId: "pr-new", text: "نص", preview: "نص" },
        { fileId: "pr-new-2", text: "نص", preview: "نص" },
        { fileId: "pr-new-3", text: "نص", preview: "نص" },
        { fileId: "pr-new-4", text: "نص", preview: "نص" },
        { fileId: "pr-waiting", text: "نص", preview: "نص" },
        { fileId: "pr-in-batch", text: "نص", preview: "نص" },
        { fileId: "pr-edited", text: "نص", preview: "نص", textEditedAt: 5 },
        { fileId: "pr-blank", text: "", preview: "" },
        { fileId: "pr-queued" },
      ],
    });
    await h.sql([
      {
        sql: `INSERT INTO review_queue (file_id, book_id, queued_at, instance_id, attempts, requested)
              VALUES ('pr-waiting', 'pr-1', 1, NULL, 2, 0),
                     ('pr-in-batch', 'pr-1', 1, 'review-9', 1, 0)`,
      },
    ]);
  });

  it("queues the page as asked for and starts a run, with the book's review off", async () => {
    const { response, counts, operations } = await measured({
      h,
      request: () => reviewPage("pr-new"),
    });
    expect(response.status).toBe(202);
    expect(await (await reviewPage("pr-new")).json()).toEqual({
      success: true,
      queued: false,
      already_queued: true,
      run_started: true,
      instance_id: expect.stringMatching(ON_DEMAND_ID),
    });
    // One D1 round trip; one row written (the queue row, WITHOUT ROWID).
    expect(counts).toMatchObject({
      d1RoundTrips: 1,
      d1Queries: 4,
      d1RowsWritten: 1,
      workflowCreates: 1,
      r2Reads: 0,
      queueSends: 0,
    });
    expect(counts.d1RowsRead).toBeLessThanOrEqual(8);
    expect(
      operations.find((o) => o.kind === "workflow.create")?.detail,
    ).toMatch(ON_DEMAND_ID);
    expect(await queueRow("pr-new")).toEqual({
      instance_id: null,
      attempts: 0,
      requested: 1,
    });
  });

  it("refuses pages that aren't done, are blank or were edited by hand", async () => {
    const cases = [
      {
        fileId: "pr-edited",
        error: "Page was edited by hand; a review never overwrites a hand edit",
      },
      {
        fileId: "pr-blank",
        error: "Page is blank; there is nothing to review",
      },
      {
        fileId: "pr-queued",
        error:
          "Page isn't transcribed yet (state: queued); only done pages can be reviewed",
      },
    ];
    for (const { fileId, error } of cases) {
      const { response, counts } = await measured({
        h,
        request: () => reviewPage(fileId),
      });
      expect(response.status).toBe(409);
      expect(counts).toMatchObject({ d1RowsWritten: 0, workflowCreates: 0 });
      await expectError({
        response: await reviewPage(fileId),
        status: 409,
        error,
      });
      expect(await queueRow(fileId)).toBeNull();
    }
  });

  it("doesn't queue a page twice", async () => {
    // Waiting: now asked for, with its tries reset.
    expect(await (await reviewPage("pr-waiting")).json()).toMatchObject({
      queued: false,
      already_queued: true,
      run_started: true,
    });
    expect(await queueRow("pr-waiting")).toEqual({
      instance_id: null,
      attempts: 0,
      requested: 1,
    });
    // In a running batch: left alone, and no run is started for it.
    const { response, counts } = await measured({
      h,
      request: () => reviewPage("pr-in-batch"),
    });
    expect(response.status).toBe(202);
    expect(counts).toMatchObject({ d1RowsWritten: 0, workflowCreates: 0 });
    expect(await (await reviewPage("pr-in-batch")).json()).toEqual({
      success: true,
      queued: false,
      already_queued: true,
      run_started: false,
      instance_id: null,
    });
    expect(await queueRow("pr-in-batch")).toEqual({
      instance_id: "review-9",
      attempts: 1,
      requested: 0,
    });
  });

  it("leaves the page for the next run while a run is going", async () => {
    const now = Date.now();
    await h.sql([
      {
        sql: `INSERT INTO review_batches (instance_id, created_at, model, pages, stage)
              VALUES ('review-running', ?, 'claude-opus-5-5', 3, 'processing'),
                     ('review-applying', ?, 'claude-opus-5-5', 3, 'applying'),
                     ('review-stuck', ?, 'claude-opus-5-5', 3, 'processing')`,
        // A running row older than 28 hours is stuck (the cron sweeps it).
        params: [now, now, now - 29 * 60 * 60 * 1000],
      },
    ]);
    const { response, counts } = await measured({
      h,
      request: () => reviewPage("pr-new-2"),
    });
    expect(response.status).toBe(202);
    expect(counts.workflowCreates).toBe(0);
    expect(await queueRow("pr-new-2")).toEqual({
      instance_id: null,
      attempts: 0,
      requested: 1,
    });
    expect(await (await reviewPage("pr-new-2")).json()).toEqual({
      success: true,
      queued: false,
      already_queued: true,
      run_started: false,
      instance_id: null,
    });

    // Once that run has moved on to applying, a click starts a run again.
    await h.sql([
      {
        sql: "UPDATE review_batches SET stage = 'applying' WHERE instance_id = 'review-running'",
      },
    ]);
    expect(await (await reviewPage("pr-new-2")).json()).toMatchObject({
      run_started: true,
      instance_id: expect.stringMatching(ON_DEMAND_ID),
    });
    await h.sql([
      {
        sql: "DELETE FROM review_batches WHERE instance_id IN ('review-running', 'review-applying', 'review-stuck')",
      },
    ]);
  });

  it("starts one run for clicks in the same minute", async () => {
    type Body = { instance_id: string | null };
    const clickBoth = async () => {
      await h.ops();
      const first = (await (await reviewPage("pr-new-3")).json()) as Body;
      const second = (await (await reviewPage("pr-new-4")).json()) as Body;
      const { operations } = await h.ops();
      return { first, second, operations };
    };
    let clicks = await clickBoth();
    // Clicked again if the two straddled a minute boundary.
    if (clicks.first.instance_id !== clicks.second.instance_id) {
      clicks = await clickBoth();
    }
    expect(clicks.first).toMatchObject({ run_started: true });
    expect(clicks.second).toMatchObject({
      run_started: true,
      instance_id: clicks.first.instance_id,
    });
    // Both creates used the same id; the second found the instance there
    // (the first may too, if an earlier test started it this minute).
    const creates = clicks.operations
      .filter((o) => o.kind === "workflow.create")
      .map((o) => o.detail);
    expect(creates).toHaveLength(2);
    expect(creates[0]?.startsWith(clicks.first.instance_id ?? "-")).toBe(true);
    expect(creates[1]).toBe(`${clicks.first.instance_id} (duplicate)`);
  });

  it("answers 404 for a missing book or page", async () => {
    await expectError({
      response: await h.api("/api/books/pr-missing/files/pr-new/review", {
        method: "POST",
      }),
      status: 404,
      error: "Book 'pr-missing' not found",
    });
    await expectError({
      response: await reviewPage("pr-missing"),
      status: 404,
      error: "File 'pr-missing' not found",
    });
  });
});

describe("file text", () => {
  beforeAll(async () => {
    await seedBook({ h, id: "text-1" });
    await seedFiles({
      h,
      bookId: "text-1",
      files: [
        { fileId: "t-done", text: "# باب\n\nالحمد لله" },
        { fileId: "t-queued", state: "queued" },
        { fileId: "t-edit", text: "alpha beta gamma beta" },
        { fileId: "t-lost", text: "gone" },
      ],
    });
    await h.sql([
      {
        sql: "UPDATE files SET text_key = 'books/text-1/text/nowhere.md' WHERE file_id = 't-lost'",
      },
    ]);
  });

  it("returns a transcription as raw Markdown with one D1 query and one R2 read", async () => {
    const { response, counts } = await measured({
      h,
      request: () => h.api("/api/books/text-1/files/t-done/text"),
    });
    expect(response.status).toBe(200);
    expect(counts).toMatchObject({ d1Queries: 1, r2Reads: 1 });
    const again = await h.api("/api/books/text-1/files/t-done/text");
    expect(again.headers.get("content-type")).toBe(
      "text/markdown; charset=utf-8",
    );
    expect(await again.text()).toBe("# باب\n\nالحمد لله");
  });

  it("answers 404, 409 and a missing transcription", async () => {
    await expectError({
      response: await h.api("/api/books/text-1/files/t-none/text"),
      status: 404,
      error: "File 't-none' not found",
    });
    await expectError({
      response: await h.api("/api/books/other-book/files/t-done/text"),
      status: 404,
      error: "File 't-done' not found",
    });
    await expectError({
      response: await h.api("/api/books/text-1/files/t-queued/text"),
      status: 409,
      error: "File not transcribed yet",
    });
    await expectError({
      response: await h.api("/api/books/text-1/files/t-lost/text"),
      status: 404,
      error: "Transcription missing",
    });
  });

  it("edits a page, keeps the old text in history, and serves it by revision", async () => {
    h.meili.calls.length = 0;
    const response = await postJson({
      h,
      method: "PATCH",
      path: "/api/books/text-1/files/t-edit/text",
      body: {
        edits: [
          { old: "alpha", new: "ALPHA" },
          { old: "gamma", new: "" },
        ],
        note: "fix",
      },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      revision_id: number;
      text_edited_at: number;
    };
    expect(body).toEqual({
      success: true,
      file_id: "t-edit",
      changed: true,
      revision_id: expect.any(Number),
      text_edited_at: expect.any(Number),
    });
    expect(
      await (await h.api("/api/books/text-1/files/t-edit/text")).text(),
    ).toBe("ALPHA beta  beta");
    expect(h.meili.calls.map((c) => c.path)).toEqual([
      "/indexes/books/documents/delete",
      "/indexes/books/documents",
    ]);

    const history = await h.api("/api/books/text-1/files/t-edit/text/history");
    expect(await history.json()).toEqual({
      success: true,
      file_id: "t-edit",
      text_edited_at: body.text_edited_at,
      revisions: [
        {
          id: body.revision_id,
          change: "edit",
          model: null,
          note: "fix",
          created_at: expect.any(Number),
        },
      ],
    });
    const old = await h.api(
      `/api/books/text-1/files/t-edit/text?rev=${body.revision_id}`,
    );
    expect(old.status).toBe(200);
    expect(await old.text()).toBe("alpha beta gamma beta");
    await expectError({
      response: await h.api("/api/books/text-1/files/t-edit/text?rev=999999"),
      status: 404,
      error: "Revision 999999 not found",
    });
    for (const rev of ["x", "0", "-2"]) {
      await expectValidationError({
        response: await h.api(`/api/books/text-1/files/t-edit/text?rev=${rev}`),
        paths: [["query", "rev"]],
      });
    }
  });

  it("reports an edit that matches nothing or several places, and a no-op", async () => {
    const ambiguous = await postJson({
      h,
      method: "PATCH",
      path: "/api/books/text-1/files/t-done/text",
      body: { edits: [{ old: "ل", new: "x" }] },
    });
    expect(ambiguous.status).toBe(422);
    expect(await ambiguous.json()).toEqual({
      success: false,
      error: expect.stringMatching(
        /^Edit 0 matches \d+ times; include more surrounding text; nothing was applied$/,
      ),
      failed_edit: 0,
      reason: expect.stringMatching(/^matches \d+ times/),
    });
    const missing = await postJson({
      h,
      method: "PATCH",
      path: "/api/books/text-1/files/t-done/text",
      body: { edits: [{ old: "zzz", new: "x" }] },
    });
    expect(await missing.json()).toEqual({
      success: false,
      error: "Edit 0 not found; nothing was applied",
      failed_edit: 0,
      reason: "not found",
    });
    const noop = await postJson({
      h,
      method: "PATCH",
      path: "/api/books/text-1/files/t-done/text",
      body: { edits: [{ old: "باب", new: "باب" }] },
    });
    expect(await noop.json()).toEqual({
      success: true,
      file_id: "t-done",
      changed: false,
      revision_id: null,
      text_edited_at: null,
    });
  });

  it("refuses edits to untranscribed or missing pages and invalid bodies", async () => {
    await expectError({
      response: await postJson({
        h,
        method: "PATCH",
        path: "/api/books/text-1/files/t-queued/text",
        body: { edits: [{ old: "", new: "x" }] },
      }),
      status: 409,
      error: "File is 'queued', not transcribed; edit it once OCR is done",
    });
    await expectError({
      response: await postJson({
        h,
        method: "PATCH",
        path: "/api/books/text-1/files/t-none/text",
        body: { edits: [{ old: "a", new: "b" }] },
      }),
      status: 404,
      error: "File 't-none' not found",
    });
    await expectValidationError({
      response: await postJson({
        h,
        method: "PATCH",
        path: "/api/books/text-1/files/t-done/text",
        body: { edits: [] },
      }),
      paths: [["body", "edits"]],
    });
    await expectValidationError({
      response: await postJson({
        h,
        method: "PATCH",
        path: "/api/books/text-1/files/t-done/text",
        body: { edits: [{ old: "a" }] },
      }),
      paths: [["body", "edits", "0", "new"]],
    });
    await expectValidationError({
      response: await postJson({
        h,
        method: "PATCH",
        path: "/api/books/text-1/files/t-done/text",
        body: { edits: [{ old: "a", new: "b" }], note: "x".repeat(501) },
      }),
      paths: [["body", "note"]],
    });
  });

  it("404s history for a missing file", async () => {
    await expectError({
      response: await h.api("/api/books/text-1/files/t-none/text/history"),
      status: 404,
      error: "File 't-none' not found",
    });
  });
});

describe("images and signed scan links", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);

  beforeAll(async () => {
    await seedBook({ h, id: "img-1" });
    await seedFiles({
      h,
      bookId: "img-1",
      files: [
        { fileId: "img-png", scan: PNG, scanType: "image/png" },
        { fileId: "img-noobj" },
      ],
    });
  });

  it("streams a scan to an authenticated client", async () => {
    const { response, counts } = await measured({
      h,
      request: () => h.api("/api/books/img-1/files/img-png/image"),
    });
    expect(response.status).toBe(200);
    expect(counts).toMatchObject({ d1Queries: 1, r2Reads: 1 });
    const again = await h.api("/api/books/img-1/files/img-png/image");
    expect(again.headers.get("content-type")).toBe("image/png");
    expect(again.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(new Uint8Array(await again.arrayBuffer())).toEqual(PNG);
  });

  it("404s a missing file or scan object", async () => {
    await expectError({
      response: await h.api("/api/books/img-1/files/img-none/image"),
      status: 404,
      error: "File 'img-none' not found",
    });
    await expectError({
      response: await h.api("/api/books/img-1/files/img-noobj/image"),
      status: 404,
      error: "Scan object missing",
    });
  });

  const signed = async ({
    fileId,
    expiresAt,
  }: {
    fileId: string;
    expiresAt: number;
  }) =>
    new URL(
      await signScanUrl({
        baseUrl: PUBLIC_API_URL,
        masterKey: MASTER_KEY,
        fileId,
        expiresAt,
      }),
    );

  it("serves a scan for a valid signed link without a key", async () => {
    const url = await signed({
      fileId: "img-png",
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    });
    const { response, counts } = await measured({
      h,
      request: () => h.fetch(`${url.pathname}${url.search}`),
    });
    expect(response.status).toBe(200);
    expect(counts).toMatchObject({ d1Queries: 1, r2Reads: 1 });
    const again = await h.fetch(`${url.pathname}${url.search}`);
    expect(again.headers.get("content-type")).toBe("image/png");
    expect(again.headers.get("cache-control")).toBe("private, no-store");
    expect(again.headers.get("access-control-allow-origin")).toBeNull();
    expect(new Uint8Array(await again.arrayBuffer())).toEqual(PNG);
  });

  it("answers every bad scan link with the same bare 404 and no lookups", async () => {
    const now = Math.floor(Date.now() / 1000);
    const valid = await signed({ fileId: "img-png", expiresAt: now + 600 });
    const expired = await signed({ fileId: "img-png", expiresAt: now - 1 });
    const otherFile = await signed({
      fileId: "img-noobj",
      expiresAt: now + 600,
    });
    const unknown = await signed({ fileId: "nobody", expiresAt: now + 600 });
    const tampered = `/scan/img-noobj${valid.search}`;
    const cases = [
      `${expired.pathname}${expired.search}`,
      tampered,
      "/scan/img-png",
      `/scan/img-png?exp=${now + 600}`,
      `/scan/img-png?exp=abc&sig=${valid.searchParams.get("sig")}`,
      `${otherFile.pathname}${otherFile.search}`,
      `${unknown.pathname}${unknown.search}`,
    ];
    for (const path of cases) {
      const response = await h.fetch(path);
      expect(response.status, path).toBe(404);
      expect(response.headers.get("content-type"), path).toBeNull();
      expect(await response.text(), path).toBe("");
    }
    const { counts } = await measured({ h, request: () => h.fetch(tampered) });
    expect(counts.d1Queries).toBe(0);
  });
});

describe("highlight", () => {
  beforeAll(async () => {
    await seedBook({ h, id: "hl-1" });
    await seedFiles({
      h,
      bookId: "hl-1",
      files: [
        { fileId: "hl-done", text: "الصلاة عماد الدين", updatedAt: 4242 },
        { fileId: "hl-queued", state: "queued" },
      ],
    });
  });

  it("answers a cached highlight from KV without reading R2", async () => {
    const cached = {
      text: "الصلاة عماد الدين",
      spans: [{ text: "الصلاة", ranges: [[0, 6]] }],
    };
    await h.putKv({
      key: `hl:hl-done:4242:${await hashQuery("prayer")}`,
      value: JSON.stringify(cached),
    });
    h.logs();
    const { response, counts } = await measured({
      h,
      request: () =>
        postJson({
          h,
          path: "/api/books/hl-1/files/hl-done/highlight",
          body: { query: "prayer" },
        }),
    });
    expect(response.status).toBe(200);
    expect(counts).toMatchObject({
      d1Queries: 1,
      kvReads: 1,
      r2Reads: 0,
      kvWrites: 0,
    });
    const [event] = wideEvents(h.logs()).filter((e) =>
      e.path?.endsWith("/highlight"),
    );
    expect(event?.raw).toMatch(/highlight: \{ cache: 'hit' \}/);

    const again = await postJson({
      h,
      path: "/api/books/hl-1/files/hl-done/highlight",
      body: { query: "prayer" },
    });
    expect(again.headers.get("content-type")).toBe(JSON_TYPE);
    expect(await again.json()).toEqual({ success: true, ...cached });
  });

  it("404s a missing file, 409s an untranscribed one, and validates the query", async () => {
    await expectError({
      response: await postJson({
        h,
        path: "/api/books/hl-1/files/hl-none/highlight",
        body: { query: "x" },
      }),
      status: 404,
      error: "File 'hl-none' not found",
    });
    await expectError({
      response: await postJson({
        h,
        path: "/api/books/hl-1/files/hl-queued/highlight",
        body: { query: "x" },
      }),
      status: 409,
      error: "File not transcribed yet",
    });
    await expectValidationError({
      response: await postJson({
        h,
        path: "/api/books/hl-1/files/hl-done/highlight",
        body: { query: "" },
      }),
      paths: [["body", "query"]],
    });
    await expectValidationError({
      response: await postJson({
        h,
        path: "/api/books/hl-1/files/hl-done/highlight",
        body: {},
      }),
      paths: [["body", "query"]],
    });
  });
});

describe("search reindex and admin", () => {
  it("reindexes one book synchronously", async () => {
    await seedBook({ h, id: "ri-1" });
    await seedFiles({
      h,
      bookId: "ri-1",
      files: [{ fileId: "ri-a", text: "نص الصفحة" }],
    });
    h.meili.calls.length = 0;
    const response = await postJson({
      h,
      path: "/api/search/reindex",
      body: { bookId: "ri-1" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      mode: "book",
      indexed: 1,
      books: null,
    });
    expect(h.meili.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /indexes/books/documents/delete",
      "POST /indexes/books/documents",
    ]);
  });

  it("starts a full rebuild on the queue when no book is given", async () => {
    h.meili.calls.length = 0;
    const { response, messages } = await measured({
      h,
      request: () => h.api("/api/search/reindex", { method: "POST" }),
    });
    expect(response.status).toBe(200);
    const [message] = messages as {
      kind: string;
      bookIds: string[];
      cursor: number;
    }[];
    expect(message).toMatchObject({ kind: "reindex_chain", cursor: 0 });
    expect(message?.bookIds).toContain("ri-1");
    expect(h.meili.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "DELETE /indexes/books_tmp",
      "POST /indexes",
      "PATCH /indexes/books_tmp/settings",
    ]);
    const body = await (
      await postJson({ h, path: "/api/search/reindex", body: {} })
    ).json();
    expect(body).toEqual({
      success: true,
      mode: "swap",
      indexed: null,
      books: message?.bookIds.length,
    });
  });

  it("answers an unexpected failure with a plain 500 and records it", async () => {
    h.meili.failing = true;
    h.logs();
    try {
      const response = await postJson({
        h,
        path: "/api/search/reindex",
        body: { bookId: "ri-1" },
      });
      expect(response.status).toBe(500);
      expect(response.headers.get("content-type")).toBe(
        "text/plain; charset=UTF-8",
      );
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(await response.text()).toBe("Internal Server Error");
    } finally {
      h.meili.failing = false;
    }
    const [event] = wideEvents(h.logs()).filter(
      (e) => e.path === "/api/search/reindex",
    );
    expect(event).toMatchObject({
      route: "POST /api/search/reindex",
      status: 500,
    });
    expect(event?.raw).toMatch(/level: 'error'/);
    expect(event?.raw).toMatch(/Meili POST/);
  });

  it("recomputes OCR run metrics in pages", async () => {
    const response = await postJson({
      h,
      path: "/api/admin/ocr-runs/recompute-metrics",
      body: {},
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      metrics_version: expect.any(Number),
      updated: 0,
      missing: 0,
      next_after: null,
    });
    const bare = await h.api("/api/admin/ocr-runs/recompute-metrics", {
      method: "POST",
    });
    expect(bare.status).toBe(200);
    await expectValidationError({
      response: await postJson({
        h,
        path: "/api/admin/ocr-runs/recompute-metrics",
        body: { limit: 0 },
      }),
      paths: [["body", "limit"]],
    });
    await expectValidationError({
      response: await postJson({
        h,
        path: "/api/admin/ocr-runs/recompute-metrics",
        body: { limit: 26 },
      }),
      paths: [["body", "limit"]],
    });
  });
});

describe("request bodies", () => {
  it("answers malformed JSON with a 400 on the body", async () => {
    const response = await h.api("/api/books", {
      method: "POST",
      headers: JSON_HEADERS,
      body: "{not json",
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe(VALIDATION_TYPE);
    expect(await response.json()).toEqual({
      success: false,
      errors: [{ code: 7001, message: expect.any(String), path: ["body"] }],
      result: {},
    });
  });

  it("answers a JSON endpoint given another content type with 415", async () => {
    const response = await h.api("/api/books", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ title: "t" }),
    });
    expect(response.status).toBe(415);
  });

  it("accepts a literal null body where the body is optional", async () => {
    await seedBook({ h, id: "null-body" });
    for (const path of [
      "/api/books/null-body/requeue",
      "/api/search/reindex",
      "/api/admin/ocr-runs/recompute-metrics",
    ]) {
      const response = await h.api(path, {
        method: "POST",
        headers: JSON_HEADERS,
        body: "null",
      });
      expect(response.status, path).toBe(200);
      expect(await response.json(), path).toMatchObject({ success: true });
    }
  });
});

describe("every API operation", () => {
  it("refuses a missing or wrong key before touching storage", async () => {
    const spec = (await (await h.fetch("/openapi.json")).json()) as {
      paths: Record<string, Record<string, unknown>>;
    };
    const operations = Object.entries(spec.paths).flatMap(([path, methods]) =>
      Object.keys(methods).map((method) => ({
        method: method.toUpperCase(),
        path: path.replace(/\{[^}]+\}/g, "x"),
      })),
    );
    expect(operations.length).toBe(34);
    for (const { method, path } of operations) {
      for (const headers of [{}, { Authorization: "Bearer wrong" }] as Record<
        string,
        string
      >[]) {
        const { response, counts } = await measured({
          h,
          request: () =>
            h.fetch(path, {
              method,
              headers: { ...headers, "Content-Type": "application/json" },
              body: method === "GET" ? undefined : "{}",
            }),
        });
        const label = `${method} ${path} ${headers.Authorization ?? "no key"}`;
        expect(response.status, label).toBe(401);
        expect(counts, label).toMatchObject({
          d1RoundTrips: 0,
          r2Reads: 0,
          r2Writes: 0,
          kvReads: 0,
          queueSends: 0,
        });
      }
    }
  });
});

describe("wide events", () => {
  it("records one event per request with the route template, ids and status", async () => {
    await seedBook({ h, id: "we-1" });
    await seedFiles({
      h,
      bookId: "we-1",
      files: [{ fileId: "we-f", text: "t" }],
    });
    h.logs();
    await h.api("/api/books/we-1/files/we-f/text", {
      headers: { "User-Agent": "contract", "X-Secret": "nope" },
    });
    await h.api("/api/books/we-1/status");
    await h.fetch("/api/books/we-1");
    await h.fetch("/llms.txt");
    const events = wideEvents(h.logs());
    expect(
      events.map(({ route, book_id, file_id, status }) => ({
        route,
        book_id,
        file_id,
        status,
      })),
    ).toEqual([
      {
        route: "GET /api/books/:bookId/files/:fileId/text",
        book_id: "we-1",
        file_id: "we-f",
        status: 200,
      },
      {
        route: "GET /api/books/:bookId/status",
        book_id: "we-1",
        file_id: undefined,
        status: 200,
      },
      {
        route: "GET /api/books/:bookId",
        book_id: "we-1",
        file_id: undefined,
        status: 401,
      },
      {
        route: "GET /llms.txt",
        book_id: undefined,
        file_id: undefined,
        status: 200,
      },
    ]);
    const [first] = events;
    expect(first?.raw).toMatch(
      /requestHeaders: \{ 'user-agent': 'contract' \}/,
    );
    expect(first?.raw).not.toMatch(
      /authorization|x-secret|contract-test-master-key/i,
    );
  });

  it("names unmatched requests by the catch-all they fell through", async () => {
    h.logs();
    await h.api("/api/nope");
    await h.fetch("/api/nope");
    await h.fetch("/nope");
    await h.fetch("/api/books", { method: "OPTIONS" });
    const events = wideEvents(h.logs()).map(({ route, status }) => ({
      route,
      status,
    }));
    expect(events).toEqual([
      { route: "GET /api/*", status: 404 },
      { route: "GET /api/*", status: 401 },
      { route: "GET /*", status: 404 },
      { route: "OPTIONS /api/*", status: 204 },
    ]);
  });

  it("decodes encoded ids on the event", async () => {
    h.logs();
    await h.api("/api/books/a%20b/status");
    const [event] = wideEvents(h.logs());
    expect(event).toMatchObject({ book_id: "a b", status: 404 });
  });
});
