import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { costUsd } from "../lib/cost";
import { type AppContext, BookWithStatus, type FileState } from "../types";

export class BookFetch extends OpenAPIRoute {
  schema = {
    tags: ["Books"],
    summary: "Fetch one book with its full status breakdown",
    request: {
      params: z.object({ bookId: z.string() }),
    },
    responses: {
      "200": {
        description: "The book and its per-state file counts",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              book: BookWithStatus,
            }),
          },
        },
      },
      "404": {
        description: "No such book",
        content: {
          "application/json": {
            schema: z.object({ success: z.boolean(), error: z.string() }),
          },
        },
      },
    },
  };

  async handle(c: AppContext) {
    const { params } = await this.getValidatedData<typeof this.schema>();

    const book = await c.env.DB.prepare(
      "SELECT id, title, created_at, ocr_instructions, work_id, paused FROM books WHERE id = ?",
    )
      .bind(params.bookId)
      .first<{
        id: string;
        title: string;
        created_at: number;
        ocr_instructions: string | null;
        work_id: string | null;
        paused: number;
      }>();

    if (!book) {
      return c.json(
        { success: false, error: `Book '${params.bookId}' not found` },
        404,
      );
    }

    const { results } = await c.env.DB.prepare(
      "SELECT state, n AS c FROM book_state_counts WHERE book_id = ? AND n > 0",
    )
      .bind(params.bookId)
      .all<{ state: string; c: number }>();

    const counts: Record<string, number> = {};
    let files_total = 0;
    for (const row of results) {
      counts[row.state] = row.c;
      files_total += row.c;
    }

    // Aggregate token usage + cost, grouped by model so mixed-model books price
    // correctly. cost_usd is null if any contributing model has no known price.
    const { results: usageRows } = await c.env.DB.prepare(
      `SELECT NULLIF(ocr_model, '') AS ocr_model, input_tokens, output_tokens
         FROM book_usage WHERE book_id = ? AND n > 0`,
    )
      .bind(params.bookId)
      .all<{
        ocr_model: string | null;
        input_tokens: number;
        output_tokens: number;
      }>();

    let usage: {
      input_tokens: number;
      output_tokens: number;
      cost_usd: number | null;
    } | null = null;
    if (usageRows.length > 0) {
      let inputTok = 0;
      let outputTok = 0;
      let cost = 0;
      let fullyPriced = true;
      for (const row of usageRows) {
        inputTok += row.input_tokens;
        outputTok += row.output_tokens;
        const c2 = costUsd({
          model: row.ocr_model,
          inputTokens: row.input_tokens,
          outputTokens: row.output_tokens,
        });
        if (c2 == null) fullyPriced = false;
        else cost += c2;
      }
      usage = {
        input_tokens: inputTok,
        output_tokens: outputTok,
        cost_usd: fullyPriced ? cost : null,
      };
    }

    return c.json({
      success: true,
      book: {
        ...book,
        paused: book.paused === 1,
        files_total,
        counts: counts as Record<z.infer<typeof FileState>, number>,
        usage,
      },
    });
  }
}
