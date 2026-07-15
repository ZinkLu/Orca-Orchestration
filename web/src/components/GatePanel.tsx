import { useState } from "react";
import { resolveGate } from "../api";
import type { Gate } from "../types";

export function GatePanel({ gates, onResolved }: { gates: Gate[]; onResolved: () => void }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const pending = gates.filter((g) => g.status === "pending" || g.status === "open" || !g.resolution);

  if (pending.length === 0) return null;

  async function resolve(gate: Gate, resolution: string) {
    setBusyId(gate.id);
    try {
      await resolveGate(gate.id, resolution);
      onResolved();
    } catch (err) {
      alert(`审批失败：${String(err)}`);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="gates">
      {pending.map((g) => (
        <div key={g.id} className="gate">
          <div className="gate__badge">需要审批</div>
          <div className="gate__question">{g.question || "请审批此决策门"}</div>
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
