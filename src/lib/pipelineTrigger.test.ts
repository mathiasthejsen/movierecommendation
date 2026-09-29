import { describe, expect, it, vi } from "vitest";
import {
  cooldownRemaining,
  COOLDOWN_SECONDS,
  findActiveRun,
  handleStatus,
  handleTrigger,
  isConfigured,
  type FetchLike,
  type GitHubConfig,
  type TriggerStore,
} from "../../supabase/functions/trigger-pipeline/logic";
import { parseStatus, parseTrigger, runLabel, showUpdateButton, timeAgo } from "./pipeline";

const cfg: GitHubConfig = { token: "t", owner: "mathiasthejsen", repo: "movierecommendation", workflow: "deploy.yml", ref: "main" };
const NOW = Date.parse("2026-09-29T10:00:00Z");

const run = (status: string, conclusion: string | null = null) => ({
  id: 1, status, conclusion, event: "workflow_dispatch", created_at: "2026-09-29T09:50:00Z", updated_at: "2026-09-29T09:55:00Z", html_url: "https://github.com/x",
});

/** Fake GitHub API: runs per status filter, and records dispatch calls. */
function fakeGitHub(opts: { inProgress?: unknown[]; queued?: unknown[]; latest?: unknown[]; dispatchStatus?: number } = {}) {
  const calls: { url: string; method: string; body?: string }[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined });
    if (url.endsWith("/dispatches")) return new Response(opts.dispatchStatus === 204 || !opts.dispatchStatus ? null : JSON.stringify({ message: "Bad credentials" }), { status: opts.dispatchStatus ?? 204 });
    const status = new URL(url).searchParams.get("status");
    const runs = status === "in_progress" ? opts.inProgress ?? [] : status === "queued" ? opts.queued ?? [] : opts.latest ?? [];
    return new Response(JSON.stringify({ workflow_runs: runs }), { status: 200 });
  };
  return { fetchFn, calls };
}

function fakeStore(lastTriggerAt: string | null = null): TriggerStore & { finished: [number, string][]; reserved: number } {
  const s = {
    finished: [] as [number, string][],
    reserved: 0,
    lastTriggerAt: async () => lastTriggerAt,
    reserve: async () => {
      s.reserved += 1;
      return { ok: true, retryAfterSeconds: 0, id: 42 };
    },
    finish: async (id: number, status: "dispatched" | "failed") => {
      s.finished.push([id, status]);
    },
  };
  return s;
}

describe("cooldown", () => {
  it("allows a trigger when none happened or the hour has passed", () => {
    expect(cooldownRemaining(null, NOW)).toBe(0);
    expect(cooldownRemaining("2026-09-29T08:59:59Z", NOW)).toBe(0);
    expect(cooldownRemaining("garbage", NOW)).toBe(0);
  });

  it("reports the seconds remaining within the hour", () => {
    expect(COOLDOWN_SECONDS).toBe(3600);
    expect(cooldownRemaining("2026-09-29T09:30:00Z", NOW)).toBe(1800);
    expect(cooldownRemaining("2026-09-29T10:00:00Z", NOW)).toBe(3600);
  });

  it("returns 429 with the time remaining and never calls GitHub", async () => {
    const gh = fakeGitHub();
    const store = fakeStore("2026-09-29T09:45:00Z");
    const r = await handleTrigger({ fetchFn: gh.fetchFn, cfg, store, userId: "u1", now: NOW });
    expect(r).toEqual({ status: 429, body: { error: "cooldown", retryAfterSeconds: 2700 } });
    expect(gh.calls).toHaveLength(0);
    expect(store.reserved).toBe(0);
  });

  it("honours the atomic reserve losing a race to another family member", async () => {
    const gh = fakeGitHub();
    const store = fakeStore(null);
    store.reserve = async () => ({ ok: false, retryAfterSeconds: 3599, id: null });
    const r = await handleTrigger({ fetchFn: gh.fetchFn, cfg, store, userId: "u1", now: NOW });
    expect(r.status).toBe(429);
    expect(gh.calls.some((c) => c.url.endsWith("/dispatches"))).toBe(false);
  });
});

