import { useEffect, useState } from "react";
import { fireTask, setTaskStatus } from "../api";
import { effectiveSpec, getHarness, setHarness, setSpecOverride } from "../overlay";
import { HARNESSES, STATUS_META, type DagNode } from "../types";

const CUSTOM = "__custom__";

/**
 * Detail + action panel for a selected DAG node: edit the description (stored
 * locally), pick a harness, and fire the task. Since Orca can't rewrite a
 * stored spec, the edited text is what gets sent to the harness at fire time.
 */
export function NodePanel({
  node,
  onClose,
  onChanged,
}: {
  node: DagNode;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [spec, setSpec] = useState(() => effectiveSpec(node.id, node.spec));
  const [harness, setHarnessState] = useState(() => getHarness(node.id, HARNESSES[0]));
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Reset local editor state when a different node is selected.
  useEffect(() => {
    setSpec(effectiveSpec(node.id, node.spec));
    const stored = getHarness(node.id, HARNESSES[0]);
    setHarnessState((HARNESSES as readonly string[]).includes(stored) ? stored : CUSTOM);
    setCustom((HARNESSES as readonly string[]).includes(stored) ? "" : stored);
    setErr(null);
    setInfo(null);
  }, [node.id, node.spec]);

  const meta = STATUS_META[node.status];
  const edited = spec.trim() !== node.spec.trim();
  const resolvedHarness = harness === CUSTOM ? custom.trim() : harness;
  const canFire = node.status !== "completed" && node.status !== "dispatched";

  function editSpec(v: string) {
    setSpec(v);
    setSpecOverride(node.id, v, node.spec);
  }
  function pickHarness(h: string) {
    setHarnessState(h);
    if (h !== CUSTOM) setHarness(node.id, h);
  }

  async function fire() {
    if (!resolvedHarness) {
      setErr("请选择或输入一个 harness");
      return;
    }
    if (harness === CUSTOM) setHarness(node.id, resolvedHarness);
    setBusy(true);
    setErr(null);
    setInfo(null);
    try {
      const r = await fireTask(node.id, resolvedHarness, spec.trim());
      setInfo(`已在 ${resolvedHarness} 派发 · ${r.handle.slice(0, 16)}…`);
      onChanged();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function mark(status: DagNode["status"]) {
    setBusy(true);
    setErr(null);
    try {
      await setTaskStatus(node.id, status);
      onChanged();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
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

      <label className="node-panel__field">
        <span className="node-panel__key">
          描述（发给 harness 的 prompt）
          {edited && <span className="edited-badge">✎ 已编辑</span>}
        </span>
        <textarea
          className="node-panel__spec"
          value={spec}
          onChange={(e) => editSpec(e.target.value)}
          rows={7}
          spellCheck={false}
        />
        <span className="node-panel__hint">
          编辑只存在本地，fire 时作为 prompt 发出；Orca 里存的原始 spec 不变。
        </span>
      </label>

      <div className="node-panel__field">
        <span className="node-panel__key">Harness</span>
        <div className="harness-picker">
          {HARNESSES.map((h) => (
            <button
              key={h}
              className={harness === h ? "active" : ""}
              onClick={() => pickHarness(h)}
              type="button"
            >
              {h}
            </button>
          ))}
          <button
            className={harness === CUSTOM ? "active" : ""}
            onClick={() => pickHarness(CUSTOM)}
            type="button"
          >
            自定义
          </button>
        </div>
        {harness === CUSTOM && (
          <input
            className="harness-custom"
            value={custom}
            placeholder="终端里要运行的命令，如 aider"
            onChange={(e) => setCustom(e.target.value)}
          />
        )}
      </div>

      <button className="btn btn--fire" onClick={fire} disabled={busy || !canFire}>
        {busy ? "派发中…" : `🔥 Fire → ${resolvedHarness || "?"}`}
      </button>
      {!canFire && (
        <div className="node-panel__note">
          {node.status === "dispatched" ? "已在执行中" : "已完成"} —— 如需重跑，先标记为其它状态。
        </div>
      )}

      <div className="node-panel__marks">
        <span className="node-panel__key">手动标记状态</span>
        <div className="mark-row">
          <button onClick={() => mark("ready")} disabled={busy} type="button">
            就绪
          </button>
          <button onClick={() => mark("completed")} disabled={busy} type="button">
            完成
          </button>
          <button onClick={() => mark("failed")} disabled={busy} type="button">
            失败
          </button>
        </div>
      </div>

      {info && <div className="node-panel__info">{info}</div>}
      {err && <div className="node-panel__err">⚠️ {err}</div>}

      {node.result && (
        <div className="node-panel__field">
          <span className="node-panel__key">结果</span>
          <pre className="node-panel__result">{node.result}</pre>
        </div>
      )}
    </aside>
  );
}
