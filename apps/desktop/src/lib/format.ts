export const count = (n: number) => n.toLocaleString("en-US");

export const plural = ({
  n,
  one,
  many,
}: {
  n: number;
  one: string;
  many: string;
}) => `${count(n)} ${n === 1 ? one : many}`;

/** "now", "3 m", "2 h", "4 d": how long ago an epoch-ms time was. */
export const ago = (ms: number): string => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)} m`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
};

export const usd = (n: number) => `$${n.toFixed(2)}`;
