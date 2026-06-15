import { fromHono } from "chanfana";
import { Hono } from "hono";
import { BookCreate } from "./endpoints/bookCreate";
import { BookFetch } from "./endpoints/bookFetch";
import { BookList } from "./endpoints/bookList";
import { FileOcr } from "./endpoints/fileOcr";
import { FileUpload } from "./endpoints/fileUpload";
import { requireMasterKey } from "./middleware/auth";
import { handleOcrQueue, type OcrMessage } from "./queue";

const app = new Hono<{ Bindings: Env }>();

// Gate the whole API behind the master key. Docs UI at "/" stays open.
app.use("/api/*", requireMasterKey);

const openapi = fromHono(app, {
  docs_url: "/",
});

// Books
openapi.post("/api/books", BookCreate);
openapi.get("/api/books", BookList);
openapi.get("/api/books/:bookId", BookFetch);

// Files
openapi.post("/api/books/:bookId/files", FileUpload);
openapi.post("/api/books/:bookId/files/:fileId/ocr", FileOcr);

// HTTP via Hono; queue consumer transcribes uploaded files.
export default {
  fetch: app.fetch,
  queue: handleOcrQueue,
} satisfies ExportedHandler<Env, OcrMessage>;
