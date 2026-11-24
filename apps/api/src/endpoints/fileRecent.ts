import { Effect, Schema } from "effect";
import { HttpApiEndpoint, OpenApi } from "effect/http-api";
import { type EndpointHandler, WorkerContext } from "../http/context";
import { respond } from "../http/respond";
import { RecentFile } from "../types";
import {
  FILE_STATUS_COLUMNS,
  type FileStatusRow,
  toFileStatus,
} from "./bookStatus";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

// The most recently updated files across every book (for an activity feed),
// so a client doesn't fetch every book's status to keep a handful. Walks
// idx_files_updated from the newest and stops at the limit; the inner LIMIT
// keeps the book join to just the returned rows.
export const FileRecent = HttpApiEndpoint.get(
  "fileRecent",
  "/api/files/recent",
  {
    query: {
      limit: Schema.optionalKey(
        Schema.Int.check(
          Schema.isGreaterThanOrEqualTo(1),
          Schema.isLessThanOrEqualTo(MAX_LIMIT),
        ).annotate({
          description: `How many files (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT})`,
        }),
      ),
    },
    success: Schema.Struct({
      success: Schema.Boolean,
      files: Schema.Array(RecentFile),
    }),
  },
).annotate(
  OpenApi.Summary,
  "List the most recently updated files across all books",
);

export const fileRecent: EndpointHandler<typeof FileRecent> = ({ query }) =>
  Effect.gen(function* () {
    const { env } = yield* WorkerContext;
    const { results } = yield* Effect.promise(() =>
      env.DB.prepare(
        `SELECT f.*, b.title AS book_title
		   FROM (SELECT ${FILE_STATUS_COLUMNS}, book_id FROM files
		          ORDER BY updated_at DESC LIMIT ?) f
		   JOIN books b ON b.id = f.book_id
		  ORDER BY f.updated_at DESC`,
      )
        .bind(query.limit ?? DEFAULT_LIMIT)
        .all<FileStatusRow & { book_id: string; book_title: string }>(),
    );
    return respond({
      endpoint: FileRecent,
      body: {
        success: true,
        files: results.map(({ book_id, book_title, ...row }) => ({
          ...toFileStatus(row),
          book_id,
          book_title,
        })),
      },
    });
  });
