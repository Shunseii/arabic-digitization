/** Folds case, tashkeel, tatweel and Arabic letter variants for matching. */
export const normalizeForSearch = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .trim();

export const matchesSearch = ({
  query,
  fields,
}: {
  query: string;
  fields: (string | null | undefined)[];
}): boolean => {
  const needle = normalizeForSearch(query);
  if (!needle) return true;
  return fields.some((f) => !!f && normalizeForSearch(f).includes(needle));
};
