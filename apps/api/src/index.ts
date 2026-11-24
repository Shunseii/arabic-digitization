import { fromHono } from "chanfana";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { LLMS_TXT } from "./docs";
import { BookCreate } from "./endpoints/bookCreate";
import { BookDelete } from "./endpoints/bookDelete";
import { BookExport } from "./endpoints/bookExport";
import { BookFetch } from "./endpoints/bookFetch";
import { BookList } from "./endpoints/bookList";
import { BookPause, BookResume } from "./endpoints/bookPause";
import { BookRequeue } from "./endpoints/bookRequeue";
import { BookStatus } from "./endpoints/bookStatus";
import { BookUpdate } from "./endpoints/bookUpdate";
import { FileDelete } from "./endpoints/fileDelete";
import { FileHighlight } from "./endpoints/fileHighlight";
import { FileImage } from "./endpoints/fileImage";
import { FileOcr } from "./endpoints/fileOcr";
import { FileText } from "./endpoints/fileText";
import { FileTextEdit } from "./endpoints/fileTextEdit";
import { FileTextHistory } from "./endpoints/fileTextHistory";
import { FileUpdate } from "./endpoints/fileUpdate";
import { FileUpload } from "./endpoints/fileUpload";
import { OcrRunsRecomputeMetrics } from "./endpoints/ocrRunsRecomputeMetrics";
import { SearchReindex } from "./endpoints/searchReindex";
import { TagList } from "./endpoints/tagList";
import { WorkCreate } from "./endpoints/workCreate";
import { WorkDelete } from "./endpoints/workDelete";
import { WorkFetch } from "./endpoints/workFetch";
import { WorkList } from "./endpoints/workList";
import { WorkUpdate } from "./endpoints/workUpdate";
import {
  initLogging,
  recordUnhandledError,
  requestEvent,
  withRequestEvent,
} from "./logging";
import { requireMasterKey } from "./middleware/auth";
import { handleOcrQueue, type QueueMessage } from "./queue";
import type { AppEnv } from "./types";

initLogging();

const app = new Hono<AppEnv>();

// One wide event per request (see logging.ts). First, so every route has it.
app.use("*", requestEvent);
app.onError(recordUnhandledError);

// Public LLM-oriented API reference (for a local skill). Before the gate.
app.get("/llms.txt", (c) =>
  c.body(LLMS_TXT, 200, { "content-type": "text/markdown; charset=utf-8" }),
);

// Allow the desktop webview (and any browser client) to call the API. Auth is
// a Bearer master key with no cookies, so a wildcard origin is safe. Placed
// before the auth gate so CORS preflight (OPTIONS, which carries no auth
// header) is answered without hitting requireMasterKey. Harmless to the mobile
// RN client, which isn't subject to CORS.
app.use(
  "/api/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type"],
    maxAge: 86400,
  }),
);

// Gate the whole API behind the master key. Docs UI at "/" stays open.
app.use("/api/*", requireMasterKey);

const openapi = fromHono(app, {
  docs_url: "/",
});

// Books
openapi.post("/api/books", BookCreate);
openapi.get("/api/books", BookList);
openapi.get("/api/books/:bookId", BookFetch);
openapi.patch("/api/books/:bookId", BookUpdate);
openapi.delete("/api/books/:bookId", BookDelete);
openapi.get("/api/books/:bookId/status", BookStatus);
openapi.get("/api/books/:bookId/export", BookExport);
openapi.post("/api/books/:bookId/requeue", BookRequeue);
openapi.post("/api/books/:bookId/pause", BookPause);
openapi.post("/api/books/:bookId/resume", BookResume);

// Works (the abstract book; a book row is one copy of a work)
openapi.post("/api/works", WorkCreate);
openapi.get("/api/works", WorkList);
openapi.get("/api/works/:workId", WorkFetch);
openapi.patch("/api/works/:workId", WorkUpdate);
openapi.delete("/api/works/:workId", WorkDelete);
openapi.get("/api/tags", TagList);

// Files
openapi.post("/api/books/:bookId/files", FileUpload);
openapi.patch("/api/books/:bookId/files/:fileId", FileUpdate);
openapi.delete("/api/books/:bookId/files/:fileId", FileDelete);
openapi.post("/api/books/:bookId/files/:fileId/ocr", FileOcr);
openapi.get("/api/books/:bookId/files/:fileId/text", FileText);
openapi.patch("/api/books/:bookId/files/:fileId/text", FileTextEdit);
openapi.get("/api/books/:bookId/files/:fileId/text/history", FileTextHistory);
openapi.get("/api/books/:bookId/files/:fileId/image", FileImage);
openapi.post("/api/books/:bookId/files/:fileId/highlight", FileHighlight);

// Search indexing (writes only; clients query Meilisearch directly with a
// read-only key — see infra/meili). Reindex rebuilds the index from R2.
openapi.post("/api/search/reindex", SearchReindex);

// Admin: recompute the OCR run metrics cache (lib/metrics.ts) in pages.
openapi.post("/api/admin/ocr-runs/recompute-metrics", OcrRunsRecomputeMetrics);

// HTTP via Hono; queue consumer transcribes uploaded files.
export default {
  fetch: withRequestEvent(async (request, env: Env, ctx: ExecutionContext) =>
    app.fetch(request, env, ctx),
  ),
  queue: handleOcrQueue,
} satisfies ExportedHandler<Env, QueueMessage>;
