export type TaskStatus =
  | "pending"
  | "ready"
  | "dispatched"
  | "completed"
  | "failed"
  | "blocked";

/** Hand-drawn visual theme. */
export type Theme = "crayon" | "doodle";

export interface DagNode {
  id: string;
  label: string;
  status: TaskStatus;
  spec: string;
  result: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface DagEdge {
  id: string;
  source: string;
  target: string;
}

export interface Gate {
  id: string;
  taskId: string | null;
  question: string;
  options: string[];
  status: string;
  resolution: string | null;
}

export interface DagResponse {
  nodes: DagNode[];
  edges: DagEdge[];
  gates: Gate[];
  generatedAt: number;
}

export interface StatusMeta {
  label: string;
  /** Crayon stroke color — node border, legend dot. */
  color: string;
  /** Soft crayon wash — node fill. */
  bg: string;
  /** Darker crayon ink — status label text, for contrast on the wash. */
  ink: string;
}

// A box of fresh crayons on paper. Each status gets a stroke, a soft wash fill,
// and a darker ink for legible labels.
export const STATUS_META: Record<TaskStatus, StatusMeta> = {
  pending: { label: "待就绪", color: "#C6C1B4", bg: "#F3F1EA", ink: "#8A857A" },
  ready: { label: "就绪", color: "#7BB7E0", bg: "#EAF4FB", ink: "#3E7BA6" },
  dispatched: { label: "执行中", color: "#F0B94E", bg: "#FDF4E1", ink: "#B37F16" },
  completed: { label: "完成", color: "#7FC98C", bg: "#EBF7EE", ink: "#3E9A55" },
  failed: { label: "失败", color: "#EA6B5E", bg: "#FCECE9", ink: "#C23B2E" },
  blocked: { label: "阻塞", color: "#B79FE0", bg: "#F2EDFB", ink: "#7B5CB8" },
};

/** A live Orca terminal (running agent/shell) a task can be dispatched to. */
export interface Terminal {
  handle: string;
  worktreePath: string;
  worktreeId: string;
  branch: string;
  title: string;
  connected: boolean;
  writable: boolean;
}

/**
 * Harness presets shown in the node action panel. A harness is just the command
 * launched in a fresh terminal — so this list is pure viewer config, not an Orca
 * enum, and users can also type a custom command.
 */
export const HARNESSES = ["claude", "kimi", "opencode", "grok", "codex"] as const;
export type Harness = (typeof HARNESSES)[number] | (string & {});
