// Pure logic for the trigger-pipeline Edge Function. No Deno or npm imports, so the
// same code is unit-tested with vitest (src/lib/pipelineTrigger.test.ts).

export interface GitHubConfig {
  token: string;
  owner: string;
  repo: string;
  /** Workflow file name, e.g. "deploy.yml". */
  workflow: string;
  /** Branch to run on. */
  ref: string;
}

export interface RunInfo {
  id: number;
  status: string; // queued | in_progress | completed | waiting | requested | pending
  conclusion: string | null; // success | failure | cancelled | ...
  event: string;
  created_at: string;
  updated_at: string;
  html_url: string;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** At most one pipeline trigger per hour for the whole family. */
export const COOLDOWN_SECONDS = 3600;
const ACTIVE_STATUSES = ["in_progress", "queued", "waiting", "requested", "pending"];

export function isConfigured(env: { get(name: string): string | undefined }): GitHubConfig | null {
  const token = env.get("GH_TOKEN") ?? "";
  const owner = env.get("GH_OWNER") ?? "";
  const repo = env.get("GH_REPO") ?? "";
  if (!token || !owner || !repo) return null;
  return { token, owner, repo, workflow: env.get("GH_WORKFLOW") || "deploy.yml", ref: env.get("GH_REF") || "main" };
}

/** Seconds until another trigger is allowed (0 = allowed now). */
export function cooldownRemaining(lastTriggeredAt: string | null, nowMs: number, cooldownSeconds = COOLDOWN_SECONDS): number {
  if (!lastTriggeredAt) return 0;
  const last = Date.parse(lastTriggeredAt);
  if (Number.isNaN(last)) return 0;
  return Math.max(0, Math.ceil((last + cooldownSeconds * 1000 - nowMs) / 1000));
}

function headers(cfg: GitHubConfig): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${cfg.token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "reel-picks-trigger-pipeline",
  };
}

function workflowUrl(cfg: GitHubConfig, suffix: string): string {
  const o = encodeURIComponent(cfg.owner);
  const r = encodeURIComponent(cfg.repo);
  return `https://api.github.com/repos/${o}/${r}/actions/workflows/${encodeURIComponent(cfg.workflow)}${suffix}`;
}

function toRun(r: Record<string, unknown>): RunInfo {
  return {
    id: Number(r.id),
    status: String(r.status ?? ""),
    conclusion: (r.conclusion as string | null) ?? null,
    event: String(r.event ?? ""),
    created_at: String(r.created_at ?? ""),
    updated_at: String(r.updated_at ?? ""),
    html_url: String(r.html_url ?? ""),
  };
}

export class GitHubError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function listRuns(fetchFn: FetchLike, cfg: GitHubConfig, status?: string, perPage = 5): Promise<RunInfo[]> {
  const q = new URLSearchParams({ per_page: String(perPage), branch: cfg.ref });
  if (status) q.set("status", status);
  const res = await fetchFn(workflowUrl(cfg, `/runs?${q}`), { headers: headers(cfg) });
  if (!res.ok) throw new GitHubError(res.status, `GitHub runs lookup failed (${res.status})`);
  const body = (await res.json()) as { workflow_runs?: Record<string, unknown>[] };
  return (body.workflow_runs ?? []).map(toRun);
}

/** A run that is already queued or in progress for this workflow, if any. */
export async function findActiveRun(fetchFn: FetchLike, cfg: GitHubConfig): Promise<RunInfo | null> {
  for (const status of ["in_progress", "queued"]) {
    const runs = await listRuns(fetchFn, cfg, status, 1);
    if (runs.length) return runs[0];
  }
  return null;
}

export function isActive(run: RunInfo | null): boolean {
  return Boolean(run && ACTIVE_STATUSES.includes(run.status));
}

export async function dispatchPipeline(fetchFn: FetchLike, cfg: GitHubConfig): Promise<void> {
  const res = await fetchFn(workflowUrl(cfg, "/dispatches"), {
    method: "POST",
    headers: { ...headers(cfg), "Content-Type": "application/json" },
    body: JSON.stringify({ ref: cfg.ref, inputs: { run_pipeline: "true" } }),
  });
  // 204 No Content (classic) or 200 with run details (newer API versions).
  if (res.status !== 204 && res.status !== 200) {
    let message = `GitHub dispatch failed (${res.status})`;
    try {
      const b = (await res.json()) as { message?: string };
      if (b.message) message += `: ${b.message}`;
    } catch {
      /* no body */
    }
    throw new GitHubError(res.status, message);
  }
}

/** Where cooldown triggers are recorded (pipeline_runs table; service role only). */
export interface TriggerStore {
  /** Last trigger that counts toward the cooldown (pending or dispatched). */
  lastTriggerAt(): Promise<string | null>;
  /** Atomically re-check the cooldown and record a pending trigger. */
  reserve(userId: string, cooldownSeconds: number): Promise<{ ok: boolean; retryAfterSeconds: number; id: number | null }>;
  finish(id: number, status: "dispatched" | "failed"): Promise<void>;
}

export interface Reply {
  status: number;
  body: Record<string, unknown>;
}

export async function handleStatus(deps: { fetchFn: FetchLike; cfg: GitHubConfig | null; store: TriggerStore; now: number }): Promise<Reply> {
  if (!deps.cfg) return { status: 200, body: { configured: false } };
  const [runs, last] = await Promise.all([listRuns(deps.fetchFn, deps.cfg, undefined, 1), deps.store.lastTriggerAt()]);
  const run = runs[0] ?? null;
  return {
    status: 200,
    body: {
      configured: true,
      run,
      active: isActive(run),
      lastTriggeredAt: last,
      cooldownRemainingSeconds: cooldownRemaining(last, deps.now),
    },
  };
}

export async function handleTrigger(deps: {
  fetchFn: FetchLike;
  cfg: GitHubConfig | null;
  store: TriggerStore;
  userId: string;
  now: number;
  cooldownSeconds?: number;
}): Promise<Reply> {
  const cooldown = deps.cooldownSeconds ?? COOLDOWN_SECONDS;
  if (!deps.cfg) return { status: 503, body: { error: "not_configured" } };

  // 1. Cheap cooldown check first (the reserve step re-checks atomically).
  const remaining = cooldownRemaining(await deps.store.lastTriggerAt(), deps.now, cooldown);
  if (remaining > 0) return { status: 429, body: { error: "cooldown", retryAfterSeconds: remaining } };

  // 2. Don't start a second run while one is queued or in progress.
  const active = await findActiveRun(deps.fetchFn, deps.cfg);
  if (active) return { status: 409, body: { error: "already_running", run: active } };

  // 3. Reserve the slot (family-wide), then dispatch.
  const slot = await deps.store.reserve(deps.userId, cooldown);
  if (!slot.ok || slot.id === null) return { status: 429, body: { error: "cooldown", retryAfterSeconds: slot.retryAfterSeconds } };
  try {
    await dispatchPipeline(deps.fetchFn, deps.cfg);
  } catch (err) {
    await deps.store.finish(slot.id, "failed");
    const status = err instanceof GitHubError ? err.status : 0;
    return { status: 502, body: { error: "github_error", githubStatus: status, message: err instanceof Error ? err.message : String(err) } };
  }
  await deps.store.finish(slot.id, "dispatched");
  return { status: 202, body: { ok: true, dispatched: true, message: "Data update started. It takes about 5–15 minutes." } };
}
