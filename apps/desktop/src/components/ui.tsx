import type { FileState } from "@qiraa/shared";
import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { colors, statusColors, statusLabel } from "@/theme";

export const StatusDot = ({
  state,
  size = 10,
}: {
  state: FileState;
  size?: number;
}) => (
  <span
    style={{
      width: size,
      height: size,
      borderRadius: size / 2,
      backgroundColor: statusColors[state],
      display: "inline-block",
      flexShrink: 0,
    }}
  />
);

export const StatusBadge = ({ state }: { state: FileState }) => (
  <span
    className="inline-flex flex-row items-center gap-1.5 rounded-full px-2.5 py-1"
    style={{ backgroundColor: `${statusColors[state]}22` }}
  >
    <StatusDot state={state} size={6} />
    <span
      className="text-xs font-semibold"
      style={{ color: statusColors[state] }}
    >
      {statusLabel[state]}
    </span>
  </span>
);

export const Loading = () => (
  <div className="flex flex-1 items-center justify-center py-16">
    <Loader2 className="animate-spin" size={22} color={colors.accent} />
  </div>
);

export const Centered = ({ children }: { children: ReactNode }) => (
  <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
    {children}
  </div>
);
