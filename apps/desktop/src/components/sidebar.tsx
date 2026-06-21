import type { LucideIcon } from "lucide-react";
import { Activity, BookOpen, Settings } from "lucide-react";
import { NavLink } from "react-router-dom";

const items: { to: string; label: string; icon: LucideIcon }[] = [
  { to: "/", label: "Library", icon: BookOpen },
  { to: "/activity", label: "Activity", icon: Activity },
  { to: "/settings", label: "Settings", icon: Settings },
];

export const Sidebar = () => (
  <nav className="flex w-56 shrink-0 flex-col border-r border-hairline bg-surface">
    <div className="flex flex-col gap-0.5 px-4 pb-4 pt-7">
      <span className="text-sm font-bold text-accent" dir="rtl">
        رقمنة
      </span>
      <span className="text-lg font-semibold text-ink">Qiraa</span>
    </div>
    <div className="flex flex-col gap-1 px-3">
      {items.map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          end={to === "/"}
          className={({ isActive }) =>
            `flex flex-row items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition-colors ${
              isActive
                ? "bg-accent-soft text-accent"
                : "text-text-secondary hover:bg-surface-alt hover:text-ink"
            }`
          }
        >
          <Icon size={18} />
          {label}
        </NavLink>
      ))}
    </div>
    <div className="mt-auto px-5 pb-5 pt-4">
      <span className="text-xs text-text-muted">Arabic digitization</span>
    </div>
  </nav>
);
