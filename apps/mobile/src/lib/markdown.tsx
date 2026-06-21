import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { colors } from "@/theme";

const RTL = { writingDirection: "rtl", textAlign: "right" } as const;
const RUBY = /<ruby>(.*?)<rt>(.*?)<\/rt><\/ruby>/g;

/**
 * Renders the Markdown the OCR pipeline produces (see apps/api/src/ocr.ts):
 * `##`/`###` headings, `---` dividers, `### الحاشية` footnotes, and inline
 * `<ruby>base<rt>gloss</rt></ruby>` interlinear glosses — all right-to-left.
 * Every text block is `selectable` so the OS highlight/copy works.
 * Intentionally small and dependency-free rather than a full CommonMark parser.
 */

const inline = (text: string, keyBase: string): ReactNode[] => {
  const nodes: ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  RUBY.lastIndex = 0;
  let i = 0;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
  while ((match = RUBY.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    nodes.push(
      <Text key={`${keyBase}-r${i}`}>
        {match[1]}
        <Text style={{ fontSize: 13, color: colors.accent }}>
          {" "}
          ({match[2]})
        </Text>
      </Text>,
    );
    last = match.index + match[0].length;
    i += 1;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes.length > 0 ? nodes : [text];
};

export const Markdown = ({ source }: { source: string }) => {
  const lines = source.split(/\r?\n/);
  const firstContent = lines.findIndex((l) => l.trim().length > 0);
  const blocks: ReactNode[] = [];
  let inFootnotes = false;

  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line) return;
    const key = `l${index}`;

    if (line === "---") {
      blocks.push(
        <View
          key={key}
          style={{
            height: 1,
            backgroundColor: colors.hairline,
            alignSelf: "stretch",
          }}
        />,
      );
      return;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const content = heading[2];
      if (content.includes("الحاشية")) {
        inFootnotes = true;
        blocks.push(
          <Text
            key={key}
            selectable
            style={{
              ...RTL,
              color: colors.textMuted,
              fontSize: 13,
              fontWeight: "700",
              marginTop: 8,
            }}
          >
            {inline(content, key)}
          </Text>,
        );
        return;
      }
      const major = level <= 2;
      blocks.push(
        <Text
          key={key}
          selectable
          style={{
            ...RTL,
            marginTop: major ? 8 : 4,
            fontSize: major ? 22 : 17,
            fontWeight: major ? "700" : "600",
            color: major ? colors.accent : colors.ink,
          }}
        >
          {inline(content, key)}
        </Text>,
      );
      return;
    }

    if (index === firstContent) {
      blocks.push(
        <Text
          key={key}
          selectable
          style={{
            writingDirection: "rtl",
            textAlign: "center",
            color: colors.textMuted,
            fontSize: 13,
          }}
        >
          {inline(line, key)}
        </Text>,
      );
      return;
    }

    blocks.push(
      <Text
        key={key}
        selectable
        style={{
          ...RTL,
          color: inFootnotes ? colors.textSecondary : colors.ink,
          fontSize: inFootnotes ? 15 : 19,
          lineHeight: inFootnotes ? 26 : 34,
        }}
      >
        {inline(line, key)}
      </Text>,
    );
  });

  return <View style={{ gap: 12 }}>{blocks}</View>;
};
