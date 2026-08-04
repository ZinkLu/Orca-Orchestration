import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { applyLayout } from "../layout";
import { effectiveHarness } from "../harness";
import { STATUS_META, type DagResponse, type LayoutKind, type TaskStatus } from "../types";

const ARROW_COLOR = "#8f8672";

/** Deterministic PRNG so each node's scribble stays stable across polls. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * A genuine hand scrawl: irregular curvy strokes wandering all over the box,
 * overlapping like someone colouring furiously without lifting the crayon.
 * Seeded by the node id, so every task gets its own "handwriting".
 */
function scribblePath(seedId: string, w = 210, h = 72): string {
  const rand = mulberry32(hashId(seedId));
  const pts: [number, number][] = [];
  let x = -4;
  let y = h * (0.35 + rand() * 0.3);
  pts.push([x, y]);
  while (x < w + 4) {
    x += 7 + rand() * 15;
    y = 5 + rand() * (h - 10);
    pts.push([x, y]);
  }
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const [px, py] = pts[i - 1];
    const [cx, cy] = pts[i];
    const mx = (px + cx) / 2 + (rand() - 0.5) * 18;
    const my = (py + cy) / 2 + (rand() - 0.5) * 22;
    d += ` Q${mx.toFixed(1)},${my.toFixed(1)} ${cx.toFixed(1)},${cy.toFixed(1)}`;
  }
  return d;
}

type TaskNodeData = {
  label: string;
  status: TaskStatus;
  selected: boolean;
  harness: string;
  dir: "LR" | "TB";
};

function TaskNode({ id, data }: NodeProps<Node<TaskNodeData>>) {
  const meta = STATUS_META[data.status];
  const isTB = data.dir === "TB";
  // two passes over the same box: a bold stroke plus a thinner, lighter one
  // running half a beat behind — colouring over the same spot twice
  const [scrawlA, scrawlB] = useMemo(() => [scribblePath(id), scribblePath(`${id}~2`)], [id]);
  return (
    <div
      className={`task-node${data.selected ? " task-node--selected" : ""}`}
      data-status={data.status}
      style={
        {
          "--crayon": meta.color,
          "--wash": meta.bg,
        } as CSSProperties
      }
    >
      {/* crayon scribble — a real hand scrawl that draws itself over and
          over while the task runs; two passes, unique per node */}
      {data.status === "dispatched" && (
        <svg
          className="task-node__scribble"
          viewBox="0 0 210 72"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path pathLength={1000} d={scrawlA} />
          <path pathLength={1000} d={scrawlB} strokeOpacity={0.55} />
        </svg>
      )}
      {/* red-pen cross-out, drawn on when the task fails */}
      {data.status === "failed" && (
        <svg
          className="task-node__cross"
          viewBox="0 0 210 72"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path d="M4,10 C60,26 150,44 206,62" />
          <path d="M206,10 C150,26 60,46 4,60" />
        </svg>
      )}
      {/* teacher's red-pen tick, stamped on when the task completes */}
      {data.status === "completed" && (
        <div className="task-node__stamp" aria-hidden="true">
          ✓
        </div>
      )}
      <Handle type="target" position={isTB ? Position.Top : Position.Left} />
      <div className="task-node__title">{data.label}</div>
      <div className="task-node__row">
        <div className="task-node__status" style={{ color: meta.ink }}>
          <span className="dot" style={{ background: meta.color }} />
          {meta.label}
        </div>
        <span className="task-node__harness" title="这个节点的 harness">
          {data.harness}
        </span>
      </div>
      <Handle type="source" position={isTB ? Position.Bottom : Position.Right} />
    </div>
  );
}

const nodeTypes = { task: TaskNode };

/** Event fired (on window) when the user hits "让 Orca 执行" — the canvas
    celebrates with a paper-plane flyby. */
export const RUN_START_EVENT = "orca:run-start";

const CONFETTI_COLORS = ["#7bb7e0", "#f2a0a6", "#7fc98c", "#f0b94e", "#ea6b5e", "#b79fe0"];

