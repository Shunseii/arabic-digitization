import { fromHono } from "chanfana";
import { Hono } from "hono";
import { LLMS_TXT } from "./docs";
import { BookCreate } from "./endpoints/bookCreate";
import { BookExport } from "./endpoints/bookExport";
import { BookFetch } from "./endpoints/bookFetch";
import { BookList } from "./endpoints/bookList";
import { BookStatus } from "./endpoints/bookStatus";
import { FileOcr } from "./endpoints/fileOcr";
import { FileText } from "./endpoints/fileText";
import { FileUpload } from "./endpoints/fileUpload";
import { requireMasterKey } from "./middleware/auth";
import { handleOcrQueue, type OcrMessage } from "./queue";

const app = new Hono<{ Bindings: Env }>();

// Public LLM-oriented API reference (for a local skill). Before the gate.
app.get("/llms.txt", (c) =>
  c.body(LLMS_TXT, 200, { "content-type": "text/markdown; charset=utf-8" }),
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
openapi.get("/api/books/:bookId/status", BookStatus);
openapi.get("/api/books/:bookId/export", BookExport);

// Files
openapi.post("/api/books/:bookId/files", FileUpload);
openapi.post("/api/books/:bookId/files/:fileId/ocr", FileOcr);
openapi.get("/api/books/:bookId/files/:fileId/text", FileText);

// HTTP via Hono; queue consumer transcribes uploaded files.
export default {
  fetch: app.fetch,
  queue: handleOcrQueue,
} satisfies ExportedHandler<Env, OcrMessage>;
