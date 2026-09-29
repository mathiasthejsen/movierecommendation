"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchPipelineStatus,
  formatWait,
  POLL_LIMIT_MS,
  POLL_MS,
  runLabel,
  showUpdateButton,
  timeAgo,
  triggerPipeline,
  type PipelineStatus,
} from "@/lib/pipeline";
import { useApp } from "./AppProvider";

/**
 * "Update data now": runs the GitHub Actions data pipeline through the trigger-pipeline
 * Edge Function. Only rendered for signed-in users when the function and its secrets are
 * configured; otherwise it renders nothing.
 */
export function DataUpdatePanel() {
  const { session, meta, checkForNewData, newDataAvailable } = useApp();
  const [status, setStatus] = useState<PipelineStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const pollStarted = useRef<number | null>(null);
  const wasActive = useRef(false);

  const refresh = useCallback(async () => {
    const s = await fetchPipelineStatus();
    setStatus(s);
    setNow(Date.now());
    if (s.kind === "ok") {
      if (wasActive.current && !s.active) {
        // Run just finished: the Pages deploy follows within a minute or two.
        setMessage(
          s.run?.conclusion === "success"
            ? "Done. The new data goes live once the site redeploys (a minute or two); you'll see a Reload prompt."
            : "The data update didn't finish successfully. Check the Actions tab on GitHub.",
        );
        void checkForNewData();
      }
      wasActive.current = s.active;
    }
    return s;
  }, [checkForNewData]);

  useEffect(() => {
    if (session) void refresh();
    else setStatus(null);
  }, [session, refresh]);

  // Poll every 30 s while a run is active, for at most 20 minutes; keep checking for the
  // deployed data a little longer after it finishes.
  const active = status?.kind === "ok" && status.active;
  useEffect(() => {
    if (!active) {
      pollStarted.current = null;
      return;
    }
    pollStarted.current ??= Date.now();
    const timer = window.setInterval(() => {
      if (pollStarted.current && Date.now() - pollStarted.current > POLL_LIMIT_MS) {
        window.clearInterval(timer);
        setMessage("Still running after 20 minutes. Check back later or look at the Actions tab on GitHub.");
        return;
      }
      void refresh();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, refresh]);

  // After a finished run, look for the newly deployed artifact for a few more minutes.
  useEffect(() => {
    if (!message?.startsWith("Done") || newDataAvailable) return;
    let tries = 0;
    const timer = window.setInterval(async () => {
      tries += 1;
      if ((await checkForNewData()) || tries >= 10) window.clearInterval(timer);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [message, newDataAvailable, checkForNewData]);

  if (!showUpdateButton(Boolean(session), status) || status?.kind !== "ok") return null;

  const start = async () => {
    setBusy(true);
    setMessage(null);
    const r = await triggerPipeline();
    setBusy(false);
    if (r.kind === "started") {
      setMessage("Started. This takes about 5–15 minutes.");
      wasActive.current = true;
      // GitHub needs a few seconds to register the run.
      window.setTimeout(() => void refresh(), 5000);
    } else if (r.kind === "already_running") {
      setMessage("An update is already running.");
      void refresh();
    } else if (r.kind === "cooldown") {
      setMessage(`Data was updated recently. You can start another update in ${formatWait(r.retryAfterSeconds)}.`);
      void refresh();
    } else {
      setMessage(r.message);
    }
  };

  const cooldown = status.cooldownRemainingSeconds;
  const label = runLabel(status.run, status.active);
  const parts = [meta?.generatedAt ? `Last data update: ${timeAgo(meta.generatedAt, now)}` : "", label].filter(Boolean);
  return (
    <section className="notice stack data-update" aria-labelledby="data-update-heading">
      <h2 id="data-update-heading" style={{ margin: 0 }}>
        Update data
      </h2>
      <p className="small muted status-line" aria-live="polite">
        {parts.join(" · ")}
      </p>
      <p className="small">Refreshes films, series and curator picks (takes ~5–15 min). Your votes apply instantly without this.</p>
      <div className="row">
        <button type="button" className="btn" onClick={start} disabled={busy || status.active || cooldown > 0}>
          {status.active ? "Updating…" : busy ? "Starting…" : "Update data now"}
        </button>
        {cooldown > 0 && !status.active ? (
          <span className="small muted">Available again in {formatWait(cooldown)} (one update per hour for the family).</span>
        ) : null}
      </div>
      {message ? (
        <p className="small" role="status">
          {message}
        </p>
      ) : null}
    </section>
  );
}
