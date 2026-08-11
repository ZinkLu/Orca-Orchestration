import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  getBezierPath,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  useUpdateNodeInternals,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { applyLayout } from "../layout";
import { effectiveHarness, useConfig } from "../harness";
import { STATUS_META, type DagResponse, type LayoutKind, type TaskStatus } from "../types";

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
  const updateNodeInternals = useUpdateNodeInternals();
  // one unbroken colouring pass, chopped into back-and-forth zigzag legs.
  // The legs draw strictly one after another (leg N+1 starts when N lands),
  // hold, then a fade wave erases them oldest-first, and the svg remounts.
  const legs = useMemo(() => scribbleLegs(id), [id]);
  const [cycle, setCycle] = useState(0);
  const dispatched = data.status === "dispatched";
  useEffect(() => {
    if (!dispatched) return;
    // the fade wave itself is scheduled in CSS; JS remounts the svg once the
    // newest leg has finished fading. Re-arms on every cycle (dep below) so
    // the scrawl loops for as long as the task runs.
    const wave = (legs.length - 1) * SCRIBBLE_FADE_STEP + SCRIBBLE_FADE;
    const cycleTimer = window.setTimeout(
      () => setCycle((c) => c + 1),
      (legs.length * SCRIBBLE_DRAW + SCRIBBLE_HOLD + wave) * 1000,
    );
    return () => window.clearTimeout(cycleTimer);
  }, [dispatched, legs.length, cycle]);
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
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget && event.animationName === "node-in") {
          // React Flow may take its first handle measurement while the card is
          // still scaled down by `node-in`. Transforms do not trigger its
          // ResizeObserver when they settle, so explicitly replace those
          // temporary, inset handle coordinates with the final geometry.
          updateNodeInternals(id);
        }
      }}
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
        <span className="task-node__harness" title="This node's harness">
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
 * Edge leaving a running node: a faint dashed pencil sketch that a solid
 * pencil stroke traces over, source → target, like a hand inking in the
 * dashes — over and over. Two stacked paths share one geometry; the wobble
 * lives in the #pencil-edge filter (userSpaceOnUse, with a 24000² region so
 * nothing clips, and scale 4.5, so it never truncates the advancing tip).
 *
 * Motion is FIXED-SPEED + UNIFORM: each edge is measured (getTotalLength) and
 * its draw time is length / EDGE_DRAW_SPEED, so every edge advances at the
 * same constant rate — no easing curves, and different-length edges simply
 * take different amounts of time.
 *
 * Driven by the Web Animations API (element.animate), NOT a hand-rolled
 * requestAnimationFrame loop. A rAF loop here has a structural weakness that
 * produced the "draws short, then restarts" / "fast start" failure: it pinned
 * its `start` timestamp to mount and read a `lenRef` that a SEPARATE effect
 * silently swapped whenever the path geometry changed, so any post-mount
 * geometry change (a node drag, a layout switch, or React Flow re-emitting
 * handle coords with sub-pixel drift) recomputed `t = (now-start) % cycle`
 * against a NEW length but the OLD `start` — stranding the trace mid-cycle.
 * WAAPI runs on the browser's animation timeline (immune to React re-render
 * storms: the 2s status polls, fitView viewport tweens, node drags). The node
 * reconciliation below preserves React Flow's `measured` state across polls;
 * without it React Flow briefly drops every handle, unmounts every edge, and
 * necessarily restarts all WAAPI animations together. Each surviving edge
 * is rebuilt only when its MEASURED length actually changes — sub-pixel drift
 * in the `path` string across polls is ignored, so every edge keeps its own
 * independent loop and a short edge looping fast never re-syncs the others.
 * Pure CSS can't express per-edge timing
 * here either (pathLength normalisation and var()/calc() inside @keyframes are
 * both unreliable in the target browser), so JS measures the length and hands
 * concrete numbers to WAAPI.
 */
/** uniform pencil draw speed, px per ms (150 px/s) */
const EDGE_DRAW_SPEED = 0.15;
/** how long a finished line is held before it lifts, ms */
const EDGE_HOLD_MS = 500;
/** how long the finished line takes to fade before the next pass, ms */
const EDGE_FADE_MS = 600;

