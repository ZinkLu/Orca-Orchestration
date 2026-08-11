import { useCallback, useEffect, useRef, useState } from "react";
import { fetchRunStatus, startRun, stopRun } from "../api";
import { DoodleSelect } from "./DoodleSelect";
import {
  getMaxConcurrency,
  harnessMap,
  modelMap,
  setDefaultHarness,
  setMaxConcurrency,
  useConfig,
} from "../harness";
import { HARNESSES, type RunStatus } from "../types";

const CUSTOM = "__custom__";
const KNOWN = HARNESSES as readonly string[];

/**
 * Execution controls. The coordinator is DAG-driven: click Run and it dispatches
 * every ready task in parallel (up to a concurrency cap), each on its own node's
 * harness — no manual worker count. Here you only set the fallback harness for
 * nodes without an explicit choice, and the parallelism cap. Both persist to the
 * server-side config file.
 *
 * Starting binds an Orca terminal as the Run's coordinator, which fences any
 * agent terminal currently coordinating that Run — so we confirm first.
 */
export function ExecControls({
  runId,
  taskIds,
  readyCount = 0,
}: {
  /** Run to execute. Mutations are Run-scoped since Orca 1.4.160. */
  runId: string;
  taskIds: string[];
  /** ready-but-unfired tasks — the Run button nudges itself when there are any */
  readyCount?: number;
}) {
  const config = useConfig();
  const storedIsCustom = !KNOWN.includes(config.defaultHarness);
  // "Custom…" selected but not yet typed — a UI-only state until run()
  const [forceCustom, setForceCustom] = useState(false);
  const [custom, setCustom] = useState(storedIsCustom ? config.defaultHarness : "");
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const taskIdsRef = useRef(taskIds);
  taskIdsRef.current = taskIds;

  // a custom default arriving from the config file (initial load) fills the input
  useEffect(() => {
    if (storedIsCustom) setCustom(config.defaultHarness);
  }, [storedIsCustom, config.defaultHarness]);

  const defHarness = forceCustom || storedIsCustom ? CUSTOM : config.defaultHarness;

  const poll = useCallback(async () => {
    try {
      setStatus(await fetchRunStatus());
    } catch {
      /* ignore transient */
    }
  }, []);

  useEffect(() => {
    poll();
    const t = window.setInterval(poll, 2000);
    return () => window.clearInterval(t);
  }, [poll]);

  const running = status?.running ?? false;
  const resolvedDefault = defHarness === CUSTOM ? custom.trim() : defHarness;
  // Dispatch.failure_count > 0 means Orca already retried this attempt.
  const retrying = (status?.attempts ?? []).filter((a) => a.failureCount > 0).length;

  function pickDefault(h: string) {
    if (h === CUSTOM) {
      setForceCustom(true);
      return;
    }
    setForceCustom(false);
    setDefaultHarness(h);
  }

  async function run() {
    if (!runId) {
      setErr("Pick a Run first");
      return;
    }
    if (!resolvedDefault) {
      setErr("Pick a default harness");
      return;
    }
    // Binding is the only way to get mutation authority on a Run, and it fences
    // whoever held it — usually the agent terminal that drew this DAG.
    const ok = confirm(
      "Starting execution binds this Run's coordinator to the viewer.\n\n" +
        "Any agent terminal currently coordinating the Run gets fenced (its orchestration " +
        "mutations start failing with consumer_fenced). It can take the Run back anytime with " +
        "orca orchestration run-use --id " +
        runId +
        ".\n\nContinue?",
    );
    if (!ok) return;

    if (defHarness === CUSTOM) setDefaultHarness(resolvedDefault);
    setBusy(true);
    setErr(null);
    try {
      const s = await startRun(
        runId,
        harnessMap(taskIdsRef.current),
        resolvedDefault,
        getMaxConcurrency(),
        modelMap(taskIdsRef.current),
      );
      setStatus(s);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    setErr(null);
    try {
      await stopRun();
      await poll();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="exec">
      <div className="exec__field">
        <span className="exec__label">Default harness</span>
        <DoodleSelect
          size="sm"
          value={defHarness}
          onChange={pickDefault}
          disabled={running}
          options={[
            ...HARNESSES.map((h) => ({ value: h, label: h })),
            { value: CUSTOM, label: "Custom…" },
          ]}
        />
        {defHarness === CUSTOM && (
          <input
            className="exec__custom"
            value={custom}
            placeholder="command"
            onChange={(e) => setCustom(e.target.value)}
            disabled={running}
          />
        )}
      </div>

      <label className="exec__field">
        <span className="exec__label">Max parallel</span>
        <input
          className="exec__num"
          type="number"
          min={1}
          max={16}
          value={config.maxConcurrency}
          onChange={(e) => setMaxConcurrency(Number(e.target.value) || 1)}
          disabled={running}
        />
      </label>

      {running ? (
        <div className="exec__live">
          <button className="btn btn--stop-run" onClick={stop} disabled={busy}>
            ⏹ Stop
          </button>
          <span className="exec__running">
            <span className="exec__pulse" /> Running · {status?.busy ?? 0} worker
            {(status?.busy ?? 0) === 1 ? "" : "s"}
            {/* one bead per in-flight Dispatch, breathing out of phase */}
            <span className="exec__beads" aria-hidden="true">
              {Array.from({ length: Math.min(status?.busy ?? 0, 8) }, (_, i) => (
                <i key={i} style={{ animationDelay: `${i * 0.14}s` }} />
              ))}
            </span>
            {/* Orca circuit-breaks a task after 3 failed attempts — surface it early */}
            {retrying > 0 && <b className="exec__retry">↻ {retrying} retrying</b>}
          </span>
        </div>
      ) : (
        <button
          className={`btn btn--run${readyCount > 0 && !busy ? " btn--attract" : ""}`}
          onClick={run}
          disabled={busy || taskIds.length === 0 || !runId}
          title={runId ? "Bind this Run and execute in dependency order" : "Pick a Run first"}
        >
          ▶ Run with Orca
        </button>
      )}

      {(err || status?.error) && <span className="exec__err">⚠️ {err || status?.error}</span>}
    </div>
  );
}
