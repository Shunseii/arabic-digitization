import { Effect, Schema } from "effect";
import { HttpApiEndpoint, OpenApi } from "effect/http-api";
import { type EndpointHandler, WorkerContext } from "../http/context";
import {
  Conflict,
  conflict,
  EditNotApplied,
  NotFound,
  notFound,
} from "../http/errors";
import { respond } from "../http/respond";
import { discardRevision, indexPage, saveRevision } from "../lib/pageText";

const TextEdit = Schema.Struct({
  old: Schema.String.annotate({
    description:
      "Exact text to replace; must occur exactly once in the page. Empty only when the page is empty.",
  }),
  new: Schema.String.annotate({
    description: "Replacement text (empty deletes `old`)",
  }),
});
type TextEdit = typeof TextEdit.Type;

const EditBody = Schema.Struct({
  edits: Schema.Array(TextEdit).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(200),
  ),
  note: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(500)).annotate({
      description: "Why, or who made it (kept in the page's history)",
    }),
  ),
});

type EditResult =
  | { ok: true; text: string }
  | { ok: false; index: number; reason: string };

// Apply edits in order; each `old` must match exactly once in the text as it
// stands after the previous edits. All or nothing.
export function applyEdits({
  text,
  edits,
}: {
  text: string;
  edits: readonly TextEdit[];
}): EditResult {
  let current = text;
  for (const [index, edit] of edits.entries()) {
    if (edit.old === "") {
      if (current !== "") {
        return {
          ok: false,
          index,
          reason: "empty `old` only fills an empty page",
        };
      }
      current = edit.new;
      continue;
    }
    const first = current.indexOf(edit.old);
    if (first === -1) return { ok: false, index, reason: "not found" };
    const count = current.split(edit.old).length - 1;
    if (count > 1) {
      return {
        ok: false,
        index,
        reason: `matches ${count} times; include more surrounding text`,
      };
    }
    current =
      current.slice(0, first) +
      edit.new +
      current.slice(first + edit.old.length);
  }
  return { ok: true, text: current };
}

// Surgical hand edits to a page's transcription. The text it replaces is kept
// in the page's history, and the page is marked hand-edited (text_edited_at)
// until a re-OCR replaces it.
export const FileTextEdit = HttpApiEndpoint.patch(
  "fileTextEdit",
  "/api/books/:bookId/files/:fileId/text",
  {
    params: { bookId: Schema.String, fileId: Schema.String },
    payload: EditBody,
    success: Schema.Struct({
      success: Schema.Boolean,
      file_id: Schema.String,
      changed: Schema.Boolean,
      revision_id: Schema.NullOr(Schema.Int),
      text_edited_at: Schema.NullOr(Schema.Int),
    }),
    error: [NotFound, Conflict, EditNotApplied],
  },
).annotate(
  OpenApi.Summary,
  "Edit a file's transcription (exact find-and-replace)",
);

export const fileTextEdit: EndpointHandler<typeof FileTextEdit> = ({
  params,
  payload: body,
}) =>
  Effect.gen(function* () {
    const { env } = yield* WorkerContext;
    const file = yield* Effect.promise(() =>
      env.DB.prepare(
        "SELECT text_key, state, text_edited_at FROM files WHERE file_id = ? AND book_id = ?",
      )
        .bind(params.fileId, params.bookId)
        .first<{
          text_key: string | null;
          state: string;
          text_edited_at: number | null;
        }>(),
    );
    if (!file) return yield* notFound(`File '${params.fileId}' not found`);
    const textKey = file.text_key;
    if (file.state !== "done" || !textKey) {
      return yield* conflict(
        `File is '${file.state}', not transcribed; edit it once OCR is done`,
      );
    }

    const obj = yield* Effect.promise(() => env.BUCKET.get(textKey));
    if (!obj) return yield* notFound("Transcription missing");
    const previous = yield* Effect.promise(() => obj.text());

    const result = applyEdits({ text: previous, edits: body.edits });
    if (!result.ok) {
      return yield* new EditNotApplied({
        success: false,
        error: `Edit ${result.index} ${result.reason}; nothing was applied`,
        failed_edit: result.index,
        reason: result.reason,
      });
    }
    if (result.text === previous) {
      return respond({
        endpoint: FileTextEdit,
        body: {
          success: true,
          file_id: params.fileId,
          changed: false,
          revision_id: null,
          text_edited_at: file.text_edited_at,
        },
      });
    }
    const next = result.text;

    // Keep the current text in the history first, so it is never lost.
    const revision = yield* Effect.promise(() =>
      saveRevision({
        env,
        bookId: params.bookId,
        fileId: params.fileId,
        previous,
        next,
        change: "edit",
        note: body.note ?? null,
      }),
    );

    // Write only if the text is still what we read, so a concurrent edit or
    // re-OCR is never silently overwritten.
    const written = yield* Effect.promise(() =>
      env.BUCKET.put(textKey, next, {
        httpMetadata: { contentType: "text/markdown; charset=utf-8" },
        onlyIf: { etagMatches: obj.etag },
      }),
    );
    if (!written) {
      if (revision) {
        yield* Effect.promise(() => discardRevision({ env, revision }));
      }
      return yield* conflict(
        "The page changed while editing; re-read it and retry",
      );
    }

    const now = Date.now();
    yield* Effect.promise(async () => {
      await env.DB.prepare(
        "UPDATE files SET preview = ?, text_edited_at = ?, updated_at = ? WHERE file_id = ?",
      )
        .bind(next.slice(0, 120), now, now, params.fileId)
        .run();
      await indexPage({ env, fileId: params.fileId, text: next });
    });

    return respond({
      endpoint: FileTextEdit,
      body: {
        success: true,
        file_id: params.fileId,
        changed: true,
        revision_id: revision?.id ?? null,
        text_edited_at: now,
      },
    });
  });
