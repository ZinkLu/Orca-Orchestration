import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  getBezierPath,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { applyLayout } from "../layout";
import { effectiveHarness, useConfig } from "../harness";
import { STATUS_META, type DagResponse, type LayoutKind, type TaskStatus } from "../types";

const ARROW_COLOR = "#6f6757";
const ARROW_RUN = "#d9950f";
const ARROW_DONE = "#4f9e5d";

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
 * Clip the infinite line through (px,py) along (dx,dy) to the box, returning
 * the [t0,t1] parameter span inside it (null when the line misses entirely).
 */
function clipSpan(
  px: number,
  py: number,
  dx: number,
  dy: number,
  box: { x: number; y: number; w: number; h: number },
): [number, number] | null {
  let lo = -Infinity;
  let hi = Infinity;
  const slabs: [number, number, number, number][] = [
    [px, dx, box.x, box.x + box.w],
    [py, dy, box.y, box.y + box.h],
  ];
  for (const [p, d, min, max] of slabs) {
    if (Math.abs(d) < 1e-6) {
      if (p < min || p > max) return null;
      continue;
    }
    const a = (min - p) / d;
    const b = (max - p) / d;
    lo = Math.max(lo, Math.min(a, b));
    hi = Math.min(hi, Math.max(a, b));
  }
  return hi - lo > 1 ? [lo, hi] : null;
}

type ScribbleLeg = { d: string; width: number; opacity: number };

/**
 * One continuous colouring pass across the box, chopped into legs: diagonal
 * strokes chained end-to-end, alternating direction, each bowed a little and
 * overshooting the edges like a crayon that never lifts. Seeded by the node
 * id, so every task gets its own "handwriting". Opacities stay translucent
 * and widths vary per leg, so overlapping passes build up wax.
 */
function scribbleLegs(seedId: string, w = 210, h = 72): ScribbleLeg[] {
  const rand = mulberry32(hashId(seedId));
  const box = { x: 0, y: 0, w, h };
  // seeded per node, so every task colours in at its own slant, density and
  // pressure — same hand, never the same page twice
  const angle = 45 + (rand() - 0.5) * 16;
  const spacing = 10.5 * (0.88 + rand() * 0.24);
  const baseWidth = 10.5 * (0.9 + rand() * 0.2);
  const bleed = 6;
  const th = (angle * Math.PI) / 180;
  const dx = Math.cos(th);
  const dy = -Math.sin(th);
  const ax = -dy;
  const ay = dx;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const half = (Math.abs(box.w * ax) + Math.abs(box.h * ay)) / 2;
  const over = () => bleed * (0.15 + rand() * rand() * 1.9) + (rand() < 0.12 ? bleed * (1.5 + rand()) : 0);
  const legs: ScribbleLeg[] = [];
  let prev: { x: number; y: number } | null = null;
  let t = -half - spacing * 0.5;
  let i = 0;
  while (t < half + spacing * 0.5) {
    const px = cx + t * ax;
    const py = cy + t * ay;
    const span = clipSpan(px, py, dx, dy, box);
    t += spacing * (0.86 + rand() * 0.3);
    if (!span) continue;
    const uA = span[0] - over();
    const uB = span[1] + over();
    const at = (u: number) => ({ x: px + dx * u, y: py + dy * u });
    const forward = i % 2 === 0;
    let s = at(forward ? uA : uB);
    let e = at(forward ? uB : uA);
    const piv = (rand() - 0.5) * 0.075;
    const px0 = (s.x + e.x) / 2;
    const py0 = (s.y + e.y) / 2;
    const spin = (p: { x: number; y: number }) => {
      const vx = p.x - px0;
      const vy = p.y - py0;
      return { x: px0 + vx * Math.cos(piv) - vy * Math.sin(piv), y: py0 + vx * Math.sin(piv) + vy * Math.cos(piv) };
    };
    s = spin(s);
    e = spin(e);
    const bow = (rand() - 0.5) * 4.5;
    const mx = px0 + ax * bow + (rand() - 0.5) * 3;
    const my = py0 + ay * bow + (rand() - 0.5) * 3;
    const n1f = (v: number) => v.toFixed(1);
    let d = `M${n1f(s.x)},${n1f(s.y)}`;
    if (prev) {
      const out = (forward ? -1 : 1) * (1.5 + rand() * 4.5);
      const kx = (prev.x + s.x) / 2 + dx * out;
      const ky = (prev.y + s.y) / 2 + dy * out;
      d = `M${n1f(prev.x)},${n1f(prev.y)} Q${n1f(kx)},${n1f(ky)} ${n1f(s.x)},${n1f(s.y)}`;
    }
    d += ` Q${n1f(mx)},${n1f(my)} ${n1f(e.x)},${n1f(e.y)}`;
    legs.push({ d, width: baseWidth * (0.82 + rand() * 0.36), opacity: 0.68 * (0.75 + rand() * 0.5) });
    prev = e;
    i++;
  }
  return legs;
}

