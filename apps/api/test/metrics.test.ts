import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { costUsd } from "../src/lib/cost";
import { HIGHLIGHT_MODEL } from "../src/lib/highlight";
import { METRICS_VERSION, measurePage } from "../src/lib/metrics";
import { recomputeRunMetrics } from "../src/lib/ocrRuns";
import { CLAUDE_MODEL, INKLING_MODEL } from "../src/ocr";
import { makeWorld } from "./support/fakes";

const FULL_PAGE = [
  "٣٤ كتاب الصلاة",
  "",
  "---",
  "",
  "## باب فضل الصلاة",
  "",
  "قال الله تعالى: ﴿إِنَّ ٱلصَّلَوٰةَ كَانَتْ عَلَى ٱلْمُؤْمِنِينَ﴾ وقال: ﴿أقيموا الصلاة﴾ (١)",
  "[ وهذا بيان ]",
  "وفي <ruby>الحديث<rt>الخبر</rt></ruby> ما يدل على ذلك ⁽²⁾ (٣)",
  "",
  "---",
  "",
  "### الحاشية",
  "(١) رواه البخاري.",
  "(٢) رواه مسلم.",
  "٤- انظر الشرح.",
].join("\n");

describe("measurePage", () => {
  it("counts the fixed columns of a well-formed page", () => {
    const { columns } = measurePage(FULL_PAGE);
    expect(columns).toEqual({
      words: expect.any(Number),
      chars: [...FULL_PAGE].length,
      blank: 0,
      has_header: 1,
      footnote_block_ok: 1,
      headings: 1,
    });
    expect(columns.words).toBeGreaterThan(20);
  });

  it("counts Qur'an spans, Uthmani marks, glosses and loose brackets", () => {
    const { metrics } = measurePage(FULL_PAGE);
    expect(metrics).toMatchObject({
      quran_spans: 2,
      quran_spans_uthmani: 1,
      ruby_glosses: 1,
      loose_bracket_lines: 1,
    });
    // ٱ ×2 and ٰ ×1 in the first span.
    expect(metrics.uthmani_marks).toBe(3);
  });

  it("compares footnote markers in the matn with numbered footnotes", () => {
    const { metrics } = measurePage(FULL_PAGE);
    // Matn markers: 1, 2 (superscript), 3. Footnotes: 1, 2, 4.
    expect(metrics).toMatchObject({
      footnote_markers: 3,
      footnotes: 3,
      footnote_marker_mismatch: 2,
    });
  });

  it("does not count bracket lines inside the footnote block", () => {
    const page = `${FULL_PAGE}\n[ تعليق في الحاشية ]`;
    expect(measurePage(page).metrics.loose_bracket_lines).toBe(1);
  });

  it("flags a footnote block that skips the divider", () => {
    const page = "متن (١)\n### الحاشية\n(١) حاشية";
    const { columns, metrics } = measurePage(page);
    expect(columns.footnote_block_ok).toBe(0);
    expect(columns.has_header).toBe(0);
    expect(metrics.footnote_marker_mismatch).toBe(0);
  });

  it("leaves footnote_block_ok null when there are no footnotes", () => {
    expect(measurePage("سطر واحد").columns.footnote_block_ok).toBeNull();
  });

  it("measures a blank page", () => {
    expect(measurePage("").columns).toEqual({
      words: 0,
      chars: 0,
      blank: 1,
      has_header: 0,
      footnote_block_ok: null,
      headings: 0,
    });
  });
});

describe("recomputeRunMetrics", () => {
  it("updates stale runs in pages and skips runs whose text is gone", async () => {
    const world = makeWorld();
    const insert = world.sqlite.prepare(
      `INSERT INTO ocr_runs (file_id, book_id, created_at, status, primary_engine,
         delivery_attempt, calls, latency_ms, input_tokens, output_tokens, cost_usd,
         wasted_cost_usd, text_key, metrics_version)
       VALUES ('f', 'b', 1, ?, 'inkling', 1, '[]', 0, 0, 0, 0, 0, ?, ?)`,
    );
    insert.run("done", "runs/1.md", 0);
    insert.run("done", "runs/2.md", null);
    insert.run("done", "runs/gone.md", 0);
    insert.run("done", "runs/current.md", METRICS_VERSION);
    insert.run("failed", null, null);
    await Effect.runPromise(
      world.bucket.service.putText({ key: "runs/1.md", text: FULL_PAGE }),
    );
    await Effect.runPromise(
      world.bucket.service.putText({ key: "runs/2.md", text: "" }),
    );

    const recompute = (after: number) =>
      Effect.runPromise(
        recomputeRunMetrics({ after, limit: 2 }).pipe(
          Effect.provide(world.layer),
        ),
      );
    const first = await recompute(0);
    const second = await recompute(first.next_after ?? -1);

    expect(first).toEqual({
      metrics_version: METRICS_VERSION,
      updated: 2,
      missing: 0,
      next_after: 2,
    });
    expect(second).toEqual({
      metrics_version: METRICS_VERSION,
      updated: 0,
      missing: 1,
      next_after: null,
    });
    const rows = world.sqlite
      .prepare(
        "SELECT id, has_header, metrics_version, metrics FROM ocr_runs ORDER BY id",
      )
      .all() as {
      id: number;
      has_header: number | null;
      metrics_version: number | null;
      metrics: string | null;
    }[];
    expect(rows[0]).toMatchObject({
      has_header: 1,
      metrics_version: METRICS_VERSION,
    });
    expect(JSON.parse(rows[0]?.metrics ?? "{}")).toMatchObject({
      quran_spans: 2,
    });
    expect(rows[1]).toMatchObject({ metrics_version: METRICS_VERSION });
    expect(rows[2]?.metrics_version).toBe(0);
  });
});

describe("pricing", () => {
  it.each([
    INKLING_MODEL,
    CLAUDE_MODEL,
    HIGHLIGHT_MODEL,
  ])("has a price for %s", (model) => {
    expect(
      costUsd({ model, inputTokens: 1000, outputTokens: 1000 }),
    ).toBeGreaterThan(0);
  });
});
