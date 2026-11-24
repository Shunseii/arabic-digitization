import { Effect, Layer, Logger } from "effect";
import { describe, expect, it } from "vitest";
import { RateLimited } from "../src/effect/errors";
import { AnthropicGateway, WallClock } from "../src/effect/services";
import { buildHighlight, cleanText, locateSpans } from "../src/lib/highlight";
import {
  type ProviderReply,
  ScriptedProvider,
  steppingClock,
} from "./support/fakes";

function slice(text: string, [start, end]: [number, number]): string {
  return text.slice(start, end);
}

describe("locateSpans", () => {
  it("finds a span the model returned without the page's square brackets", () => {
    const text = "قال الشيخ [رحمه الله] في كتابه";
    const [span] = locateSpans({ rawSpans: ["قال الشيخ رحمه الله"], text });
    expect(span?.ranges).toHaveLength(1);
    expect(slice(text, span?.ranges[0] ?? [0, 0])).toBe("قال الشيخ [رحمه الله");
  });

  it("finds a bracketed span inside plain page text", () => {
    const text = "وهذا هو الصواب عند أهل العلم";
    const [span] = locateSpans({ rawSpans: ["[هو الصواب]"], text });
    expect(slice(text, span?.ranges[0] ?? [0, 0])).toBe("هو الصواب");
  });

  it("ignores diacritics, footnote markers and letter variants", () => {
    const text = "إِنَّ الصَّلَاةَ(١) خَيْرٌ";
    const [span] = locateSpans({ rawSpans: ["ان الصلاة خير"], text });
    expect(span?.ranges).toHaveLength(1);
    // The range ends at the last letter, so a trailing diacritic stays outside.
    expect(slice(text, span?.ranges[0] ?? [0, 0])).toBe("إِنَّ الصَّلَاةَ(١) خَيْر");
  });

  it("returns every occurrence and drops spans that are not on the page", () => {
    const text = "العلم نور، والعلم حياة";
    const spans = locateSpans({ rawSpans: ["العلم", "الجهل"], text });
    expect(spans).toHaveLength(1);
    expect(spans[0]?.ranges).toHaveLength(2);
  });
});

function highlightWith(replies: ProviderReply[]) {
  const gateway = new ScriptedProvider(replies);
  const layer = Layer.mergeAll(
    Layer.succeed(AnthropicGateway, { messages: gateway.call }),
    Layer.succeed(WallClock, steppingClock()),
    Logger.layer([]),
  );
  const page = "## باب\n\nالصلاة عماد الدين [وهي أول ما يحاسب عليه]";
  return {
    gateway,
    run: () =>
      Effect.runPromise(
        buildHighlight({ query: "prayer", pageMarkdown: page }).pipe(
          Effect.provide(layer),
        ),
      ),
  };
}

describe("buildHighlight", () => {
  it("asks Haiku for spans with structured output and locates them", async () => {
    const { gateway, run } = highlightWith([
      {
        json: {
          content: [
            {
              type: "text",
              text: JSON.stringify({ spans: ["وهي أول ما يحاسب عليه", " "] }),
            },
          ],
          usage: { input_tokens: 300, output_tokens: 20 },
        },
      },
    ]);

    const result = await run();

    expect(result.text).toBe(
      cleanText("## باب\n\nالصلاة عماد الدين [وهي أول ما يحاسب عليه]"),
    );
    expect(result.spans).toHaveLength(1);
    expect(slice(result.text, result.spans[0]?.ranges[0] ?? [0, 0])).toBe(
      "وهي أول ما يحاسب عليه",
    );
    const body = gateway.requests[0]?.body as {
      model: string;
      output_config: { format: { type: string } };
    };
    expect(body.model).toBe("claude-haiku-5-5");
    expect(body.output_config.format.type).toBe("json_schema");
  });

  it("fails with the typed error when the gateway rate-limits", async () => {
    const { run } = highlightWith([
      {
        error: new RateLimited({
          provider: "claude",
          detail: "busy",
          retryAfterSeconds: 5,
        }),
      },
    ]);

    await expect(run()).rejects.toMatchObject({ _tag: "RateLimited" });
  });

  it("fails with BadResponse on unparseable structured output", async () => {
    const { run } = highlightWith([
      { json: { content: [{ type: "text", text: "not json" }], usage: {} } },
    ]);

    await expect(run()).rejects.toMatchObject({ _tag: "BadResponse" });
  });
});