/** Paper-scrap rain, rendered once when every task reaches `completed`. */
function Confetti() {
  const bits = useMemo(
    () =>
      Array.from({ length: 48 }, (_, i) => ({
        left: Math.random() * 100,
        delay: Math.random() * 2.4,
        duration: 2.6 + Math.random() * 1.8,
        size: 7 + Math.random() * 6,
        color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
        spin: (Math.random() > 0.5 ? 1 : -1) * (360 + Math.random() * 540),
      })),
    [],
  );
  return (
    <div className="confetti" aria-hidden="true">
      {bits.map((b, i) => (
        <span
          key={i}
          className="confetti__bit"
          style={
            {
              left: `${b.left}%`,
              width: b.size,
              height: b.size * 0.7,
              background: b.color,
              animationDelay: `${b.delay}s`,
              animationDuration: `${b.duration}s`,
              "--spin": `${b.spin}deg`,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}

/** A paper plane soaring bottom-left → top-right; one mount = one flight. */
function PaperPlane({ onDone }: { onDone: () => void }) {
  return (
    <div className="plane-flyby" onAnimationEnd={onDone} aria-hidden="true">
      <svg viewBox="0 0 40 40" className="plane-flyby__icon">
        <path d="M2,22 L38,4 L16,38 L13,25 Z" />
        <path className="fold" d="M13,25 L38,4" />
      </svg>
    </div>
  );
}

function Flow({
  dag,
  selectedId,
  onSelect,
  layout,
  reorgNonce,
}: {
  dag: DagResponse;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  layout: LayoutKind;
  reorgNonce: number;
}) {
  const rf = useReactFlow();
  const prevCount = useRef(-1);
  // positions the user has explicitly dragged — preserved across status polls
  const dragged = useRef<Map<string, { x: number; y: number }>>(new Map());
  // id of the node under an active drag gesture (keep its live position)
  const draggingId = useRef<string | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<TaskNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  // increments per run-start event; the mounted plane unmounts itself at the
  // end of its flight
  const [flight, setFlight] = useState(0);

  useEffect(() => {
    const onRunStart = () => setFlight((n) => n + 1);
    window.addEventListener(RUN_START_EVENT, onRunStart);
    return () => window.removeEventListener(RUN_START_EVENT, onRunStart);
  }, []);

  // Switching layout algorithm or asking for a re-org discards manual drags so
  // the graph snaps fully to the fresh auto-layout. Declared before the layout
  // effect so the ref is cleared before it recomputes.
  useEffect(() => {
    dragged.current.clear();
  }, [layout, reorgNonce]);

  // Re-derive nodes/edges from the DAG whenever it, the selection, the layout,
  // or a re-org changes. User-dragged nodes keep their position; everything
  // else follows the chosen layout algorithm.
  useEffect(() => {
    const dir: "LR" | "TB" = layout === "layered-tb" ? "TB" : "LR";
    const statusById = new Map(dag.nodes.map((n) => [n.id, n.status]));
    const rawNodes: Node<TaskNodeData>[] = dag.nodes.map((n) => ({
      id: n.id,
      type: "task",
      position: { x: 0, y: 0 },
      data: {
        label: n.label,
        status: n.status,
        selected: n.id === selectedId,
        harness: effectiveHarness(n.id),
        dir,
      },
    }));
    const rawEdges: Edge[] = dag.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      // pencil-draw the link out of a node that is currently running
      className: statusById.get(e.source) === "dispatched" ? "edge-active" : undefined,
      markerEnd: { type: MarkerType.ArrowClosed, width: 15, height: 15, color: ARROW_COLOR },
    }));
    const laid = applyLayout(layout, rawNodes, rawEdges);

    setNodes((cur) => {
      const curPos = new Map(cur.map((n) => [n.id, n.position]));
      return laid.nodes.map((n) => {
        const keep =
          dragged.current.get(n.id) ??
          (draggingId.current === n.id ? curPos.get(n.id) : undefined);
        return keep ? { ...n, position: keep } : n;
      });
    });
    setEdges(laid.edges);
  }, [dag, selectedId, layout, reorgNonce, setNodes, setEdges]);

  // Auto-fit when the node count changes, so live status polls don't yank the
  // viewport while the user is inspecting (or dragging).
  useEffect(() => {
    if (nodes.length !== prevCount.current) {
      prevCount.current = nodes.length;
      const t = window.setTimeout(() => rf.fitView({ padding: 0.22, duration: 300 }), 60);
      return () => window.clearTimeout(t);
    }
  }, [nodes.length, rf]);

  // Re-fit after a layout switch or re-org (node count is unchanged, so the
  // effect above won't fire).
  useEffect(() => {
    const t = window.setTimeout(() => rf.fitView({ padding: 0.22, duration: 400 }), 90);
    return () => window.clearTimeout(t);
  }, [layout, reorgNonce, rf]);

  const onNodeDragStart = useCallback((_e: unknown, node: Node) => {
    draggingId.current = node.id;
  }, []);
  const onNodeDragStop = useCallback((_e: unknown, node: Node) => {
    dragged.current.set(node.id, node.position);
    draggingId.current = null;
  }, []);

  if (dag.nodes.length === 0) {
    return (
      <div className="dag-empty">
        <div className="dag-empty__doodle">🖍️</div>
        <div className="dag-empty__title">还是一张白纸</div>
        <div className="dag-empty__hint">
          在你的 agent 里加载 <code>orca-dag</code> skill，聊需求让它拆解并建图。
          <br />
          任务和依赖会像蜡笔一样，在这里一笔笔长成一张 DAG —— 然后逐个选 harness 派发。
        </div>
      </div>
    );
  }

  const allDone = dag.nodes.length > 0 && dag.nodes.every((n) => n.status === "completed");

  return (
    <>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        nodeTypes={nodeTypes}
        fitView
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable
        minZoom={0.2}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, n) => onSelect(n.id === selectedId ? null : n.id)}
        onPaneClick={() => onSelect(null)}
      >
        <Background variant={BackgroundVariant.Lines} gap={30} color="rgba(96,132,178,0.085)" />
        <Controls showInteractive={false} />
      </ReactFlow>
      {flight > 0 && <PaperPlane key={flight} onDone={() => setFlight(0)} />}
      {allDone && <Confetti />}
    </>
  );
}

export function DagView(props: {
  dag: DagResponse;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  layout: LayoutKind;
  reorgNonce: number;
}) {
  return (
    <ReactFlowProvider>
      <Flow {...props} />
    </ReactFlowProvider>
  );
}
