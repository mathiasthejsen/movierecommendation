"use client";

import { useEffect, useRef, useState } from "react";
import { useFamily } from "@/lib/family";
import { markRead, unreadCount, useNotifications, type AppNotification } from "@/lib/notifications";
import { timeAgo } from "@/lib/pipeline";
import type { TitleKey } from "@/lib/types";
import { useApp } from "./AppProvider";

/** 🔔 on the Watchlist page: "It's a match" notifications. Opening the list marks them read. */
export function NotificationBell({ onOpenTitle }: { onOpenTitle: (key: TitleKey) => void }) {
  const { session, getTitle } = useApp();
  const meId = session?.user.id ?? null;
  const state = useNotifications((s) => s);
  const family = useFamily((s) => s);
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const items: AppNotification[] = meId && state.meId === meId ? state.items : [];
  const unread = unreadCount(items, meId);

  // Viewing the list marks everything in it as read (the badge clears).
  useEffect(() => {
    if (open && unread) void markRead(items.filter((n) => !n.readAt).map((n) => n.id));
  }, [open, unread, items]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  if (!meId) return null;
  const nameOf = (id: string) => family.profiles.find((p) => p.userId === id)?.displayName || "Someone in your family";
  const titleOf = (key: TitleKey) =>
    getTitle(key)?.title ?? family.items.find((i) => i.key === key && i.title)?.title ?? "a title";

  return (
    <div className="bell" ref={panelRef}>
      <button
        type="button"
        className="chip bell-button"
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
        onClick={() => setOpen((o) => !o)}
      >
        <span aria-hidden>🔔</span>
        {unread ? <span className="bell-count">{unread > 9 ? "9+" : unread}</span> : null}
      </button>
      {open ? (
        <div className="bell-panel" role="region" aria-label="Notifications">
          {items.length ? (
            <ul>
              {items.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    className={n.readAt ? "bell-item" : "bell-item unread"}
                    onClick={() => {
                      setOpen(false);
                      onOpenTitle(n.key);
                    }}
                  >
                    <span>
                      🎉 <strong>{nameOf(n.actorId)}</strong> also wants to watch <strong>{titleOf(n.key)}</strong>
                    </span>
                    <span className="small muted">{timeAgo(n.createdAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="small muted bell-empty">No matches yet. When someone in the family adds a title that&apos;s on your watchlist, it shows up here.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
