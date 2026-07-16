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

/**
 * How to launch each harness as an AUTONOMOUS worker — i.e. able to run the
 * `orca orchestration send --type worker_done …` completion command without a
 * human clicking "approve". A plain interactive agent would stall on the
 * permission prompt and never report done.
 *
 * `claude --dangerously-skip-permissions` is verified. The others are the bare
 * command as a placeholder — each agent's own approval-off flag must be filled
 * in and verified before it works hands-off (see README).
 */
export const HARNESS_LAUNCH: Record<string, string> = {
  claude: "claude --dangerously-skip-permissions",
  codex: "codex", // TODO: verify autonomous flag
  opencode: "opencode", // TODO: verify autonomous flag
  kimi: "kimi", // TODO: verify autonomous flag
  grok: "grok", // TODO: verify autonomous flag
};

/** The launch command for a harness (autonomous variant if known). */
export function harnessCommand(harness: string): string {
  return HARNESS_LAUNCH[harness] ?? harness;
}

/**
 * Spawn an autonomous worker agent terminal for `harness` and wait for its TUI
 * to be ready. Returns the terminal handle. Requires the cwd to be an
 * Orca-managed worktree.
 */
export async function spawnWorker(harness: string, worktree = "active"): Promise<string> {
  const created = await runOrca<{ terminal?: { handle?: string } }>([
    "terminal",
    "create",
    "--worktree",
    worktree,
    "--command",
    harnessCommand(harness),
  ]);
  const handle = created.terminal?.handle;
  if (!handle) throw new Error("orca terminal create 未返回 handle");
  // Best-effort: wait for the agent to boot before it can receive a dispatch.
  try {
    await runOrca(["terminal", "wait", "--terminal", handle, "--for", "tui-idle", "--timeout-ms", "45000"]);
  } catch {
    // some harnesses never report tui-idle; the coordinator will still try
  }
  return handle;
}

/** Dispatch a task to a worker terminal (injects the coordinator preamble). */
export async function dispatchTask(taskId: string, handle: string): Promise<void> {
  await runOrca(["orchestration", "dispatch", "--task", taskId, "--to", handle, "--inject"]);
  // `--inject` types the preamble into the agent's TUI but doesn't reliably
  // submit it — the text can sit unsent in the input box (a readiness race).
  // Settle briefly, then press Enter so the worker actually starts. A stray
  // Enter on an already-submitted/empty input is a harmless no-op.
  await sleep(2000);
  try {
    await runOrca(["terminal", "send", "--terminal", handle, "--enter"]);
  } catch {
    // best-effort nudge
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Close a terminal (used to tear down workers when a run ends). */
export async function closeTerminal(handle: string): Promise<void> {
  try {
    await runOrca(["terminal", "close", "--terminal", handle]);
  } catch {
    // terminal may already be gone
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
