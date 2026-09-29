import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./config";
import { getSupabase } from "./supabase";

/** Client for the trigger-pipeline Edge Function ("Update data now"). */
export const PIPELINE_URL = SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/trigger-pipeline` : "";

export interface PipelineRun {
  id: number;
  status: string;
  conclusion: string | null;
  event: string;
  created_at: string;
  updated_at: string;
  html_url: string;
}

export type PipelineStatus =
  | { kind: "unavailable" } // not signed in, function not deployed, secrets missing, or network error
  | { kind: "ok"; run: PipelineRun | null; active: boolean; cooldownRemainingSeconds: number; lastTriggeredAt: string | null };

export type TriggerResult =
  | { kind: "started" }
  | { kind: "already_running" }
  | { kind: "cooldown"; retryAfterSeconds: number }
  | { kind: "error"; message: string };

/** Poll every 30 s while a run is active, for at most 20 minutes. */
export const POLL_MS = 30_000;
export const POLL_LIMIT_MS = 20 * 60_000;

async function call(method: "GET" | "POST"): Promise<Response | null> {
  if (!PIPELINE_URL) return null;
  const supabase = getSupabase();
  const token = supabase ? (await supabase.auth.getSession()).data.session?.access_token : undefined;
  if (!token) return null;
  try {
    return await fetch(PIPELINE_URL, { method, headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY } });
  } catch {
    return null;
  }
}

/** Interpret a status response. Anything but a configured 200 hides the feature. */
export async function parseStatus(res: Response | null): Promise<PipelineStatus> {
  if (!res || !res.ok) return { kind: "unavailable" };
  try {
    const b = (await res.json()) as Record<string, unknown>;
    if (b.configured !== true) return { kind: "unavailable" };
    return {
      kind: "ok",
      run: (b.run as PipelineRun | null) ?? null,
      active: Boolean(b.active),
      cooldownRemainingSeconds: Number(b.cooldownRemainingSeconds ?? 0),
      lastTriggeredAt: (b.lastTriggeredAt as string | null) ?? null,
    };
  } catch {
    return { kind: "unavailable" };
  }
}

export async function parseTrigger(res: Response | null): Promise<TriggerResult> {
  if (!res) return { kind: "error", message: "Couldn't reach the update service." };
  let b: Record<string, unknown> = {};
  try {
    b = (await res.json()) as Record<string, unknown>;
  } catch {
    /* empty body */
  }
  if (res.status === 202 || res.status === 200) return { kind: "started" };
  if (res.status === 409) return { kind: "already_running" };
  if (res.status === 429) return { kind: "cooldown", retryAfterSeconds: Number(b.retryAfterSeconds ?? res.headers.get("Retry-After") ?? 3600) };
  return { kind: "error", message: String(b.message ?? b.error ?? `Update failed (${res.status})`) };
}

export async function fetchPipelineStatus(): Promise<PipelineStatus> {
  return parseStatus(await call("GET"));
}

export async function triggerPipeline(): Promise<TriggerResult> {
  return parseTrigger(await call("POST"));
}

/** Show the "Update data now" section only for signed-in users when the function is configured. */
export function showUpdateButton(signedIn: boolean, status: PipelineStatus | null): boolean {
  return signedIn && status?.kind === "ok";
}

export function runLabel(run: PipelineRun | null, active: boolean): string {
  if (!run) return "";
  if (active) return run.status === "in_progress" ? "Running…" : "Queued…";
  if (run.conclusion === "success") return "Done";
  if (run.conclusion === "cancelled") return "Cancelled";
  if (run.conclusion) return "Failed";
  return "";
}

export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return `${d} days ago`;
}

export function formatWait(seconds: number): string {
  const m = Math.ceil(seconds / 60);
  return m <= 1 ? "a minute" : `${m} min`;
}
