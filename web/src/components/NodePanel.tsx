import { useEffect, useState } from "react";
import { getDefaultHarness, getNodeHarness, setNodeHarness } from "../harness";
import { HARNESSES, STATUS_META, type DagNode } from "../types";

const INHERIT = "__inherit__";
const CUSTOM = "__custom__";
const KNOWN = HARNESSES as readonly string[];

/**
 * Node detail + per-node harness. The description/deps are read-only (Orca can't
 * rewrite a stored spec — to change the plan, ask your agent to redraw the DAG).
 * The harness is this node's choice of agent when the coordinator fires it.
 */
export function NodePanel({ node, onClose }: { node: DagNode; onClose: () => void }) {
  const meta = STATUS_META[node.status];
  const stored = getNodeHarness(node.id);
  const [sel, setSel] = useState(stored === null ? INHERIT : KNOWN.includes(stored) ? stored : CUSTOM);
  const [custom, setCustom] = useState(stored && !KNOWN.includes(stored) ? stored : "");

  useEffect(() => {
    const s = getNodeHarness(node.id);
    setSel(s === null ? INHERIT : KNOWN.includes(s) ? s : CUSTOM);
    setCustom(s && !KNOWN.includes(s) ? s : "");
  }, [node.id]);

  function pick(v: string) {
    setSel(v);
    if (v === INHERIT) setNodeHarness(node.id, null);
    else if (v !== CUSTOM) setNodeHarness(node.id, v);
  }
  function pickCustom(v: string) {
    setCustom(v);
    setNodeHarness(node.id, v.trim() || null);
  }

  return (
    <aside className="node-panel">
      <button className="node-panel__close" onClick={onClose} aria-label="关闭">
        ✕
      </button>

      <div className="node-panel__status" style={{ color: meta.ink }}>
        <span className="dot" style={{ background: meta.color }} />
        {meta.label}
      </div>
      <h3 className="node-panel__title">{node.label}</h3>
      <div className="node-panel__id">
        <code>{node.id}</code>
      </div>

      <div className="node-panel__field">
        <span className="node-panel__key">Harness（这个节点用哪个 agent）</span>
        <select className="node-panel__select" value={sel} onChange={(e) => pick(e.target.value)}>
          <option value={INHERIT}>跟随默认（{getDefaultHarness()}）</option>
          {HARNESSES.map((h) => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
          <option value={CUSTOM}>自定义…</option>
        </select>
        {sel === CUSTOM && (
          <input
            className="node-panel__custom"
            value={custom}
            placeholder="命令，如 aider"
            onChange={(e) => pickCustom(e.target.value)}
          />
        )}
      </div>

      <div className="node-panel__field">
        <span className="node-panel__key">描述 / spec</span>
        <p className="node-panel__spec-ro">{node.spec}</p>
        <span className="node-panel__hint">要改描述或依赖，让你的 agent 重绘 DAG（reset + 重建）。</span>
      </div>

      {node.result && (
        <div className="node-panel__field">
          <span className="node-panel__key">结果</span>
          <pre className="node-panel__result">{node.result}</pre>
        </div>
      )}
    </aside>
  );
}
