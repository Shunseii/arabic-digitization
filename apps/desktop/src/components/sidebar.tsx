import { useQuery } from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  BookOpen,
  ChartColumn,
  Settings,
  TextSearch,
} from "lucide-react";
import { NavLink, useLocation } from "react-router-dom";
import { cx } from "@/components/ui";
import { api } from "@/lib/api";
import { useConfigState } from "@/lib/config-context";

interface Destination {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Other routes that belong to this destination (a book belongs to Library). */
  owns?: RegExp;
}

const LIBRARY: Destination = {
  to: "/",
  label: "Library",
  icon: BookOpen,
  owns: /^\/(book|work|upload|reader|new-book)(\/|$)/,
};
const SEARCH: Destination = {
  to: "/search",
  label: "Search",
  icon: TextSearch,
};
const ACTIVITY: Destination = {
  to: "/activity",
  label: "Activity",
  icon: Activity,
};
const USAGE: Destination = { to: "/usage", label: "Usage", icon: ChartColumn };
const SETTINGS: Destination = {
  to: "/settings",
  label: "Settings",
  icon: Settings,
};

const NavItem = ({
  destination,
  trailing,
  className,
}: {
  destination: Destination;
  trailing?: string;
  className?: string;
}) => {
  const { pathname } = useLocation();
  const { to, label, icon: Icon, owns } = destination;
  const owned = owns?.test(pathname) ?? false;
  return (
    <NavLink
      to={to}
      end={to === "/"}
      className={({ isActive }) =>
        cx(
          "flex h-10 items-center gap-3 rounded-sm px-3 text-body",
          isActive || owned
            ? "bg-accent-soft font-semibold text-accent"
            : "text-ink-2 hover:bg-surface-2 hover:text-ink",
          className,
        )
      }
    >
      <Icon size={18} className="shrink-0" />
      <span className="flex-1">{label}</span>
      {trailing && (
        <span className="text-small font-semibold text-danger">{trailing}</span>
      )}
    </NavLink>
  );
};

export const Sidebar = () => {
  const { configured } = useConfigState();
  // Shares the Library's cache entry: refreshed with it, never on its own.
  const books = useQuery({
    queryKey: ["books"],
    queryFn: api.listBooks,
    enabled: configured,
  });
  const failed = (books.data ?? []).reduce(
    (n, b) => n + (b.counts.failed ?? 0),
    0,
  );

  return (
    <nav className="flex w-[232px] shrink-0 flex-col gap-1 border-r border-line bg-surface px-4 pb-3 pt-8">
      <div className="flex flex-col px-3 pb-5">
        <span dir="rtl" className="font-ar text-number font-bold text-accent">
          رقمنة
        </span>
        <span className="text-small text-ink-3">Arabic digitization</span>
      </div>
      <NavItem destination={LIBRARY} />
      <NavItem destination={SEARCH} />
      <NavItem
        destination={ACTIVITY}
        trailing={configured && failed > 0 ? `${failed} failed` : undefined}
      />
      <NavItem destination={USAGE} />
      <NavItem destination={SETTINGS} className="mt-auto" />
      <div className="mt-3 flex items-center gap-2 border-t border-line p-3">
        <span
          className={cx(
            "size-2 rounded-full",
            configured ? "bg-ok" : "bg-ink-3",
          )}
        />
        <span
          className={cx(
            "text-small font-medium",
            configured ? "text-ok" : "text-ink-2",
          )}
        >
          {configured ? "Online" : "Offline"}
        </span>
      </div>
    </nav>
  );
};
