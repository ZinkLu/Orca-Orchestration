import dagre from "@dagrejs/dagre";
import { Position, type Edge, type Node } from "@xyflow/react";
import type { LayoutKind } from "./types";

export const NODE_W = 210;
export const NODE_H = 72;

/**
 * Assign deterministic left-to-right (or top-to-bottom) positions using dagre —
 * the classic Sugiyama layered DAG layout. Deterministic so live status polls
 * recolor nodes in place without the graph jumping around.
 */
export function layoutDag<N extends Node>(
  nodes: N[],
  edges: Edge[],
  direction: "LR" | "TB" = "LR",
): { nodes: N[]; edges: Edge[] } {
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
  }) as N[];

  return { nodes: positioned, edges };
}

/**
 * Fruchterman–Reingold force-directed layout — the classic spring/charge model:
 * every pair of nodes repels (∝ k²/d), every edge attracts (∝ d²/k), positions
 * settle under a cooling temperature. Deterministic: nodes seed on a circle by
 * index (no RNG), so re-running gives the same arrangement.
 */
export function forceLayout<N extends Node>(
  nodes: N[],
  edges: Edge[],
): { nodes: N[]; edges: Edge[] } {
  const n = nodes.length;
  if (n === 0) return { nodes, edges };

  const width = Math.max(720, Math.sqrt(n) * 320);
  const height = Math.max(480, Math.sqrt(n) * 240);
  const k = 0.9 * Math.sqrt((width * height) / n); // ideal edge length
  const ITER = 320;

  const pos = new Map<string, { x: number; y: number }>();
  nodes.forEach((nd, i) => {
    const a = (2 * Math.PI * i) / n;
    pos.set(nd.id, { x: width / 2 + Math.cos(a) * (width / 3), y: height / 2 + Math.sin(a) * (height / 3) });
  });

  let temp = width / 8;
  const cool = temp / (ITER + 1);

  for (let it = 0; it < ITER; it++) {
    const disp = new Map(nodes.map((nd) => [nd.id, { x: 0, y: 0 }]));

    // repulsive forces between every pair
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const pa = pos.get(nodes[i].id)!;
        const pb = pos.get(nodes[j].id)!;
        let dx = pa.x - pb.x;
        let dy = pa.y - pb.y;
        let dist = Math.hypot(dx, dy);
        if (dist < 0.01) {
          dx = (i - j) * 0.1 + 0.05;
          dy = 0.05;
          dist = Math.hypot(dx, dy);
        }
        const force = (k * k) / dist;
        const ux = dx / dist;
        const uy = dy / dist;
        const da = disp.get(nodes[i].id)!;
        const db = disp.get(nodes[j].id)!;
        da.x += ux * force;
        da.y += uy * force;
        db.x -= ux * force;
        db.y -= uy * force;
      }
    }

    // attractive forces along edges
    for (const e of edges) {
      const pa = pos.get(e.source);
      const pb = pos.get(e.target);
      if (!pa || !pb) continue;
      const dx = pa.x - pb.x;
      const dy = pa.y - pb.y;
      const dist = Math.hypot(dx, dy) || 0.01;
      const force = (dist * dist) / k;
      const ux = dx / dist;
      const uy = dy / dist;
      const da = disp.get(e.source)!;
      const db = disp.get(e.target)!;
      da.x -= ux * force;
      da.y -= uy * force;
      db.x += ux * force;
      db.y += uy * force;
    }

    // move each node, capped by the current temperature
    for (const nd of nodes) {
      const d = disp.get(nd.id)!;
      const dl = Math.hypot(d.x, d.y) || 0.01;
      const p = pos.get(nd.id)!;
      p.x += (d.x / dl) * Math.min(dl, temp);
      p.y += (d.y / dl) * Math.min(dl, temp);
    }
    temp = Math.max(temp - cool, 1);
  }

  const positioned = nodes.map((nd) => {
    const p = pos.get(nd.id)!;
    return {
      ...nd,
      // top-left corner from the computed centre
      position: { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
    };
  }) as N[];

  return { nodes: positioned, edges };
}

/** Arrange the graph with the chosen classic layout algorithm. */
export function applyLayout<N extends Node>(
  kind: LayoutKind,
  nodes: N[],
  edges: Edge[],
): { nodes: N[]; edges: Edge[] } {
  switch (kind) {
    case "layered-tb":
      return layoutDag(nodes, edges, "TB");
    case "force":
      return forceLayout(nodes, edges);
    case "layered-lr":
    default:
      return layoutDag(nodes, edges, "LR");
  }
}