/** scribble timing (seconds) — must mirror the path animation durations and
    delay steps in styles.css (.task-node__scribble path): each leg draws for
    SCRIBBLE_DRAW, the full pass holds SCRIBBLE_HOLD, then a fade wave erases
    the legs oldest-first, SCRIBBLE_FADE each, SCRIBBLE_FADE_STEP apart */
const SCRIBBLE_DRAW = 0.26;
const SCRIBBLE_HOLD = 0.9;
const SCRIBBLE_FADE = 0.3;
const SCRIBBLE_FADE_STEP = 0.05;

type TaskNodeData = {  label: string;
  status: TaskStatus;
  selected: boolean;
  harness: string;
  dir: "LR" | "TB";
  /** paint order on first draw — staggers the entrance so the DAG "grows" */
  index: number;
  /** deterministic sticker tilt in degrees — pasted, not aligned */
  tilt: number;
  /** the status changed on this poll — play the one-shot celebration */
  pop: boolean;
};

function TaskNode({ id, data }: NodeProps<Node<TaskNodeData>>) {
  const meta = STATUS_META[data.status];
  const isTB = data.dir === "TB";
  const alive = data.status === "ready" || data.status === "dispatched";
  // one unbroken colouring pass, chopped into back-and-forth zigzag legs.
  // The legs draw strictly one after another (leg N+1 starts when N lands),
  // hold, then a fade wave erases them oldest-first, and the svg remounts.
  const legs = useMemo(() => scribbleLegs(id), [id]);
  const [cycle, setCycle] = useState(0);
  const dispatched = data.status === "dispatched";
  useEffect(() => {
    if (!dispatched) return;
    // the fade wave itself is scheduled in CSS; JS only remounts the svg once
    // the newest leg has finished fading
    const wave = (legs.length - 1) * SCRIBBLE_FADE_STEP + SCRIBBLE_FADE;
    const cycleTimer = window.setTimeout(
      () => setCycle((c) => c + 1),
      (legs.length * SCRIBBLE_DRAW + SCRIBBLE_HOLD + wave) * 1000,
    );
    return () => window.clearTimeout(cycleTimer);
  }, [dispatched, legs.length]);
  return (
    <div
      className={[
        "task-node",
        data.selected ? "task-node--selected" : "",
        data.pop ? "task-node--pop" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-status={data.status}
      style={
        {
          "--crayon": meta.color,
          "--crayon-ink": meta.ink,
          "--wash": meta.bg,
          "--i": data.index,
          "--tilt": `${data.tilt}deg`,
        } as CSSProperties
      }
    >
      {/* a real hand scrawl draws itself over and over while the task runs;
          completed/failed nodes keep the same scrawl frozen at its final
          frame — fully coloured in, no animation, still their own hand */}
      {(dispatched || data.status === "completed" || data.status === "failed") && (
        <svg
          key={cycle}
          className={[
            "task-node__scribble",
            dispatched ? "" : "task-node__scribble--final",
          ]
            .filter(Boolean)
            .join(" ")}
          viewBox="0 0 210 72"
          preserveAspectRatio="none"
          style={{ "--legs": legs.length } as CSSProperties}
          aria-hidden="true"
        >
          {legs.map((leg, i) => (
            <path
              key={i}
              pathLength={100}
              d={leg.d}
              strokeWidth={leg.width.toFixed(1)}
              strokeOpacity={leg.opacity.toFixed(3)}
              style={{ "--leg": i } as CSSProperties}
            />
          ))}
        </svg>
      )}
      {/* breathing dashed ring (ready) / radiating pulse (dispatched) */}
      {alive && <div className="task-node__aura" aria-hidden="true" />}
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
      {/* hand-drawn sign-off: a tick that draws itself, or a scribbled-out cross */}
      {data.status === "completed" && (
        <svg className="task-node__stamp task-node__stamp--ok" viewBox="0 0 46 36" aria-hidden="true">
          <path d="M5 20 C10 22.5 13 26 17 32 C23 20 32 9 42 4" />
        </svg>
      )}
      {data.status === "failed" && (
        <svg className="task-node__stamp task-node__stamp--bad" viewBox="0 0 46 36" aria-hidden="true">
          <path d="M8 6 C17 13 28 22 38 30" />
          <path d="M38 6 C29 14 18 23 8 30" />
        </svg>
      )}
      {/* selection = circled with a red marker, the way you'd flag it on paper.
          pathLength=100 lets CSS draw it in without knowing the true length. */}
      {data.selected && (
        <svg
          className="task-node__lasso"
          viewBox="0 0 232 94"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path
            pathLength={100}
            d="M10 48 C7 16 44 5 116 6 C193 7 227 20 225 46 C223 79 182 90 112 88 C46 86 13 79 10 48 Z"
          />
        </svg>
      )}
      {/* one-shot ring that flicks outward the moment the status flips */}
      {data.pop && <span className="task-node__ripple" aria-hidden="true" />}
      {/* a burst of crayon sparks the moment work lands done */}
      {data.pop && data.status === "completed" && (
        <svg className="task-node__sparks" viewBox="0 0 64 64" aria-hidden="true">
          <path d="M32 14 L32 3" />
          <path d="M48 20 L56 11" />
          <path d="M54 34 L64 32" />
          <path d="M16 20 L8 11" />
          <path d="M10 34 L0 32" />
        </svg>
      )}
      <Handle type="source" position={isTB ? Position.Bottom : Position.Right} />
    </div>
  );
}

const nodeTypes = { task: TaskNode };

/**
 * Edge leaving a running node: a faint dashed pencil sketch that is traced
 * over by a solid pencil stroke, source → target, over and over. Two stacked
 * paths share one geometry; the wobble lives in the #pencil-edge filter
 * (userSpaceOnUse, so zero-height horizontal edges don't collapse it).
 *
 * A crayon nub rides the same geometry via <animateMotion>, timed to the draw
 * so it reads as the tip laying the stroke down. It sits OUTSIDE the filtered
 * group on purpose — the wobble belongs to the line, the nub stays crisp.
 */
function PencilEdge(props: EdgeProps) {
  const [path] = getBezierPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
  });
  const pathId = `pe-${props.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  return (
    <>
      <g className="pencil-edge">
        <path id={pathId} className="pencil-edge__sketch" d={path} fill="none" />
        <path className="pencil-edge__draw" d={path} fill="none" markerEnd={props.markerEnd} />
      </g>
      <circle className="pencil-edge__nub" r="3.6">
        {/* hold at the target between passes: 0→1 over the draw, then parked */}
        <animateMotion
          dur="2.6s"
          repeatCount="indefinite"
          calcMode="linear"
          keyPoints="0;1;1;1"
          keyTimes="0;0.52;0.74;1"
        >
          <mpath href={`#${pathId}`} />
        </animateMotion>
      </circle>
    </>
  );
}

