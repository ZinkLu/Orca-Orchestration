import { useState } from "react";
import { resolveGate } from "../api";
import type { Gate } from "../types";

/**
 * Pending decision gates. Resolving one is a Run-scoped mutation, so the server
 * has to borrow a coordinator terminal for it — see `asCoordinator` there.
 */
export function GatePanel({
  gates,
  runId,
  onResolved,
}: {
  gates: Gate[];
  runId: string;
  onResolved: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const pending = gates.filter((g) => g.status === "pending" || g.status === "open" || !g.resolution);

  if (pending.length === 0 || !runId) return null;

  async function resolve(gate: Gate, resolution: string) {
    setBusyId(gate.id);
    try {
      await resolveGate(gate.id, resolution, runId);
      onResolved();
    } catch (err) {
      alert(`Gate resolution failed: ${String((err as Error).message ?? err)}`);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="gates">
      {pending.map((g) => (
        <div key={g.id} className="gate">
          <div className="gate__badge">Approval needed</div>
          <div className="gate__question">{g.question || "Resolve this decision gate"}</div>
          <div className="gate__actions">
            {g.options.map((opt) => (
              <button
                key={opt}
                className={`btn btn--gate ${/reject|deny|no/i.test(opt) ? "btn--danger" : "btn--ok"}`}
                disabled={busyId === g.id}
                onClick={() => resolve(g, opt)}
              >
                {opt}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