describe("in-progress check", () => {
  it("finds a running or queued run of the workflow on the configured branch", async () => {
    const running = fakeGitHub({ inProgress: [run("in_progress")] });
    expect((await findActiveRun(running.fetchFn, cfg))?.status).toBe("in_progress");
    expect(running.calls[0].url).toBe(
      "https://api.github.com/repos/mathiasthejsen/movierecommendation/actions/workflows/deploy.yml/runs?per_page=1&branch=main&status=in_progress",
    );
    const queued = fakeGitHub({ queued: [run("queued")] });
    expect((await findActiveRun(queued.fetchFn, cfg))?.status).toBe("queued");
    expect(await findActiveRun(fakeGitHub().fetchFn, cfg)).toBeNull();
  });

  it("does not dispatch while a run is in progress", async () => {
    const gh = fakeGitHub({ inProgress: [run("in_progress")] });
    const store = fakeStore();
    const r = await handleTrigger({ fetchFn: gh.fetchFn, cfg, store, userId: "u1", now: NOW });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("already_running");
    expect(gh.calls.some((c) => c.url.endsWith("/dispatches"))).toBe(false);
    expect(store.reserved).toBe(0);
  });

  it("dispatches with run_pipeline=true on main and records the trigger", async () => {
    const gh = fakeGitHub();
    const store = fakeStore();
    const r = await handleTrigger({ fetchFn: gh.fetchFn, cfg, store, userId: "u1", now: NOW });
    expect(r.status).toBe(202);
    const dispatch = gh.calls.find((c) => c.url.endsWith("/dispatches"))!;
    expect(dispatch.method).toBe("POST");
    expect(JSON.parse(dispatch.body!)).toEqual({ ref: "main", inputs: { run_pipeline: "true" } });
    expect(store.finished).toEqual([[42, "dispatched"]]);
  });

  it("marks failed dispatches so they don't block the next hour", async () => {
    const gh = fakeGitHub({ dispatchStatus: 401 });
    const store = fakeStore();
    const r = await handleTrigger({ fetchFn: gh.fetchFn, cfg, store, userId: "u1", now: NOW });
    expect(r.status).toBe(502);
    expect(String(r.body.message)).toContain("Bad credentials");
    expect(store.finished).toEqual([[42, "failed"]]);
  });

  it("status endpoint reports the latest run and whether it's active", async () => {
    const gh = fakeGitHub({ latest: [run("in_progress")] });
    const r = await handleStatus({ fetchFn: gh.fetchFn, cfg, store: fakeStore("2026-09-29T09:50:00Z"), now: NOW });
    expect(r.body).toMatchObject({ configured: true, active: true, cooldownRemainingSeconds: 3000 });
    expect((r.body.run as { status: string }).status).toBe("in_progress");
  });
});

describe("unconfigured", () => {
  const env = (vars: Record<string, string>) => ({ get: (k: string) => vars[k] });

  it("needs GH_TOKEN, GH_OWNER and GH_REPO; workflow and branch default to deploy.yml / main", () => {
    expect(isConfigured(env({}))).toBeNull();
    expect(isConfigured(env({ GH_TOKEN: "t", GH_OWNER: "o" }))).toBeNull();
    expect(isConfigured(env({ GH_TOKEN: "t", GH_OWNER: "o", GH_REPO: "r" }))).toEqual({ token: "t", owner: "o", repo: "r", workflow: "deploy.yml", ref: "main" });
  });

  it("the function reports configured:false and refuses to trigger", async () => {
    const gh = fakeGitHub();
    expect((await handleStatus({ fetchFn: gh.fetchFn, cfg: null, store: fakeStore(), now: NOW })).body).toEqual({ configured: false });
    expect((await handleTrigger({ fetchFn: gh.fetchFn, cfg: null, store: fakeStore(), userId: "u", now: NOW })).status).toBe(503);
    expect(gh.calls).toHaveLength(0);
  });

  it("hides the button when unconfigured, undeployed, unreachable or signed out", async () => {
    const ok = await parseStatus(new Response(JSON.stringify({ configured: true, run: null, active: false, cooldownRemainingSeconds: 0 }), { status: 200 }));
    expect(showUpdateButton(true, ok)).toBe(true);
    expect(showUpdateButton(false, ok)).toBe(false); // signed out
    expect(showUpdateButton(true, await parseStatus(new Response(JSON.stringify({ configured: false }), { status: 200 })))).toBe(false);
    expect(showUpdateButton(true, await parseStatus(new Response("not found", { status: 404 })))).toBe(false); // function not deployed
    expect(showUpdateButton(true, await parseStatus(null))).toBe(false); // network error / no Supabase config
    expect(showUpdateButton(true, await parseStatus(new Response("<html>", { status: 200 })))).toBe(false); // garbage
    expect(showUpdateButton(true, null)).toBe(false); // still loading
  });
});

describe("client helpers", () => {
  it("maps trigger responses", async () => {
    const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    expect(await parseTrigger(res(202, { ok: true }))).toEqual({ kind: "started" });
    expect(await parseTrigger(res(409, { error: "already_running" }))).toEqual({ kind: "already_running" });
    expect(await parseTrigger(res(429, { retryAfterSeconds: 120 }))).toEqual({ kind: "cooldown", retryAfterSeconds: 120 });
    expect((await parseTrigger(res(502, { message: "boom" }))).kind).toBe("error");
    expect((await parseTrigger(null)).kind).toBe("error");
  });

  it("labels runs and relative times", () => {
    expect(runLabel(run("in_progress"), true)).toBe("Running…");
    expect(runLabel(run("queued"), true)).toBe("Queued…");
    expect(runLabel(run("completed", "success"), false)).toBe("Done");
    expect(runLabel(run("completed", "failure"), false)).toBe("Failed");
    expect(runLabel(null, false)).toBe("");
    expect(timeAgo("2026-09-29T09:59:40Z", NOW)).toBe("just now");
    expect(timeAgo("2026-09-29T09:45:00Z", NOW)).toBe("15 min ago");
    expect(timeAgo("2026-09-27T10:00:00Z", NOW)).toBe("2 days ago");
  });

  it("uses no real network in these tests", () => {
    const spy = vi.spyOn(globalThis, "fetch");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
