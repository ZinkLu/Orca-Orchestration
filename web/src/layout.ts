import dagre from "@dagrejs/dagre";
import { Position, type Edge, type Node } from "@xyflow/react";

export const NODE_W = 210;
export const NODE_H = 72;

/**
 * Assign deterministic left-to-right positions to DAG nodes using dagre.
 * Deterministic layout means live status polls recolor nodes in place
 * without the graph jumping around.
 */
export function layoutDag(
  nodes: Node[],
  edges: Edge[],
  direction: "LR" | "TB" = "LR",
): { nodes: Node[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: direction, nodesep: 36, ranksep: 90, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));

  nodes.forEach((n) => g.setNode(n.id, { width: NODE_W, height: NODE_H }));
  edges.forEach((e) => g.setEdge(e.source, e.target));

  dagre.layout(g);

  const positioned = nodes.map((n) => {
    const p = g.node(n.id);
    return {
      ...n,
      position: { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 },
      sourcePosition: direction === "LR" ? Position.Right : Position.Bottom,
      targetPosition: direction === "LR" ? Position.Left : Position.Top,
    };
  });

  return { nodes: positioned, edges };
}
