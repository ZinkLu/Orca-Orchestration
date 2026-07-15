import { STATUS_META, type DagNode } from "../types";

/**
 * Read-only detail for a selected DAG node. Editing a task's description isn't
 * supported (Orca can't rewrite a stored spec) — to change the plan, ask your
 * agent to redraw the DAG. Execution is driven by the coordinator (Run), not
 * per-node here.
 */
export function NodePanel({ node, onClose }: { node: DagNode; onClose: () => void }) {
  const meta = STATUS_META[node.status];
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
        <span className="node-panel__key">描述 / spec</span>
        <p className="node-panel__spec-ro">{node.spec}</p>
        <span className="node-panel__hint">
          要改描述或依赖，让你的 agent 重绘 DAG（reset + 重建）。
        </span>
      </div>

      {node.result && (
        <div className="node-panel__field">
          <span className="node-panel__key">结果</span>
          <pre className="node-panel__result">{node.result}</pre>
        </div>
      )}

      <div className="node-panel__field node-panel__field--row">
        <span className="node-panel__key">创建于</span>
        <span>{node.createdAt}</span>
      </div>
    </aside>
  );
}
