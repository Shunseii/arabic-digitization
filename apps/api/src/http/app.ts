// The Worker's HTTP surface: the /api endpoints as an Effect HttpApi (schemas,
// auth, validation and the OpenAPI spec all come from the definitions below),
// plus the public routes, CORS for /api, and the fallbacks.

import { Cause, Effect, Layer, Option, type Types } from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerError,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiGroup,
  OpenApi,
} from "effect/http-api";
import { EvlogLogger } from "evlog/effect";
import { LLMS_TXT } from "../docs";
import { BookCreate, bookCreate } from "../endpoints/bookCreate";
import { BookDelete, bookDelete } from "../endpoints/bookDelete";
import { BookExport, bookExport } from "../endpoints/bookExport";
import { BookFetch, bookFetch } from "../endpoints/bookFetch";
import { BookList, bookList } from "../endpoints/bookList";
import {
  BookPause,
  BookResume,
  bookPause,
  bookResume,
} from "../endpoints/bookPause";
import { BookRequeue, bookRequeue } from "../endpoints/bookRequeue";
import { BookReview, bookReview } from "../endpoints/bookReview";
import { BookStatus, bookStatus } from "../endpoints/bookStatus";
import { BookUpdate, bookUpdate } from "../endpoints/bookUpdate";
import { FileDelete, fileDelete } from "../endpoints/fileDelete";
import { FileHighlight, fileHighlight } from "../endpoints/fileHighlight";
import { FileImage, fileImage } from "../endpoints/fileImage";
import { FileOcr, fileOcr } from "../endpoints/fileOcr";
import { FileRecent, fileRecent } from "../endpoints/fileRecent";
import { FileReviews, fileReviews } from "../endpoints/fileReviews";
import { FileText, fileText } from "../endpoints/fileText";
import { FileTextEdit, fileTextEdit } from "../endpoints/fileTextEdit";
import { FileTextHistory, fileTextHistory } from "../endpoints/fileTextHistory";
import { FileUpdate, fileUpdate } from "../endpoints/fileUpdate";
import { FileUpload, fileUpload } from "../endpoints/fileUpload";
import { Jobs, jobs } from "../endpoints/jobs";
import {
  OcrRunsRecomputeMetrics,
  ocrRunsRecomputeMetrics,
} from "../endpoints/ocrRunsRecomputeMetrics";
import { ReviewSummary, reviewSummary } from "../endpoints/reviewSummary";
import { scanSigned } from "../endpoints/scanSigned";
import { SearchReindex, searchReindex } from "../endpoints/searchReindex";
import { TagList, tagList } from "../endpoints/tagList";
import { WorkCreate, workCreate } from "../endpoints/workCreate";
import { WorkDelete, workDelete } from "../endpoints/workDelete";
import { WorkFetch, workFetch } from "../endpoints/workFetch";
import { WorkList, workList } from "../endpoints/workList";
import { WorkUpdate, workUpdate } from "../endpoints/workUpdate";
import { recordRoute } from "../logging";
import { WorkerContext } from "./context";
import {
  Authorization,
  AuthorizationLive,
  checkMasterKey,
  InputValidation,
  InputValidationLive,
} from "./middleware";
import { SWAGGER_HTML } from "./swagger";

