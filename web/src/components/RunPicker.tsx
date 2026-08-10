import { useCallback, useEffect, useState } from "react";
import { createRun, fetchRuns } from "../api";
import type { OrcaRun } from "../types";
import { DoodleSelect } from "./DoodleSelect";

/**
 * Run selector.
 *
 * Since Orca 1.4.160 tasks are not global: every task belongs to exactly one
 * Run, and `task-list` refuses to answer without one. So the viewer always
 * shows the DAG *of a Run*, and this picker is how you choose which.
 *
 * A Run is a namespace, not a graph — nothing stops several unrelated DAGs
 * living in one Run. The orca-dag skill tells your agent to create a fresh Run
 * per plan, which is what makes "one Run = one DAG" hold in practice.
 */
export function RunPicker({
  runId,
  onPick,
  autoPick = true,
  disabled = false,
}: {
  runId: string;
  onPick: (id: string) => void;
  /** Gate for the newest-Run fallback. Off until the stored config has
   *  hydrated — auto-picking before that would overwrite the saved choice. */
  autoPick?: boolean;
  disabled?: boolean;
}) {
  const [runs, setRuns] = useState<OrcaRun[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await fetchRuns();
      setRuns(next);
      setErr(null);
      // Nothing selected (or the stored Run is gone) → fall back to newest.
      if (autoPick && next.length > 0 && !next.some((r) => r.id === runId)) onPick(next[0].id);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    }
  }, [runId, onPick, autoPick]);

  useEffect(() => {
    load();
    const t = window.setInterval(load, 10_000);
    return () => window.clearInterval(t);
  }, [load]);

  async function onCreate() {
    const objective = prompt("新 Run 的目标（objective）：");
    if (!objective?.trim()) return;
    setCreating(true);
    setErr(null);
    try {
      const run = await createRun(objective.trim());
      onPick(run.id);
      await load();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setCreating(false);
    }
  }

  const current = runs.find((r) => r.id === runId);

  return (
    <div className="runpick">
      <span className="exec__label">Run</span>
      <DoodleSelect
        value={runId}
        onChange={onPick}
        disabled={disabled || runs.length === 0}
        placeholder="（没有 Run）"
        emptyText="（没有 Run）"
        title={current ? `${current.id} · ${current.objective}` : "选择一个 Run"}
        options={runs.map((r) => ({
          value: r.id,
          label: r.objective || r.id,
          hint: r.id,
        }))}
      />
      <button
        className="btn btn--ghost"
        onClick={onCreate}
        disabled={disabled || creating}
        title="新建一个 Run（编排任务的命名空间）"
      >
        ＋ 新 Run
      </button>
      {err && <span className="exec__err">⚠️ {err}</span>}
    </div>
  );
}
