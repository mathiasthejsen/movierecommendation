"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

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
  return (
    <nav className="tabbar" aria-label="Main">
      {TABS.map((t) => {
        const active = t.href === "/" ? norm === "/" : norm.startsWith(t.href);
        return (
          <Link key={t.href} href={t.href} className={active ? "tab active" : "tab"} aria-current={active ? "page" : undefined}>
            <span aria-hidden>{t.icon}</span>
            <span>{t.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
