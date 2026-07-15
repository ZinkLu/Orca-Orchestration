import { useCallback, useEffect, useRef, useState } from "react";
import { Chat } from "./components/Chat";
import { DagView } from "./components/DagView";
import { GatePanel } from "./components/GatePanel";
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
            <div className="topbar__title">Orca Orchestration Studio</div>
            <div className="topbar__subtitle">与 Claude 聊天规划 · 实时可视化任务 DAG</div>
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
        <section className="pane pane--chat">
          <Chat onTurnComplete={refresh} />
        </section>

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
              <aside className="detail">
                <button className="detail__close" onClick={() => setSelectedId(null)}>
                  ✕
                </button>
                <div
                  className="detail__status"
                  style={{ color: STATUS_META[selected.status].ink }}
                >
                  <span className="dot" style={{ background: STATUS_META[selected.status].color }} />
                  {STATUS_META[selected.status].label}
                </div>
                <h3 className="detail__title">{selected.label}</h3>
                <div className="detail__field">
                  <span className="detail__key">Task ID</span>
                  <code>{selected.id}</code>
                </div>
                <div className="detail__field">
                  <span className="detail__key">Spec</span>
                  <p className="detail__spec">{selected.spec}</p>
                </div>
                {selected.result && (
                  <div className="detail__field">
                    <span className="detail__key">Result</span>
                    <pre className="detail__result">{selected.result}</pre>
                  </div>
                )}
                <div className="detail__field detail__field--row">
                  <span className="detail__key">创建于</span>
                  <span>{selected.createdAt}</span>
                </div>
              </aside>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
