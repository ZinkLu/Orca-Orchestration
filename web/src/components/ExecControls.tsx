import { useCallback, useEffect, useRef, useState } from "react";
import { fetchRunStatus, startRun, stopRun } from "../api";
import { getDefaultHarness, harnessMap, setDefaultHarness } from "../harness";
import { HARNESSES, type RunStatus } from "../types";

const CUSTOM = "__custom__";
const KNOWN = HARNESSES as readonly string[];

/**
 * Execution controls. The coordinator is DAG-driven: click Run and it dispatches
 * every ready task in parallel (up to a concurrency cap), each on its own node's
 * harness — no manual worker count. Here you only set the fallback harness for
 * nodes without an explicit choice, and the parallelism cap.
 */
export function ExecControls({ taskIds }: { taskIds: string[] }) {
  const initial = getDefaultHarness();
  const [defHarness, setDefHarness] = useState<string>(KNOWN.includes(initial) ? initial : CUSTOM);
  const [custom, setCustom] = useState(KNOWN.includes(initial) ? "" : initial);
  const [maxConcurrency, setMaxConcurrency] = useState(4);
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const taskIdsRef = useRef(taskIds);
  taskIdsRef.current = taskIds;

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

  function pickDefault(h: string) {
    setDefHarness(h);
    if (h !== CUSTOM) setDefaultHarness(h);
  }

  async function run() {
    if (!resolvedDefault) {
      setErr("请选择默认 harness");
      return;
    }
    if (defHarness === CUSTOM) setDefaultHarness(resolvedDefault);
    setBusy(true);
    setErr(null);
    try {
      const s = await startRun(harnessMap(taskIdsRef.current), resolvedDefault, maxConcurrency);
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
          value={maxConcurrency}
          onChange={(e) => setMaxConcurrency(Math.max(1, Math.min(16, Number(e.target.value) || 1)))}
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
          </span>
        </div>
      ) : (
        <button className="btn btn--run" onClick={run} disabled={busy || taskIds.length === 0}>
          ▶ 让 Orca 执行
        </button>
      )}

      {(err || status?.error) && <span className="exec__err">⚠️ {err || status?.error}</span>}
    </div>
  );
}
