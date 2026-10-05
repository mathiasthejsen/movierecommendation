"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "@/components/AppProvider";
import { CategoryBar } from "@/components/CategoryBar";
import { NotificationBell } from "@/components/NotificationBell";
import { TitleCard } from "@/components/TitleCard";
import { MediaToggle, type SearchType } from "@/components/TitleSearch";
import { loadNeighbors } from "@/lib/artifact";
import { supabaseConfigured } from "@/lib/config";
import { refreshFamily, useFamily } from "@/lib/family";
import { getNotifications, markRead, refreshNotifications } from "@/lib/notifications";
import { passesFilters, preferenceWeight, rankRecommendations } from "@/lib/ranking";
import { activeRatings, activeWatchlist, useStore } from "@/lib/store";
import {
  computeTogether,
  initials,
  otherMembers,
  partnerView,
  pickTonight,
  rankTogether,
  titleFromItem,
  type FamilyMember,
  type TogetherEntry,
} from "@/lib/together";
import type { Edge, Title, TitleKey } from "@/lib/types";

type Tab = "mine" | "together" | "member";

function hue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

function Avatar({ id, name }: { id: string; name: string }) {
  return (
    <span className="avatar" title={name} aria-label={name} style={{ background: `hsl(${hue(id)} 45% 38%)` }}>
      {initials(name)}
    </span>
  );
}

function WhoAdded({ people }: { people: { id: string; name: string }[] }) {
  return (
    <p className="who-added">
      {people.map((p) => (
        <Avatar key={p.id} id={p.id} name={p.name} />
      ))}
      <span className="small muted">{people.map((p) => p.name).join(" & ")}</span>
    </p>
  );
}

export default function WatchlistPage() {
  // useSearchParams needs a Suspense boundary in a static export.
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <Watchlist />
    </Suspense>
  );
}

