import { useCallback, useEffect, useRef, type CSSProperties } from "react";
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

type TaskNodeData = {
  label: string;
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

function TaskNode({ data }: NodeProps<Node<TaskNodeData>>) {
  const meta = STATUS_META[data.status];
  const isTB = data.dir === "TB";
  const alive = data.status === "ready" || data.status === "dispatched";
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
      {/* crayon "colouring-in" overlay — faint hatch always, animated scribble
          while dispatched, dense hatch when blocked/failed */}
      <div className="task-node__fill" aria-hidden="true" />
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

  return (
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
      <Background variant={BackgroundVariant.Dots} gap={24} size={1.4} color="rgba(74,71,84,0.14)" />
      <Controls showInteractive={false} />
    </ReactFlow>
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