export const Api = HttpApi.make("api")
  .add(
    HttpApiGroup.make("Books").add(
      BookCreate,
      BookList,
      BookFetch,
      BookUpdate,
      BookDelete,
      BookExport,
      BookRequeue,
      BookPause,
      BookResume,
      BookReview,
    ),
  )
  .add(
    // Works (the abstract book; a book row is one copy of a work)
    HttpApiGroup.make("Works").add(
      WorkCreate,
      WorkList,
      WorkFetch,
      WorkUpdate,
      WorkDelete,
      TagList,
    ),
  )
  .add(
    HttpApiGroup.make("Files").add(
      BookStatus,
      FileRecent,
      FileUpload,
      FileUpdate,
      FileDelete,
      FileOcr,
      FileText,
      FileTextEdit,
      FileTextHistory,
      FileReviews,
      FileImage,
      FileHighlight,
    ),
  )
  // Search indexing (writes only; clients query Meilisearch directly with a
  // read-only key — see infra/meili). Reindex rebuilds the index from R2.
  .add(HttpApiGroup.make("Search").add(SearchReindex))
  // Running work and the Opus review's usage (read-only views over D1).
  .add(HttpApiGroup.make("Activity").add(Jobs, ReviewSummary))
  // Admin: recompute the OCR run metrics cache (lib/metrics.ts) in pages.
  .add(HttpApiGroup.make("Admin").add(OcrRunsRecomputeMetrics))
  .middleware(InputValidation)
  .middleware(Authorization)
  // Report every invalid field, not just the first, as clients always got.
  .annotate(HttpApi.PayloadParseOptions, { errors: "all" })
  .annotate(HttpApi.QueryParseOptions, { errors: "all" })
  .annotate(OpenApi.Title, "Arabic Digitization API")
  .annotate(OpenApi.Version, "1.0.0");

const BooksLive = HttpApiBuilder.group(Api, "Books", (handlers) =>
  handlers
    .handle("bookCreate", bookCreate)
    .handle("bookList", bookList)
    .handle("bookFetch", bookFetch)
    .handle("bookUpdate", bookUpdate)
    .handle("bookDelete", bookDelete)
    .handle("bookExport", bookExport)
    .handle("bookRequeue", bookRequeue)
    .handle("bookPause", bookPause)
    .handle("bookResume", bookResume)
    .handle("bookReview", bookReview),
);

const WorksLive = HttpApiBuilder.group(Api, "Works", (handlers) =>
  handlers
    .handle("workCreate", workCreate)
    .handle("workList", workList)
    .handle("workFetch", workFetch)
    .handle("workUpdate", workUpdate)
    .handle("workDelete", workDelete)
    .handle("tagList", tagList),
);

const FilesLive = HttpApiBuilder.group(Api, "Files", (handlers) =>
  handlers
    .handle("bookStatus", bookStatus)
    .handle("fileRecent", fileRecent)
    .handleRaw("fileUpload", fileUpload)
    .handle("fileUpdate", fileUpdate)
    .handle("fileDelete", fileDelete)
    .handle("fileOcr", fileOcr)
    .handle("fileText", fileText)
    .handle("fileTextEdit", fileTextEdit)
    .handle("fileTextHistory", fileTextHistory)
    .handle("fileReviews", fileReviews)
    .handle("fileImage", fileImage)
    .handle("fileHighlight", fileHighlight),
);

const SearchLive = HttpApiBuilder.group(Api, "Search", (handlers) =>
  handlers.handle("searchReindex", searchReindex),
);

const ActivityLive = HttpApiBuilder.group(Api, "Activity", (handlers) =>
  handlers.handle("jobs", jobs).handle("reviewSummary", reviewSummary),
);

const AdminLive = HttpApiBuilder.group(Api, "Admin", (handlers) =>
  handlers.handle("ocrRunsRecomputeMetrics", ocrRunsRecomputeMetrics),
);

const pathOf = (url: string) => url.split("?", 1)[0] ?? url;

// Names the request on its wide event by the route that matched.
const RouteEvent = HttpRouter.middleware((httpEffect) =>
  Effect.gen(function* () {
    const { route } = yield* HttpRouter.RouteContext;
    const request = yield* HttpServerRequest.HttpServerRequest;
    // Route middleware may only require request-level services, so the
    // per-request logger is read optionally; index.ts always sets it.
    recordRoute({
      log: Option.getOrThrow(yield* Effect.serviceOption(EvlogLogger)),
      method: request.method,
      route: route.path,
      path: pathOf(request.url),
    });
    return yield* httpEffect;
  }),
).layer;

// The OpenAPI document is built from the definitions on its first request and
// then cached, so it costs nothing at startup or on other routes.
const ApiLive = HttpApiBuilder.layer(Api, {
  openapiPath: "/openapi.json",
}).pipe(
  Layer.provide([
    BooksLive,
    WorksLive,
    FilesLive,
    SearchLive,
    ActivityLive,
    AdminLive,
  ]),
  Layer.provide([AuthorizationLive, InputValidationLive]),
);