function Watchlist() {
  const { ready, getTitle, catalog, meta, session } = useApp();
  const params = useSearchParams();
  const [highlight, setHighlight] = useState<TitleKey | null>(null);
  const items = useStore(activeWatchlist);
  const ratings = useStore(activeRatings);
  const family = useFamily((s) => s);
  const [tab, setTab] = useState<Tab>("mine");
  const [type, setType] = useState<SearchType>("both");
  const [categories, setCategories] = useState<string[]>([]);
  const [memberId, setMemberId] = useState<string | null>(null);
  const [tonight, setTonight] = useState<TitleKey | null>(null);
  const [neighbors, setNeighbors] = useState<Map<TitleKey, Edge[]>>(new Map());

  const meId = session?.user.id ?? null;
  const signedIn = Boolean(meId) && supabaseConfigured;
  // Cached family data only counts if it belongs to whoever is signed in now.
  const familyItems = signedIn && family.meId === meId ? family.items : [];
  const familyProfiles = signedIn && family.meId === meId ? family.profiles : [];
  const members = useMemo(() => (meId ? otherMembers(familyProfiles, familyItems, meId) : []), [familyProfiles, familyItems, meId]);
  const member: FamilyMember | null = members.find((m) => m.userId === memberId) ?? members[0] ?? null;
  const myName = familyProfiles.find((p) => p.userId === meId)?.displayName || "You";
  const nameOf = (id: string) => (id === meId ? myName : members.find((m) => m.userId === id)?.name ?? "Family member");

  useEffect(() => {
    if (!signedIn) return;
    void refreshFamily();
    void refreshNotifications();
  }, [signedIn]);
  const openTogether = (key: TitleKey) => {
    void refreshFamily(); // the partner's add may be newer than the cached family data
    setTab("together");
    setTonight(null);
    scrolledFor.current = null;
    setHighlight(key);
  };

  // Deep link from the "It's a match" sheet: /watchlist/?tab=together&highlight=movie:603
  useEffect(() => {
    const t = params.get("tab");
    if (t === "together" || t === "mine" || t === "member") setTab(t);
    const h = params.get("highlight");
    setHighlight(h || null);
    // Opened from a push notification: that match counts as seen.
    if (h) void markRead(getNotifications().items.filter((n) => n.key === h && !n.readAt).map((n) => n.id));
  }, [params]);
  const scrolledFor = useRef<TitleKey | null>(null);
  useEffect(() => {
    if (!highlight || scrolledFor.current === highlight) return;
    const el = document.getElementById(`together-${highlight}`);
    if (!el) return; // list not rendered yet; try again on the next render
    scrolledFor.current = highlight;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
    window.setTimeout(() => {
      setHighlight(null);
      scrolledFor.current = null;
    }, 4000);
  });

  // Neighbour data for my ratings, to rank "Together" by my personal recommendation score.
  const ratedKeys = useMemo(() => ratings.map((r) => r.key).sort(), [ratings]);
  useEffect(() => {
    if (!ready || tab !== "together" || !ratedKeys.length) return;
    let cancelled = false;
    loadNeighbors(ratedKeys)
      .then((m) => !cancelled && setNeighbors(m))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, tab, ratedKeys.join(",")]);

  const resolve = (key: TitleKey, fallback?: Parameters<typeof titleFromItem>[0]): Title | null =>
    getTitle(key) ?? (fallback ? titleFromItem(fallback) : null);

  const together = useMemo(() => {
    if (!meId) return [] as { entry: TogetherEntry; title: Title }[];
    const entries = computeTogether(items, members, familyItems);
    const scores = new Map(
      rankRecommendations(new Map(ratings.map((r) => [r.key, preferenceWeight(r.kind, r.value)])), neighbors, catalog, {
        minYear: meta?.minYear ?? 1980,
      }).map((r) => [r.title.key, r.score]),
    );
    return rankTogether(entries, (k) => scores.get(k) ?? 0)
      .map((entry) => ({ entry, title: resolve(entry.key, familyItems.find((i) => i.key === entry.key)) }))
      .filter((x): x is { entry: TogetherEntry; title: Title } => Boolean(x.title));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meId, items, members, familyItems, ratings, neighbors, catalog, meta]);
  const togetherFiltered = together.filter((x) => passesFilters(x.title, { media: type, categories }));

  if (!ready) return <p className="muted">Loading…</p>;

  const mine = [...items]
    .sort((a, b) => b.addedAt.localeCompare(a.addedAt))
    .map((w) => getTitle(w.key))
    .filter((t): t is Title => Boolean(t))
    .filter((t) => type === "both" || t.type === type);

  const tabs: [Tab, string][] = [["mine", "Mine"]];
  if (signedIn) tabs.push(["together", "Together"]);
  if (signedIn && member) tabs.push(["member", member.name]);
  const active: Tab = tabs.some(([t]) => t === tab) ? tab : "mine";
  const tonightPick = together.find((x) => x.entry.key === tonight) ?? null;

  return (
    <>
      <div className="page-head">
        <h1>Watchlist</h1>
        {signedIn ? <NotificationBell onOpenTitle={openTogether} /> : null}
      </div>
      {tabs.length > 1 ? (
        <div className="segmented tabs" role="tablist" aria-label="Whose watchlist">
          {tabs.map(([t, label]) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={active === t}
              className={active === t ? "on" : ""}
              onClick={() => {
                setTab(t);
                setTonight(null);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      ) : supabaseConfigured ? (
        <p className="small muted">
          <Link href="/account/">Sign in</Link> to see watchlists you share with your family.
        </p>
      ) : null}

      {active === "mine" ? (
        <section role="tabpanel" aria-label="My watchlist">
          <MediaToggle value={type} onChange={setType} />
          {mine.length ? (
            <div className="list" style={{ marginTop: 12 }}>
              {mine.map((t) => (
                <TitleCard key={t.key} title={t} />
              ))}
            </div>
          ) : (
            <p className="muted">
              Nothing here yet. Add titles from <Link href="/">For you</Link> or <Link href="/search/">Search</Link>.
            </p>
          )}
        </section>
      ) : active === "together" ? (
        <section role="tabpanel" aria-label="Together">
          <p className="small muted">On your watchlist and at least one other family member&apos;s, best match for you first.</p>
          <MediaToggle value={type} onChange={setType} />
          <CategoryBar titles={together.map((x) => x.title)} selected={categories} onChange={setCategories} />
          {togetherFiltered.length ? (
            <>
              <div className="row" style={{ margin: "8px 0 12px" }}>
                <button type="button" className="btn" onClick={() => setTonight(pickTonight(togetherFiltered)?.entry.key ?? null)}>
                  🎲 {tonight ? "Pick again" : "Tonight's pick"}
                </button>
                <span className="small muted">Random from the top {Math.min(5, togetherFiltered.length)}</span>
              </div>
              {tonightPick ? (
                <div className="tonight" role="status" aria-live="polite">
                  <p className="small">
                    <strong>Tonight&apos;s pick</strong>
                  </p>
                  <TitleCard
                    title={tonightPick.title}
                    extra={<WhoAdded people={[meId!, ...tonightPick.entry.with].map((id) => ({ id, name: nameOf(id) }))} />}
                  />
                </div>
              ) : null}
              <div className="list">
                {togetherFiltered.map(({ entry, title }) => (
                  <div key={title.key} id={`together-${title.key}`} className={highlight === title.key ? "highlighted" : undefined}>
                    <TitleCard
                      title={title}
                      extra={<WhoAdded people={[meId!, ...entry.with].map((id) => ({ id, name: nameOf(id) }))} />}
                    />
                  </div>
                ))}
              </div>
            </>
          ) : together.length ? (
            <div className="notice">
              <p>Nothing in common for these filters.</p>
              <button type="button" className="btn secondary" onClick={() => (setCategories([]), setType("both"))}>
                Clear filters
              </button>
            </div>
          ) : (
            <p className="muted">
              Nothing in common yet. Add titles to your watchlist, or open {member ? `${member.name}'s` : "a family member's"} list
              and tap “+ Add to mine”.
            </p>
          )}
        </section>
      ) : member ? (
        <MemberTab member={member} members={members} onPick={setMemberId} resolve={resolve} familyItems={familyItems} mineKeys={new Set(items.map((w) => w.key))} type={type} setType={setType} />
      ) : null}
      {signedIn && family.error ? <p className="small error">Couldn&apos;t refresh family watchlists ({family.error}). Showing the last saved copy.</p> : null}
    </>
  );
}

function MemberTab({
  member,
  members,
  onPick,
  resolve,
  familyItems,
  mineKeys,
  type,
  setType,
}: {
  member: FamilyMember;
  members: FamilyMember[];
  onPick: (id: string) => void;
  resolve: (key: TitleKey, fallback?: Parameters<typeof titleFromItem>[0]) => Title | null;
  familyItems: Parameters<typeof partnerView>[1];
  mineKeys: ReadonlySet<TitleKey>;
  type: SearchType;
  setType: (t: SearchType) => void;
}) {
  const view = partnerView(member, familyItems, mineKeys);
  return (
    <section role="tabpanel" aria-label={`${member.name}'s watchlist`}>
      {members.length > 1 ? (
        <label className="row small" style={{ marginBottom: 8 }}>
          Family member{" "}
          <select value={member.userId} onChange={(e) => onPick(e.target.value)}>
            {members.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <p className="small muted">Read-only. Tap “+ Add to mine” to put a title on your own watchlist.</p>
      <MediaToggle value={type} onChange={setType} />
      {view.private ? (
        <p className="muted">{member.name} keeps their watchlist private.</p>
      ) : !view.items.length ? (
        <p className="muted">{member.name} hasn&apos;t added anything yet.</p>
      ) : (
        <div className="list" style={{ marginTop: 12 }}>
          {view.items
            .map((it) => resolve(it.key, it))
            .filter((t): t is Title => Boolean(t))
            .filter((t) => type === "both" || t.type === type)
            .map((t) => (
              <TitleCard key={t.key} title={t} watchMode="addOnly" />
            ))}
        </div>
      )}
    </section>
  );
}
