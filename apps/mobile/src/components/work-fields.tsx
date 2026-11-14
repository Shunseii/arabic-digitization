import { Feather } from "@expo/vector-icons";
import type { WorkWithCounts } from "@qiraa/shared";
import { useState } from "react";
import { Pressable, View } from "react-native";
import {
  Chip,
  Divider,
  FieldLabel,
  Input,
  SearchField,
  Sheet,
  T,
} from "@/components/ui";
import { matchesSearch } from "@/lib/text";
import { useColors } from "@/theme";

/** Which work a book belongs to: none (ungrouped), a new one, or an existing one. */
export type WorkChoice =
  | { kind: "none" }
  | { kind: "new" }
  | { kind: "existing"; id: string };

export const describeWork = (work: WorkWithCounts): string => {
  const copies = `${work.copies_total} ${work.copies_total === 1 ? "copy" : "copies"}`;
  return work.tags.length > 0 ? `${copies} · ${work.tags.join(", ")}` : copies;
};

export const WorkOption = ({
  selected,
  title,
  subtitle,
  arabic = false,
  onPress,
}: {
  selected: boolean;
  title: string;
  subtitle: string;
  arabic?: boolean;
  onPress: () => void;
}) => (
  <Pressable
    onPress={onPress}
    accessibilityRole="radio"
    accessibilityState={{ selected }}
    className="flex-row items-center gap-3 py-2.5 active:opacity-70"
  >
    <View
      className={`h-5 w-5 items-center justify-center rounded-full border-2 ${selected ? "border-accent" : "border-ink-3"}`}
    >
      {selected ? (
        <View className="h-2.5 w-2.5 rounded-full bg-accent" />
      ) : null}
    </View>
    <View className="flex-1">
      <T
        variant={arabic ? "arSmall" : "bodyStrong"}
        className={arabic ? "text-left" : ""}
        style={arabic ? { writingDirection: "auto" } : undefined}
        numberOfLines={1}
      >
        {title}
      </T>
      <T variant="caption" className="font-body text-ink-3" numberOfLines={1}>
        {subtitle}
      </T>
    </View>
  </Pressable>
);

const isSelected = (choice: WorkChoice, option: WorkChoice): boolean =>
  choice.kind === option.kind &&
  (choice.kind !== "existing" ||
    (option.kind === "existing" && choice.id === option.id));

const choiceSummary = ({
  value,
  works,
}: {
  value: WorkChoice;
  works: WorkWithCounts[];
}): { title: string; subtitle: string; arabic: boolean } => {
  if (value.kind === "none")
    return { title: "No work", subtitle: "Shown as ungrouped", arabic: false };
  if (value.kind === "new")
    return {
      title: "New work",
      subtitle: "Created from the title",
      arabic: false,
    };
  const work = works.find((w) => w.id === value.id);
  return work
    ? { title: work.name, subtitle: describeWork(work), arabic: true }
    : { title: "Unknown work", subtitle: "", arabic: false };
};

/** Work field: shows the current choice; tapping opens a searchable drawer. */
export const WorkPicker = ({
  works,
  value,
  onChange,
  allowNone = false,
}: {
  works: WorkWithCounts[];
  value: WorkChoice;
  onChange: (choice: WorkChoice) => void;
  allowNone?: boolean;
}) => {
  const c = useColors();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const summary = choiceSummary({ value, works });
  const matches = works.filter((w) =>
    matchesSearch({ query, fields: [w.name, w.author, ...w.tags] }),
  );
  const choose = (choice: WorkChoice) => {
    onChange(choice);
    setOpen(false);
  };
  const close = () => {
    setOpen(false);
    setQuery("");
  };

  return (
    <View className="gap-1">
      <FieldLabel>Work</FieldLabel>
      <T variant="caption" className="font-body text-ink-3">
        Copies of the same text share a work, so they group together.
      </T>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`Work: ${summary.title}. Change`}
        className="mt-1.5 min-h-[58px] flex-row items-center gap-3 rounded-xl border border-line bg-surface px-3.5 py-2.5 active:opacity-70"
      >
        <View className="flex-1">
          <T
            variant={summary.arabic ? "arSmall" : "bodyStrong"}
            className={summary.arabic ? "text-left" : ""}
            style={summary.arabic ? { writingDirection: "auto" } : undefined}
            numberOfLines={1}
          >
            {summary.title}
          </T>
          {summary.subtitle ? (
            <T
              variant="caption"
              className="font-body text-ink-3"
              numberOfLines={1}
            >
              {summary.subtitle}
            </T>
          ) : null}
        </View>
        <Feather name="chevron-down" size={18} color={c.ink3} />
      </Pressable>

      <Sheet
        visible={open}
        onClose={close}
        title="Choose work"
        scrollable
        tall
        stickyContent={
          <SearchField
            value={query}
            onChangeText={setQuery}
            placeholder="Search works, authors, tags"
          />
        }
      >
        <View className="px-5">
          {query.trim() ? null : (
            <>
              {allowNone ? (
                <WorkOption
                  selected={value.kind === "none"}
                  title="No work"
                  subtitle="Shown as ungrouped"
                  onPress={() => choose({ kind: "none" })}
                />
              ) : null}
              <WorkOption
                selected={value.kind === "new"}
                title="New work"
                subtitle="Created from the title"
                onPress={() => choose({ kind: "new" })}
              />
              {works.length > 0 ? (
                <View className="my-1.5">
                  <Divider />
                </View>
              ) : null}
            </>
          )}
          {matches.map((w) => (
            <WorkOption
              key={w.id}
              selected={isSelected(value, { kind: "existing", id: w.id })}
              title={w.name}
              subtitle={describeWork(w)}
              arabic
              onPress={() => choose({ kind: "existing", id: w.id })}
            />
          ))}
          {query.trim() && matches.length === 0 ? (
            <T variant="small" className="mt-4 text-center text-ink-3">
              No works match.
            </T>
          ) : null}
        </View>
      </Sheet>
    </View>
  );
};

export const TagEditor = ({
  tags,
  onChange,
  label = "Tags · optional",
  helper,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
  label?: string;
  helper?: string;
}) => {
  const c = useColors();
  const [input, setInput] = useState("");
  const add = () => {
    const t = input.trim();
    if (t && !tags.includes(t)) onChange([...tags, t]);
    setInput("");
  };
  return (
    <View className="gap-2.5">
      <View className="gap-1">
        <FieldLabel>{label}</FieldLabel>
        {helper ? (
          <T variant="caption" className="font-body text-ink-3">
            {helper}
          </T>
        ) : null}
      </View>
      <View className="flex-row flex-wrap gap-2">
        {tags.map((t) => (
          <Chip
            key={t}
            label={t}
            removable
            onPress={() => onChange(tags.filter((x) => x !== t))}
          />
        ))}
        <Input
          value={input}
          onChangeText={setInput}
          onSubmitEditing={add}
          onBlur={add}
          blurOnSubmit={false}
          placeholder="+ Add tag"
          placeholderTextColor={c.ink}
          returnKeyType="done"
          autoCapitalize="none"
          className="h-[34px] min-w-24 rounded-full border border-line bg-surface px-3.5 font-body-medium text-[13px] text-ink"
        />
      </View>
    </View>
  );
};
