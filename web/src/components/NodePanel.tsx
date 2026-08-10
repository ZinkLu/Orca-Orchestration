import { useEffect, useState } from "react";
import { fetchModels } from "../api";
import {
  effectiveHarness,
  getDefaultHarness,
  getNodeHarness,
  getNodeModel,
  setNodeHarness,
  setNodeModel,
  useConfig,
} from "../harness";
import { HARNESSES, MODEL_PICKER, STATUS_META, type DagNode } from "../types";
import { DoodleSelect } from "./DoodleSelect";

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
  useConfig(); // re-render when the default harness (or this node's) changes
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

  // --- per-node model ------------------------------------------------
  // The model picker depends on the node's EFFECTIVE harness (its own override,
  // else the inherited default), not the {sel,custom} transient state — so it
  // reacts correctly even when the node just inherits. opencode → dropdown from
  // `opencode models`; claude/codex/cursor → free-text (no enumerable list);
  // anything else → no model control.
  const effHarness = effectiveHarness(node.id);
  const picker = MODEL_PICKER[effHarness] ?? "none";
  const model = getNodeModel(node.id);
  const [openCodeModels, setOpenCodeModels] = useState<string[] | null>(null);
  useEffect(() => {
    if (effHarness !== "opencode") return;
    let alive = true;
    fetchModels("opencode")
      .then((m) => {
        if (alive) setOpenCodeModels(m);
      })
      .catch(() => {
        if (alive) setOpenCodeModels([]);
      });
    return () => {
      alive = false;
    };
  }, [effHarness]);

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
        <DoodleSelect
          value={sel}
          onChange={pick}
          options={[
            { value: INHERIT, label: `跟随默认（${getDefaultHarness()}）` },
            ...HARNESSES.map((h) => ({ value: h, label: h })),
            { value: CUSTOM, label: "自定义…" },
          ]}
        />
        {sel === CUSTOM && (
          <input
            className="node-panel__custom"
            value={custom}
            placeholder="命令，如 aider"
            onChange={(e) => pickCustom(e.target.value)}
          />
        )}
      </div>

      {picker !== "none" && (
        <div className="node-panel__field">
          <span className="node-panel__key">
            Model（{effHarness}）{model ? null : " · 默认"}
          </span>
          {picker === "select" ? (
            <DoodleSelect
              value={model ?? ""}
              onChange={(v) => setNodeModel(node.id, v || null)}
              loading={openCodeModels === null}
              options={[
                { value: "", label: "（默认模型）" },
                ...(openCodeModels ?? []).map((m) => ({ value: m, label: m })),
              ]}
            />
          ) : (
            <input
              className="node-panel__custom"
              value={model ?? ""}
              placeholder={`模型名，如 ${effHarness === "claude" ? "opus" : effHarness === "codex" ? "o3" : "<model>"}`}
              onChange={(e) => setNodeModel(node.id, e.target.value.trim() || null)}
            />
          )}
        </div>
      )}

      {/* Orca tracks the running attempt as a Dispatch; task-list only carries
          these while the task is dispatched. */}
      {node.dispatchId && (
        <div className="node-panel__field">
          <span className="node-panel__key">当前 Dispatch（本次尝试）</span>
          <div className="node-panel__id">
            <code>{node.dispatchId}</code>
          </div>
          {node.assigneeHandle && (
            <span className="node-panel__hint">
              执行终端 <code>{node.assigneeHandle}</code> · 用{" "}
              <code>orca orchestration worker-read --dispatch {node.dispatchId}</code> 看输出
            </span>
          )}
        </div>
      )}

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