const edgeTypes = { pencil: PencilEdge };

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
  const config = useConfig();
  const prevCount = useRef(-1);
  // positions the user has explicitly dragged — preserved across status polls
  const dragged = useRef<Map<string, { x: number; y: number }>>(new Map());
  // id of the node under an active drag gesture (keep its live position)
  const draggingId = useRef<string | null>(null);
  // status seen on the previous poll, and the ids whose status just flipped —
  // recomputed only when the DAG itself changes, so re-running the layout
  // effect for a selection/layout change doesn't cut a celebration short.
  const prevStatus = useRef<Map<string, TaskStatus>>(new Map());
  const popped = useRef<Set<string>>(new Set());
  const seenDag = useRef<DagResponse | null>(null);
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

    if (seenDag.current !== dag) {
      const prev = prevStatus.current;
      popped.current = new Set(
        dag.nodes.filter((n) => prev.has(n.id) && prev.get(n.id) !== n.status).map((n) => n.id),
      );
      prevStatus.current = statusById;
      seenDag.current = dag;
    }

    const rawNodes: Node<TaskNodeData>[] = dag.nodes.map((n, i) => ({
      id: n.id,
      type: "task",
      position: { x: 0, y: 0 },
      data: {
        label: n.label,
        status: n.status,
        selected: n.id === selectedId,
        harness: effectiveHarness(n.id),
        dir,
        index: i,
        // deterministic pseudo-random tilt from the paint order: stickers
        // slapped on paper, stable across polls (no RNG, no jumping)
        tilt: (((i * 37) % 5) - 2) * 0.8,
        pop: popped.current.has(n.id),
      },
    }));
    const rawEdges: Edge[] = dag.edges.map((e) => {
      const from = statusById.get(e.source);
      const running = from === "dispatched";
      const done = from === "completed";
      // an edge carries the state of the dependency it represents: satisfied
      // (inked green), being worked on (pencil-traced), or not yet reached
      const tone = running ? ARROW_RUN : done ? ARROW_DONE : ARROW_COLOR;
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        // pencil-sketch the link out of a node that is currently running
        type: running ? "pencil" : undefined,
        className: running ? "edge--run" : done ? "edge--done" : "edge--idle",
        markerEnd: { type: MarkerType.ArrowClosed, width: 15, height: 15, color: tone },
      };
    });
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
  }, [dag, selectedId, layout, reorgNonce, config, setNodes, setEdges]);

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
        edgeTypes={edgeTypes}
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
