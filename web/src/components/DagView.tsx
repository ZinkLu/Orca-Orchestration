import { useCallback, useEffect, useRef, type CSSProperties } from "react";
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
import { layoutDag } from "../layout";
import { effectiveHarness } from "../harness";
import { STATUS_META, type DagResponse, type TaskStatus } from "../types";

const ARROW_COLOR = "#8f8672";

type TaskNodeData = {
  label: string;
  status: TaskStatus;
  selected: boolean;
  harness: string;
};

function TaskNode({ data }: NodeProps<Node<TaskNodeData>>) {
  const meta = STATUS_META[data.status];
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
      {/* crayon "colouring-in" overlay — only animates while dispatched */}
      <div className="task-node__fill" aria-hidden="true" />
      <Handle type="target" position={Position.Left} />
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
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { task: TaskNode };

function Flow({
  dag,
  selectedId,
  onSelect,
}: {
  dag: DagResponse;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const rf = useReactFlow();
  const prevCount = useRef(-1);
  // positions the user has explicitly dragged — preserved across status polls
  const dragged = useRef<Map<string, { x: number; y: number }>>(new Map());
  // id of the node under an active drag gesture (keep its live position)
  const draggingId = useRef<string | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<TaskNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // Re-derive nodes/edges from the DAG (dagre layout) whenever it or the
  // selection changes. User-dragged nodes keep their position; everything else
  // follows the deterministic layout.
  useEffect(() => {
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
    const laid = layoutDag(rawNodes, rawEdges, "LR");

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
  }, [dag, selectedId, setNodes, setEdges]);

  // Auto-fit only when the node count changes, so live status polls don't
  // yank the viewport around while the user is inspecting (or dragging).
  useEffect(() => {
    if (nodes.length !== prevCount.current) {
      prevCount.current = nodes.length;
      const t = window.setTimeout(() => rf.fitView({ padding: 0.22, duration: 300 }), 60);
      return () => window.clearTimeout(t);
    }
  }, [nodes.length, rf]);

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
}) {
  return (
    <ReactFlowProvider>
      <Flow {...props} />
    </ReactFlowProvider>
  );
}
