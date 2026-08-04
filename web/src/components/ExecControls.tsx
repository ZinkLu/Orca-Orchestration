import { useCallback, useEffect, useRef, useState } from "react";
import { fetchRunStatus, startRun, stopRun } from "../api";
import {
  getMaxConcurrency,
  harnessMap,
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
  // "自定义…" selected but not yet typed — a UI-only state until run()
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
      setErr("请先选择一个 Run");
      return;
    }
    if (!resolvedDefault) {
      setErr("请选择默认 harness");
      return;
    }
    // Binding is the only way to get mutation authority on a Run, and it fences
    // whoever held it — usually the agent terminal that drew this DAG.
    const ok = confirm(
      "开始执行会把这个 Run 的 coordinator 绑定到 viewer。\n\n" +
        "正在协调该 Run 的 agent 终端会被 fence（它的 orchestration 写操作会开始报 " +
        "consumer_fenced）。它可以随时用 orca orchestration run-use --id " +
        runId +
        " 抢回去。\n\n继续？",
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
      );
      setStatus(s);
      window.dispatchEvent(new Event("orca:run-start"));
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
      <label className="exec__field">
        <span className="exec__label">默认 harness</span>
        <select
          className="exec__select"
          value={defHarness}
          onChange={(e) => pickDefault(e.target.value)}
          disabled={running}
        >
          {HARNESSES.map((h) => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
          <option value={CUSTOM}>自定义…</option>
        </select>
        {defHarness === CUSTOM && (
          <input
            className="exec__custom"
            value={custom}
            placeholder="命令"
            onChange={(e) => setCustom(e.target.value)}
            disabled={running}
          />
        )}
      </label>

      <label className="exec__field">
        <span className="exec__label">最多并行</span>
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
            ⏹ 停止
          </button>
          <span className="exec__running">
            <span className="exec__pulse" /> 执行中 · {status?.busy ?? 0} worker
            {/* one bead per in-flight Dispatch, breathing out of phase */}
            <span className="exec__beads" aria-hidden="true">
              {Array.from({ length: Math.min(status?.busy ?? 0, 8) }, (_, i) => (
                <i key={i} style={{ animationDelay: `${i * 0.14}s` }} />
              ))}
            </span>
            {/* Orca circuit-breaks a task after 3 failed attempts — surface it early */}
            {retrying > 0 && <b className="exec__retry">↻ {retrying} 次重试中</b>}
          </span>
        </div>
      ) : (
        <button
          className={`btn btn--run${readyCount > 0 && !busy ? " btn--attract" : ""}`}
          onClick={run}
          disabled={busy || taskIds.length === 0 || !runId}
          title={runId ? "绑定该 Run 并按依赖并行执行" : "先选择一个 Run"}
        >
          ▶ 让 Orca 执行
        </button>
      )}

      {(err || status?.error) && <span className="exec__err">⚠️ {err || status?.error}</span>}
    </div>
  );
}
