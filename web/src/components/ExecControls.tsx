import { useCallback, useEffect, useState } from "react";
import { createWorker, fetchHealth, fetchTerminals, startRun, stopRun } from "../api";
import { HARNESSES } from "../types";

const CUSTOM = "__custom__";

/**
 * Execution controls: build a pool of worker agents (pick a harness), then Run
 * to hand the DAG to Orca's coordinator, which auto-dispatches ready tasks to
 * idle workers until the graph is done.
 */
export function ExecControls({ hasTasks }: { hasTasks: boolean }) {
  const [harness, setHarness] = useState<string>(HARNESSES[0]);
  const [custom, setCustom] = useState("");
  const [workers, setWorkers] = useState<number>(0);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<string>("");

  const refreshWorkers = useCallback(async (ws: string) => {
    try {
      const terms = await fetchTerminals();
      const dir = ws || workspace;
      setWorkers(terms.filter((t) => t.worktreePath === dir && t.connected).length);
    } catch {
      /* leave count as-is */
    }
  }, [workspace]);

  useEffect(() => {
    fetchHealth()
      .then((h) => {
        setWorkspace(h.workspace);
        refreshWorkers(h.workspace);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resolved = harness === CUSTOM ? custom.trim() : harness;

  async function addWorker() {
    if (!resolved) {
      setErr("请选择或输入一个 harness");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await createWorker(resolved);
      await refreshWorkers(workspace);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    setBusy(true);
    setErr(null);
    try {
      await startRun();
      setRunning(true);
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
      setRunning(false);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="exec">
      <div className="exec__workers">
        <span className="exec__label">Workers {workers > 0 ? `· ${workers}` : ""}</span>
        <select
          className="exec__select"
          value={harness}
          onChange={(e) => setHarness(e.target.value)}
          aria-label="选择 worker 的 harness"
        >
          {HARNESSES.map((h) => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
          <option value={CUSTOM}>自定义…</option>
        </select>
        {harness === CUSTOM && (
          <input
            className="exec__custom"
            value={custom}
            placeholder="命令，如 aider"
            onChange={(e) => setCustom(e.target.value)}
          />
        )}
        <button className="btn btn--ghost" onClick={addWorker} disabled={busy}>
          + 加 worker
        </button>
      </div>

      {running ? (
        <button className="btn btn--stop-run" onClick={stop} disabled={busy}>
          ⏹ 停止执行
        </button>
      ) : (
        <button className="btn btn--run" onClick={run} disabled={busy || !hasTasks}>
          ▶ 让 Orca 执行
        </button>
      )}

      {err && <span className="exec__err">⚠️ {err}</span>}
    </div>
  );
}
