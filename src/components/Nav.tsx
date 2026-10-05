"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { unreadCount, useNotifications } from "@/lib/notifications";
import { useApp } from "./AppProvider";

const TABS = [
  { href: "/", label: "For you", icon: "✨" },
  { href: "/search/", label: "Search", icon: "🔎" },
  { href: "/picks/", label: "Picks", icon: "📌" },
  { href: "/watchlist/", label: "Watchlist", icon: "🍿" },
  { href: "/account/", label: "Me", icon: "👤" },
];

export function Nav() {
  const path = usePathname() || "/";
  const norm = path.endsWith("/") ? path : `${path}/`;
  const { session } = useApp();
  const unread = useNotifications((s) => unreadCount(s.items, s.meId));
  const badge = session ? unread : 0;
  return (
    <nav className="tabbar" aria-label="Main">
      {TABS.map((t) => {
        const active = t.href === "/" ? norm === "/" : norm.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            className={active ? "tab active" : "tab"}
            aria-current={active ? "page" : undefined}
            aria-label={t.href === "/watchlist/" && badge ? `${t.label}, ${badge} new match${badge === 1 ? "" : "es"}` : undefined}
          >
            <span aria-hidden className="tab-icon">
              {t.icon}
              {t.href === "/watchlist/" && badge ? <span className="tab-badge">{badge > 9 ? "9+" : badge}</span> : null}
            </span>
            <span>{t.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
