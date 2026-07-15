import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pExecFile = promisify(execFile);

/**
 * A single orchestration task as returned by `orca orchestration task-list --json`.
 * Note: `deps` is a JSON-encoded *string* of task ids, not an array.
 */
export interface OrcaTask {
  id: string;
  parent_id: string | null;
  created_by_terminal_handle: string | null;
  spec: string;
  status: "pending" | "ready" | "dispatched" | "completed" | "failed" | "blocked";
  deps: string;
  result: string | null;
  created_at: string;
  completed_at: string | null;
  task_title: string | null;
  display_name: string | null;
}

export interface DagNode {
  id: string;
  label: string;
  status: OrcaTask["status"];
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
  raw: Record<string, unknown>;
}

/**
 * Run `orca <args...> --json` and return the unwrapped `result` payload.
 * Throws with a readable message when the runtime reports `ok: false`.
 */
export async function runOrca<T = unknown>(args: string[]): Promise<T> {
  const fullArgs = args.includes("--json") ? args : [...args, "--json"];
  let stdout: string;
  try {
    const res = await pExecFile("orca", fullArgs, {
      maxBuffer: 32 * 1024 * 1024,
      timeout: 60_000,
    });
    stdout = res.stdout;
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    // orca still emits JSON on some non-zero exits; try to parse it first.
    if (e.stdout && e.stdout.trim().startsWith("{")) {
      stdout = e.stdout;
    } else {
      throw new Error(
        `orca ${fullArgs.join(" ")} failed: ${e.stderr || e.message || "unknown error"}`,
      );
    }
  }

  let parsed: { ok: boolean; result?: T; error?: unknown };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`orca ${fullArgs.join(" ")} returned non-JSON: ${stdout.slice(0, 500)}`);
  }
  if (!parsed.ok) {
    throw new Error(`orca ${fullArgs.join(" ")} not ok: ${JSON.stringify(parsed.error ?? parsed)}`);
  }
  return parsed.result as T;
}

function parseDeps(deps: string | null | undefined): string[] {
  if (!deps) return [];
  try {
    const arr = JSON.parse(deps);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Fetch all orchestration tasks. */
export async function listTasks(): Promise<OrcaTask[]> {
  const result = await runOrca<{ tasks: OrcaTask[] }>(["orchestration", "task-list"]);
  return result.tasks ?? [];
}

/** Fetch decision gates, normalized into a stable shape for the UI. */
export async function listGates(): Promise<Gate[]> {
  try {
    const result = await runOrca<{ gates?: unknown[] }>(["orchestration", "gate-list"]);
    const raw = (result.gates ?? []) as Record<string, unknown>[];
    return raw.map((g) => normalizeGate(g));
  } catch {
    // gate-list may fail if the feature is unavailable; treat as no gates.
    return [];
  }
}

function normalizeGate(g: Record<string, unknown>): Gate {
  let options: string[] = [];
  const rawOptions = g.options;
  if (Array.isArray(rawOptions)) {
    options = rawOptions.map(String);
  } else if (typeof rawOptions === "string") {
    try {
      const parsed = JSON.parse(rawOptions);
      if (Array.isArray(parsed)) options = parsed.map(String);
    } catch {
      options = rawOptions ? [rawOptions] : [];
    }
  }
  return {
    id: String(g.id ?? g.gate_id ?? ""),
    taskId: (g.task_id as string) ?? (g.taskId as string) ?? null,
    question: String(g.question ?? ""),
    options: options.length ? options : ["approved", "rejected"],
    status: String(g.status ?? "pending"),
    resolution: (g.resolution as string) ?? null,
    raw: g,
  };
}

/** A live Orca-managed terminal (a running agent/shell session). */
export interface OrcaTerminal {
  handle: string;
  worktreePath: string;
  worktreeId: string;
  branch: string;
  title: string;
  connected: boolean;
  writable: boolean;
}

/** List live terminals — these are the sessions a task can be dispatched to. */
export async function listTerminals(): Promise<OrcaTerminal[]> {
  const result = await runOrca<{ terminals?: Record<string, unknown>[] }>(["terminal", "list"]);
  return (result.terminals ?? []).map((t) => ({
    handle: String(t.handle ?? ""),
    worktreePath: String(t.worktreePath ?? ""),
    worktreeId: String(t.worktreeId ?? ""),
    branch: String(t.branch ?? "").replace(/^refs\/heads\//, ""),
    title: String(t.title ?? "").trim(),
    connected: Boolean(t.connected),
    writable: Boolean(t.writable),
  }));
}

export interface WorkerResult {
  handle: string;
  worktreeId: string;
}

/**
 * Spawn a worker agent terminal running `harness` in a worktree.
 *
 * The coordinator (`orca orchestration run`) does NOT spawn workers itself — it
 * dispatches ready tasks to idle worker terminals that already exist. So the
 * viewer builds that pool: a "harness" is just the command launched in the
 * terminal (claude / kimi / opencode / grok / codex …), which is where the
 * choice of agent lives.
 */
export async function createWorker(harness: string, worktree = "active"): Promise<WorkerResult> {
  const created = await runOrca<{ terminal?: { handle?: string; worktreeId?: string } }>([
    "terminal",
    "create",
    "--worktree",
    worktree,
    "--command",
    harness,
  ]);
  const handle = created.terminal?.handle;
  if (!handle) throw new Error("orca terminal create 未返回 handle");
  return { handle, worktreeId: created.terminal?.worktreeId ?? "" };
}

export interface RunResult {
  runId: string;
  status: string;
}

/**
 * Start the coordinator loop. Orca then auto-executes the DAG: it dispatches
 * ready tasks across idle workers, respects dependencies, and advances as
 * workers report `worker_done` — until the graph is done. Returns immediately
 * with a runId (the loop lives inside the Orca runtime).
 */
export async function startRun(spec: string, worktree = "active"): Promise<RunResult> {
  const r = await runOrca<{ runId?: string; status?: string }>([
    "orchestration",
    "run",
    "--spec",
    spec,
    "--worktree",
    worktree,
  ]);
  return { runId: r.runId ?? "", status: r.status ?? "running" };
}

/** Stop the active coordinator run. No-op when none is running. */
export async function stopRun(): Promise<void> {
  try {
    await runOrca(["orchestration", "run-stop"]);
  } catch (e) {
    if (!String(e).includes("No active coordinator run")) throw e;
  }
}

/** Transform the raw task list into a nodes/edges DAG for the UI. */
export function tasksToDag(tasks: OrcaTask[]): { nodes: DagNode[]; edges: DagEdge[] } {
  const idSet = new Set(tasks.map((t) => t.id));
  const nodes: DagNode[] = tasks.map((t) => ({
    id: t.id,
    label: (t.display_name || t.task_title || t.spec || t.id).trim(),
    status: t.status,
    spec: t.spec,
    result: t.result,
    createdAt: t.created_at,
    completedAt: t.completed_at,
  }));

  const edges: DagEdge[] = [];
  for (const t of tasks) {
    for (const dep of parseDeps(t.deps)) {
      if (idSet.has(dep)) {
        edges.push({ id: `${dep}__${t.id}`, source: dep, target: t.id });
      }
    }
  }
  return { nodes, edges };
}