const PublicRoutes = Layer.mergeAll(
  // Swagger UI for the spec at /openapi.json.
  HttpRouter.add("GET", "/", HttpServerResponse.html(SWAGGER_HTML)),
  // Public LLM-oriented API reference (for a local skill).
  HttpRouter.add(
    "GET",
    "/llms.txt",
    HttpServerResponse.text(LLMS_TXT, {
      contentType: "text/markdown; charset=utf-8",
    }),
  ),
  // A page scan for a signed link (lib/scanUrl), so a provider can fetch it.
  // Public on purpose: the signature is the credential.
  HttpRouter.add("GET", "/scan/:fileId", scanSigned),
);

const isApiPath = (path: string) => path === "/api" || path.startsWith("/api/");

// Allow the desktop webview (and any browser client) to call the API. Auth is
// a Bearer master key with no cookies, so a wildcard origin is safe. Preflight
// (OPTIONS, which carries no auth header) is answered before auth. Harmless to
// the mobile RN client, which isn't subject to CORS.
const PREFLIGHT_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "access-control-allow-headers": "Authorization,Content-Type",
  "access-control-max-age": "86400",
  vary: "Access-Control-Request-Headers",
};

const unauthorized = (error: string, status: number) =>
  HttpServerResponse.jsonUnsafe({ success: false, error }, { status });

// A request no route matched: under /api it still needs the master key (so an
// unknown path without one is a 401, as for known ones); otherwise a plain 404.
const notFound = ({
  env,
  request,
  path,
}: {
  env: Env;
  request: HttpServerRequest.HttpServerRequest;
  path: string;
}) => {
  if (isApiPath(path)) {
    const check = checkMasterKey({
      authorization: request.headers.authorization,
      masterKey: env.MASTER_KEY,
    });
    if (check === "not-configured") {
      return unauthorized("Server auth not configured", 500);
    }
    if (check === "unauthorized") return unauthorized("Unauthorized", 401);
  }
  return HttpServerResponse.text("404 Not Found", {
    status: 404,
    contentType: "text/plain; charset=UTF-8",
  });
};

const isRouteNotFound = (cause: Cause.Cause<unknown>) =>
  cause.reasons.some(
    (reason) =>
      Cause.isFailReason(reason) &&
      HttpServerError.isHttpServerError(reason.error) &&
      reason.error.reason._tag === "RouteNotFound",
  );

// Wraps every request: CORS for /api, the not-found fallback, and the last
// resort for anything unexpected (recorded on the wide event, answered with a
// plain 500 so no internals leak).
const Edge = HttpRouter.middleware(
  (
    httpEffect,
  ): Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    Types.unhandled,
    HttpServerRequest.HttpServerRequest | WorkerContext | EvlogLogger
  > =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const { env } = yield* WorkerContext;
      const log = yield* EvlogLogger;
      const path = pathOf(request.url);
      const api = isApiPath(path);

      if (api && request.method === "OPTIONS") {
        recordRoute({ log, method: request.method, route: "/api/*", path });
        return HttpServerResponse.empty({
          status: 204,
          headers: PREFLIGHT_HEADERS,
        });
      }

      const response = yield* Effect.catchCause(httpEffect, (cause) => {
        if (isRouteNotFound(cause)) {
          recordRoute({
            log,
            method: request.method,
            route: api ? "/api/*" : "/*",
            path,
          });
          return Effect.succeed(notFound({ env, request, path }));
        }
        log.error(toError(Cause.squash(cause)));
        return Effect.succeed(
          HttpServerResponse.text("Internal Server Error", {
            status: 500,
            contentType: "text/plain; charset=UTF-8",
          }),
        );
      });
      return api
        ? HttpServerResponse.setHeader(
            response,
            "access-control-allow-origin",
            "*",
          )
        : response;
    }),
  { global: true },
);

const toError = (error: unknown) =>
  error instanceof Error ? error : new Error(String(error));

export const AppLive = Layer.mergeAll(
  Layer.mergeAll(ApiLive, PublicRoutes).pipe(Layer.provide(RouteEvent)),
  Edge,
).pipe(Layer.provide(HttpServer.layerServices));