function PencilEdge(props: EdgeProps) {
  const [path] = getBezierPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
  });
  const drawRef = useRef<SVGPathElement | null>(null);
  // The live WAAPI Animation and the path length it was built from. Kept in
  // refs (not derived from the effect's return) so a re-render that merely
  // re-emits the same geometry does NOT tear the animation down.
  const animRef = useRef<Animation | null>(null);
  const lenRef = useRef(0);

  // Build ONE animation per edge, then leave it running on its own timeline.
  // Each edge is independent: its draw time is its own length / EDGE_DRAW_SPEED,
  // so a short edge loops fast and a long edge loops slow — they never re-sync.
  //
  // React Flow can re-emit path geometry while nodes settle, and `path` can
  // drift by sub-pixel floats even when the real geometry is unchanged. If we
  // rebuilt on every path string, those harmless changes would restart the
  // affected animation. Instead we rebuild ONLY when the measured length
  // actually changed (by > 1px); sub-pixel drift is ignored, so each edge keeps
  // playing its own loop. The effect deliberately returns NO cleanup —
  // React's per-render cleanup would defeat the lenRef guard — so the previous
  // Animation is cancelled manually only when we genuinely rebuild, and the
  // separate effect below cancels it on unmount / type-flip away from `pencil`.
  useLayoutEffect(() => {
    const el = drawRef.current;
    if (!el) return;
    const L = el.getTotalLength();
    if (!isFinite(L) || L <= 0) {
      // degenerate geometry (e.g. source/target not yet positioned): hide the
      // draw path; the next real geometry will rebuild the animation.
      animRef.current?.cancel();
      animRef.current = null;
      el.style.opacity = "0";
      lenRef.current = 0;
      return;
    }
    const running = animRef.current && animRef.current.playState === "running";
    if (running && Math.abs(L - lenRef.current) < 1) return; // unchanged → keep looping
    // genuine length change (drag / layout switch / node count change) or no
    // animation yet → (re)build from the source with a fresh timeline.
    animRef.current?.cancel();
    lenRef.current = L;
    // dasharray: draw exactly one path-length, then gap one path-length, so a
    // 0 dashoffset shows the whole line and an L dashoffset hides it entirely.
    el.style.strokeDasharray = `${L} ${L}`;
    el.style.opacity = ""; // WAAPI's keyframes own the opacity from here
    const drawMs = L / EDGE_DRAW_SPEED; // longer edge ⇒ proportionally longer draw
    const total = drawMs + EDGE_HOLD_MS + EDGE_FADE_MS;
    animRef.current = el.animate(
      [
        // pen at the source, line hidden (offset = L), full ink
        { strokeDashoffset: L, opacity: 0.95, offset: 0 },
        // draw phase: offset falls linearly to 0 — the revealed length grows at
        // a constant rate and lands exactly on the target at this keyframe
        { strokeDashoffset: 0, opacity: 0.95, offset: drawMs / total },
        // hold: finished line sits, still full ink
        { strokeDashoffset: 0, opacity: 0.95, offset: (drawMs + EDGE_HOLD_MS) / total },
        // fade: line lifts (opacity → 0) before the pass snaps back to the start
        { strokeDashoffset: 0, opacity: 0, offset: 1 },
      ],
      { duration: total, easing: "linear", iterations: Infinity },
    );
  }, [path]);

  // Cancel on unmount / when the edge type flips away from `pencil`. The layout
  // effect above does NOT return a cleanup (it would tear the animation down on
  // every path re-emit); this is the only place the Animation is freed.
  useEffect(() => () => animRef.current?.cancel(), []);

  return (
    <g className="pencil-edge">
      <path className="pencil-edge__sketch" d={path} fill="none" />
      <path ref={drawRef} className="pencil-edge__draw" d={path} fill="none" />
    </g>
  );
}

const edgeTypes = { pencil: PencilEdge };

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
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        // pencil-sketch the link out of a node that is currently running
        type: running ? "pencil" : undefined,
        className: running ? "edge--run" : done ? "edge--done" : "edge--idle",
      };
    });
    const laid = applyLayout(layout, rawNodes, rawEdges);

    setNodes((cur) => {
      const currentById = new Map(cur.map((n) => [n.id, n]));
      return laid.nodes.map((n) => {
        const current = currentById.get(n.id);
        const keep =
          dragged.current.get(n.id) ??
          (draggingId.current === n.id ? current?.position : undefined);

        // `setNodes` receives brand-new user-node objects on every status poll.
        // In React Flow, a new object without `measured` means "re-initialize
        // this node": its cached handle bounds are cleared until ResizeObserver
        // measures it again. During that gap every connected EdgeWrapper returns
        // null, unmounting the custom edge and restarting its WAAPI animation.
        // Carrying the library-owned dimensions tells React Flow this is the
        // same measured node, so handles and edge DOM survive ordinary polls.
        return {
          ...n,
          position: keep ?? n.position,
          measured: current?.measured,
        };
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
        <div className="dag-empty__title">A blank page, for now</div>
        <div className="dag-empty__hint">
          Load the <code>orca-dag</code> skill in your agent and talk through what you want to
          build — it will break the work down and draw the graph.
          <br />
          Tasks and deps grow here stroke by stroke, like crayon — then pick a harness per node and
          fire.
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
