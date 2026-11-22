import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { discardRevision, indexPage, saveRevision } from "../lib/pageText";
import type { AppContext } from "../types";

const TextEdit = z.object({
  old: z
    .string()
    .describe(
      "Exact text to replace; must occur exactly once in the page. Empty only when the page is empty.",
    ),
  new: z.string().describe("Replacement text (empty deletes `old`)"),
});

const EditBody = z.object({
  edits: TextEdit.array().min(1).max(200),
  note: z
    .string()
    .max(500)
    .optional()
    .describe("Why, or who made it (kept in the page's history)"),
});

const ErrorBody = z.object({ success: z.boolean(), error: z.string() });

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
  edits: z.infer<typeof TextEdit>[];
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
export class FileTextEdit extends OpenAPIRoute {
  schema = {
    tags: ["Files"],
    summary: "Edit a file's transcription (exact find-and-replace)",
    request: {
      params: z.object({ bookId: z.string(), fileId: z.string() }),
      body: { content: { "application/json": { schema: EditBody } } },
    },
    responses: {
      "200": {
        description: "Edits applied (or nothing changed)",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              file_id: z.string(),
              changed: z.boolean(),
              revision_id: z.number().int().nullable(),
              text_edited_at: z.number().int().nullable(),
            }),
          },
        },
      },
      "404": {
        description: "No such file",
        content: { "application/json": { schema: ErrorBody } },
      },
      "409": {
        description:
          "Page not transcribed, being re-OCR'd, or changed during the edit (re-read and retry)",
        content: { "application/json": { schema: ErrorBody } },
      },
      "422": {
        description: "An edit did not match exactly once; nothing was applied",
        content: {
          "application/json": {
            schema: ErrorBody.extend({
              failed_edit: z.number().int(),
              reason: z.string(),
            }),
          },
        },
      },
    },
  };

  async handle(c: AppContext) {
    const { params, body } = await this.getValidatedData<typeof this.schema>();

    const file = await c.env.DB.prepare(
      "SELECT text_key, state, text_edited_at FROM files WHERE file_id = ? AND book_id = ?",
    )
      .bind(params.fileId, params.bookId)
      .first<{
        text_key: string | null;
        state: string;
        text_edited_at: number | null;
      }>();
    if (!file) {
      return c.json(
        { success: false, error: `File '${params.fileId}' not found` },
        404,
      );
    }
    if (file.state !== "done" || !file.text_key) {
      return c.json(
        {
          success: false,
          error: `File is '${file.state}', not transcribed; edit it once OCR is done`,
        },
        409,
      );
    }

    const obj = await c.env.BUCKET.get(file.text_key);
    if (!obj) {
      return c.json({ success: false, error: "Transcription missing" }, 404);
    }
    const previous = await obj.text();

    const result = applyEdits({ text: previous, edits: body.edits });
    if (!result.ok) {
      return c.json(
        {
          success: false,
          error: `Edit ${result.index} ${result.reason}; nothing was applied`,
          failed_edit: result.index,
          reason: result.reason,
        },
        422,
      );
    }
    if (result.text === previous) {
      return c.json({
        success: true,
        file_id: params.fileId,
        changed: false,
        revision_id: null,
        text_edited_at: file.text_edited_at,
      });
    }

    // Keep the current text in the history first, so it is never lost.
    const revision = await saveRevision({
      env: c.env,
      bookId: params.bookId,
      fileId: params.fileId,
      previous,
      next: result.text,
      change: "edit",
      note: body.note ?? null,
    });

    // Write only if the text is still what we read, so a concurrent edit or
    // re-OCR is never silently overwritten.
    const written = await c.env.BUCKET.put(file.text_key, result.text, {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
      onlyIf: { etagMatches: obj.etag },
    });
    if (!written) {
      if (revision) await discardRevision({ env: c.env, revision });
      return c.json(
        {
          success: false,
          error: "The page changed while editing; re-read it and retry",
        },
        409,
      );
    }

    const now = Date.now();
    await c.env.DB.prepare(
      "UPDATE files SET preview = ?, text_edited_at = ?, updated_at = ? WHERE file_id = ?",
    )
      .bind(result.text.slice(0, 120), now, now, params.fileId)
      .run();

    await indexPage({ env: c.env, fileId: params.fileId, text: result.text });

    return c.json({
      success: true,
      file_id: params.fileId,
      changed: true,
      revision_id: revision?.id ?? null,
      text_edited_at: now,
    });
  }
}
