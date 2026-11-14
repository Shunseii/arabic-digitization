import { Feather } from "@expo/vector-icons";
import type { BookWithStatus } from "@qiraa/shared";
import { useRouter } from "expo-router";
import { Fragment } from "react";
import { Pressable, View } from "react-native";
import { Divider, ProgressRing, T } from "@/components/ui";
import { useColors } from "@/theme";

export const inFlightCount = (book: BookWithStatus): number =>
  (book.counts.queued ?? 0) + (book.counts.processing ?? 0);

export const transcribedCount = (book: BookWithStatus): number =>
  (book.counts.done ?? 0) + (book.counts.approved ?? 0);

export const bookProgress = (book: BookWithStatus): number =>
  book.files_total > 0 ? transcribedCount(book) / book.files_total : 0;

const BookMeta = ({ book }: { book: BookWithStatus }) => {
  const failed = book.counts.failed ?? 0;
  const inFlight = inFlightCount(book);
  const pct = Math.round(bookProgress(book) * 100);
  const status =
    failed > 0
      ? {
          label: `${failed} failed`,
          className: "font-body-semibold text-danger",
        }
      : inFlight > 0
        ? {
            label: `${inFlight} in queue`,
            className: "font-body-semibold text-accent",
          }
        : pct >= 100
          ? { label: "all transcribed", className: "text-ink-3" }
          : { label: `${pct}%`, className: "font-body-semibold text-ink-2" };
  return (
    <View className="flex-row items-center gap-1.5">
      <T variant="small" className="text-ink-3">
        {book.files_total} {book.files_total === 1 ? "page" : "pages"}
      </T>
      <T variant="small" className="text-ink-3">
        ·
      </T>
      <T variant="small" className={status.className}>
        {status.label}
      </T>
    </View>
  );
};

export const BookRow = ({
  book,
  compact = false,
}: {
  book: BookWithStatus;
  compact?: boolean;
}) => {
  const c = useColors();
  const router = useRouter();
  const progress = bookProgress(book);
  const tone =
    (book.counts.failed ?? 0) > 0 ? "danger" : progress >= 1 ? "ok" : "accent";
  return (
    <Pressable
      onPress={() => router.push(`/book/${book.id}`)}
      className="flex-row items-center gap-3.5 py-3.5 active:opacity-70"
    >
      <ProgressRing value={progress} tone={tone} size={compact ? 44 : 50} />
      <View className="flex-1 gap-0.5">
        <T
          variant="arSmall"
          className="font-ar-bold text-lg"
          style={{ textAlign: "left" }}
          numberOfLines={1}
        >
          {book.title}
        </T>
        <BookMeta book={book} />
      </View>
      <Feather name="chevron-right" size={18} color={c.ink3} />
    </Pressable>
  );
};

/** Book rows separated by hairlines, for use inside a card. */
export const BookRows = ({
  books,
  compact = false,
}: {
  books: BookWithStatus[];
  compact?: boolean;
}) => (
  <>
    {books.map((book, index) => (
      <Fragment key={book.id}>
        {index > 0 ? <Divider /> : null}
        <BookRow book={book} compact={compact} />
      </Fragment>
    ))}
  </>
);
