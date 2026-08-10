export type TaskStatus =
  | "pending"
  | "ready"
  | "dispatched"
  | "completed"
  | "failed"
  | "blocked";

/** Canvas layout algorithms the viewer can arrange the DAG with. */
export type LayoutKind = "layered-lr" | "layered-tb" | "force";

export const LAYOUTS: { kind: LayoutKind; label: string; icon: string; title: string }[] = [
  { kind: "layered-lr", label: "横向", icon: "⇄", title: "分层布局 · 从左到右（Sugiyama / dagre）" },
  { kind: "layered-tb", label: "纵向", icon: "⇅", title: "分层布局 · 从上到下（Sugiyama / dagre）" },
  { kind: "force", label: "力导", icon: "❋", title: "力导向布局（Fruchterman–Reingold）" },
];

export interface DagNode {
  id: string;
  label: string;
  status: TaskStatus;
  spec: string;
  result: string | null;
  createdAt: string;
  completedAt: string | null;
  /** Current Orca Dispatch (one attempt). Only set while dispatched. */
  dispatchId: string | null;
  /** Terminal running the current attempt. Only set while dispatched. */
  assigneeHandle: string | null;
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
  /** Tasks are Run-scoped since Orca 1.4.160 — a DAG always belongs to one Run. */
  runId: string;
  nodes: DagNode[];
  edges: DagEdge[];
  gates: Gate[];
  generatedAt: number;
}

/** A lightweight orchestration Run: namespace + coordinator inbox. */
export interface OrcaRun {
  id: string;
  objective: string;
  coordinator_handle: string | null;
  created_at: string;
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

/**
 * Harness presets. These are Orca TUI agent ids: the coordinator passes one to
 * `orca orchestration worker-start --agent <id>`, so Orca owns the launcher and
 * its autonomous flags. Anything Orca doesn't recognize (a custom command) still
 * works — the coordinator falls back to creating the terminal itself.
 */
export const HARNESSES = [
  "claude",
  "codex",
  "opencode",
  "gemini",
  "grok",
  "cursor",
  "droid",
  "kimi",
] as const;
export type Harness = (typeof HARNESSES)[number] | (string & {});

/**
 * One in-flight attempt, mirroring an Orca Dispatch. `supervised` attempts were
 * started by `worker-start` and Orca tracks them; `legacy` ones were composed by
 * hand for a harness Orca doesn't recognize as a configured TUI agent.
 */
export interface RunAttempt {
  taskId: string;
  harness: string;
  mode: "supervised" | "legacy";
  dispatchId: string | null;
  handle: string | null;
  /** Orca fails the task after 3 consecutive attempt failures. */
  failureCount: number;
  lastHeartbeatAt: string | null;
}

/** Live status of the self-driven coordinator. */
export interface RunStatus {
  running: boolean;
  /** The Run this coordinator bound itself to. */
  runId: string | null;
  /** The Orca terminal the coordinator borrows for mutating calls. */
  coordinatorHandle: string | null;
  busy: number;
  error: string | null;
  startedAt: number;
  lastTick: number;
  attempts: RunAttempt[];
}

/**
 * Viewer configuration persisted server-side in `.orca-dag.config.json`
 * (workspace root) — Orca tasks have no metadata field for harness choices,
 * so the viewer keeps its own store instead of browser localStorage.
 */
export interface ViewerConfig {
  defaultHarness: string;
  harnessByTask: Record<string, string>;
  /**
   * Per-task model override. Only meaningful for harnesses that support model
   * selection (opencode via `-m`, claude/codex/cursor via `worker-start
   * --model`); empty string / absent means the agent's default model.
   */
  modelByTask: Record<string, string>;
  maxConcurrency: number;
  layout: LayoutKind | "";
  /** Last Run the user was viewing; restored on reload. */
  runId: string;
}

/**
 * Harness → model-selection capability. opencode gets an enumerable dropdown
 * (`opencode models`); claude/codex/cursor get free-text. Everything else has
 * no viewer-side model control.
 */
export type ModelPickerKind = "select" | "text" | "none";

export const MODEL_PICKER: Record<string, ModelPickerKind> = {
  opencode: "select",
  claude: "text",
  codex: "text",
  cursor: "text",
};
