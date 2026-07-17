import { useEffect, useMemo, useRef, type CSSProperties } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { layoutDag } from "../layout";
import { effectiveHarness } from "../harness";
import { STATUS_META, type DagResponse, type TaskStatus } from "../types";

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
      style={
        {
          "--crayon": meta.color,
          "--wash": meta.bg,
        } as CSSProperties
      }
    >
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
  const arrowColor = "#8f8672";

  const { nodes, edges } = useMemo(() => {
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
      markerEnd: { type: MarkerType.ArrowClosed, width: 15, height: 15, color: arrowColor },
    }));
    return layoutDag(rawNodes, rawEdges, "LR");
  }, [dag, selectedId, arrowColor]);

  // Auto-fit only when the node count changes, so live status polls don't
  // yank the viewport around while the user is inspecting the graph.
  useEffect(() => {
    if (nodes.length !== prevCount.current) {
      prevCount.current = nodes.length;
      const t = window.setTimeout(() => rf.fitView({ padding: 0.22, duration: 300 }), 60);
      return () => window.clearTimeout(t);
    }
  }, [nodes.length, rf]);

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
      nodeTypes={nodeTypes}
      fitView
      nodesDraggable={false}
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
