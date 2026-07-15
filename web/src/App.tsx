import { useCallback, useEffect, useRef, useState } from "react";
import { DagView } from "./components/DagView";
import { GatePanel } from "./components/GatePanel";
import { NodePanel } from "./components/NodePanel";
import { fetchDag, resetTasks } from "./api";
import { STATUS_META, type DagResponse, type TaskStatus, type Theme } from "./types";

const EMPTY: DagResponse = { nodes: [], edges: [], gates: [], generatedAt: 0 };
const POLL_MS = 2000;

/**
 * Hand-drawn wobble filters. `crayon` = gentle waxy waver; `doodle` = rougher,
 * higher-frequency pen jitter (the Excalidraw-ish sketch). CSS picks which
 * filter applies per theme via the `data-theme` attribute.
 */
function HandDrawnDefs() {
  return (
    <svg className="crayon-defs" aria-hidden="true" focusable="false">
      <defs>
        <filter id="crayon" x="-10%" y="-10%" width="120%" height="120%">
          <feTurbulence type="fractalNoise" baseFrequency="0.009" numOctaves="2" seed="7" result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale="6.5" xChannelSelector="R" yChannelSelector="G" />
        </filter>
        <filter id="crayon-edge" x="-30%" y="-30%" width="160%" height="160%">
          <feTurbulence type="fractalNoise" baseFrequency="0.011" numOctaves="2" seed="3" result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale="7.5" xChannelSelector="R" yChannelSelector="G" />
        </filter>
        <filter id="doodle" x="-12%" y="-12%" width="124%" height="124%">
          <feTurbulence type="fractalNoise" baseFrequency="0.016" numOctaves="3" seed="11" result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale="4" xChannelSelector="R" yChannelSelector="G" />
        </filter>
        <filter id="doodle-edge" x="-30%" y="-30%" width="160%" height="160%">
          <feTurbulence type="fractalNoise" baseFrequency="0.018" numOctaves="3" seed="5" result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale="5" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </defs>
    </svg>
  );
}

const THEME_META: Record<Theme, { label: string; icon: string }> = {
  crayon: { label: "蜡笔", icon: "🖍️" },
  doodle: { label: "涂鸦", icon: "✏️" },
};

export default function App() {
  const [dag, setDag] = useState<DagResponse>(EMPTY);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [connError, setConnError] = useState(false);
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem("theme") as Theme) || "crayon",
  );
  const timer = useRef<number | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("theme", theme);
  }, [theme]);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchDag();
      setDag(next);
      setConnError(false);
    } catch {
      setConnError(true);
    }
  }, []);

  useEffect(() => {
    refresh();
    timer.current = window.setInterval(refresh, POLL_MS);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [refresh]);

  const counts = dag.nodes.reduce<Record<string, number>>((acc, n) => {
    acc[n.status] = (acc[n.status] ?? 0) + 1;
    return acc;
  }, {});

  const selected = dag.nodes.find((n) => n.id === selectedId) ?? null;

  async function onReset() {
    if (!confirm("清空所有编排任务？（会调用 orca orchestration reset --tasks）")) return;
    try {
      await resetTasks();
      setSelectedId(null);
      refresh();
    } catch (err) {
      alert(`重置失败：${String(err)}`);
    }
  }

  return (
    <div className="app">
      <HandDrawnDefs />
      <header className="topbar">
        <div className="topbar__brand">
          <span className="topbar__logo">🐳</span>
          <div>
            <div className="topbar__title">Orca DAG Viewer</div>
            <div className="topbar__subtitle">和 agent 聊天建图 · 在这里选 harness 逐个 fire</div>
          </div>
        </div>
        <div className="topbar__right">
          <div className="theme-toggle" role="group" aria-label="切换手绘风格">
            {(Object.keys(THEME_META) as Theme[]).map((t) => (
              <button
                key={t}
                className={theme === t ? "active" : ""}
                aria-pressed={theme === t}
                onClick={() => setTheme(t)}
              >
                <span aria-hidden="true">{THEME_META[t].icon}</span> {THEME_META[t].label}
              </button>
            ))}
          </div>
          <div className={`conn ${connError ? "conn--bad" : "conn--ok"}`}>
            {connError ? "无法连接后端" : "已连接 Orca"}
          </div>
          <button className="btn btn--ghost" onClick={onReset}>
            清空任务
          </button>
        </div>
      </header>

      <div className="layout">
        <section className="pane pane--dag">
          <div className="dag-toolbar">
            <div className="legend">
              {(Object.keys(STATUS_META) as TaskStatus[]).map((s) => (
                <span key={s} className="legend__item">
                  <span className="legend__dot" style={{ background: STATUS_META[s].color }} />
                  {STATUS_META[s].label}
                  {counts[s] ? ` ${counts[s]}` : ""}
                </span>
              ))}
            </div>
            <div className="dag-toolbar__meta">{dag.nodes.length} 个任务 · {dag.edges.length} 条依赖</div>
          </div>

          <div className="dag-canvas">
            <DagView dag={dag} selectedId={selectedId} onSelect={setSelectedId} theme={theme} />

            <GatePanel gates={dag.gates} onResolved={refresh} />

            {selected && (
              <NodePanel node={selected} onClose={() => setSelectedId(null)} onChanged={refresh} />
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
