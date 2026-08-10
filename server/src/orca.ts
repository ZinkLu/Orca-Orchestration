import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pExecFile = promisify(execFile);

/**
 * Thin wrapper over the `orca` CLI (Orca >= 1.4.160, orchestration contract v1).
 *
 * ## The Run / Task / Dispatch model
 *
 * Orca 1.4.160 (PR #9925, shipped 2026-07-29) replaced the old flat "one global
 * task pool" with three layers:
 *
 *   Run      — durable namespace + coordinator inbox. Owns a single bound
 *              coordinator terminal (fenced by `consumer_generation`).
 *   Task     — the work item. Carries `deps` (the DAG edges) and `run_id`.
 *   Dispatch — ONE attempt of a task on one terminal (`ctx_*` ids, despite the
 *              field being called `dispatch_id`). Retries create a new Dispatch.
 *
 * `orchestration run`, `run-stop`, `coordinator-start` and `coordinator-stop`
 * are retired: they apply no effects and just return a "go read the skill"
 * payload. Orca deliberately ships no scheduler — picking placement and
 * concurrency is the caller's job, which is why this viewer still drives its
 * own dispatch loop.
 *
 * ## Authority (this is the part that shapes the whole server)
 *
 * Every orchestration RPC funnels through `resolveRunScope`:
 *
 *   - READS (`task-list`, `gate-list`) with an explicit `--run <id>` skip the
 *     consumer check entirely — any process can read any Run. The viewer's
 *     polling path needs nothing else.
 *   - MUTATIONS (`dispatch`, `gate-resolve`, `task-create`, `task-update`) and
 *     `worker-start` require the CALLER to be the live Orca terminal currently
 *     bound to that Run. The check resolves `--from <handle>` to a pane key and
 *     compares it against the Run's binding.
 *
 * A plain `execFile("orca", ...)` from this server has no terminal identity, so
 * every mutation would fail `run_required`. The escape hatch is `--from`: we
 * keep our own Orca terminal (see `ensureCoordinatorTerminal`), bind it to the
 * Run, and pass its handle on every mutating call.
 *
 * Binding fences whichever terminal was bound before — so starting a run here
 * takes coordination of that Run away from the user's agent terminal. The
 * agent can always take it back with `orca orchestration run-use --id <run>`.
 */

export type TaskStatus =
  | "pending"
  | "ready"
  | "dispatched"
  | "completed"
  | "failed"
  | "blocked";

/**
 * An `orca ... --json` failure, carrying Orca's machine-readable error code and,
 * when the runtime offers one, the exact command that unblocks it (e.g. an
 * adopted Run answers `consumer_fenced` with a `run-use --takeover-legacy`).
 */
export class OrcaCliError extends Error {
  readonly code: string | null;
  readonly recoveryCommand: string | null;
  constructor(message: string, code: string | null = null, recoveryCommand: string | null = null) {
    super(message);
    this.name = "OrcaCliError";
    this.code = code;
    this.recoveryCommand = recoveryCommand;
  }
}

/**
 * A task row from `orchestration task-list --run <id> --json`.
 *
 * `deps` is a JSON-encoded *string* of task ids, not an array. `assignee_handle`
 * and `dispatch_id` are only present while `status === "dispatched"` — the
 * runtime strips them from every other row.
 */
export interface OrcaTask {
  id: string;
  parent_id: string | null;
  created_by_terminal_handle: string | null;
  spec: string;
  status: TaskStatus;
  deps: string;
  result: string | null;
  created_at: string;
  completed_at: string | null;
  task_title: string | null;
  display_name: string | null;
  run_id: string;
  assignee_handle?: string | null;
  dispatch_id?: string | null;
}

/** A lightweight orchestration Run: namespace + coordinator inbox. */
export interface OrcaRun {
  id: string;
  objective: string;
  coordinator_handle: string | null;
  consumer_generation: number;
  /** 1 for the inspect-only `run_legacy_local` audit tombstone. */
  legacy: number;
  created_at: string;
  updated_at: string;
}

/** One attempt of a task, as returned by `dispatch-show` / `worker-show`. */
export interface OrcaDispatch {
  id: string;
  task_id: string;
  run_id: string;
  status: string;
  assignee_handle: string | null;
  /** Circuit breaker: Orca fails the task after 3 consecutive attempt failures. */
  failure_count: number;
  last_failure: string | null;
  last_heartbeat_at: string | null;
  dispatched_at: string | null;
  completed_at: string | null;
}

export interface DagNode {
  id: string;
  label: string;
  status: TaskStatus;
  spec: string;
  result: string | null;
  createdAt: string;
  completedAt: string | null;
  /** Live attempt, present only while dispatched. */
  dispatchId: string | null;
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
  raw: Record<string, unknown>;
}

/**
 * Run `orca <args...> --json` and return the unwrapped `result` payload.
 * Throws an `OrcaCliError` carrying `error.code` when the runtime reports
 * `ok: false`, so callers can branch on `run_required` / `consumer_fenced`.
 */
export async function runOrca<T = unknown>(args: string[]): Promise<T> {
  const fullArgs = args.includes("--json") ? args : [...args, "--json"];
  let stdout: string;
  try {
    const res = await pExecFile("orca", fullArgs, {
      maxBuffer: 32 * 1024 * 1024,
      timeout: 180_000,
    });
    stdout = res.stdout;
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    // worker-start exits non-zero on a failed/unknown start but still emits the
    // JSON receipt, so parse stdout before giving up.
    if (e.stdout && e.stdout.trim().startsWith("{")) {
      stdout = e.stdout;
    } else {
      throw new OrcaCliError(
        `orca ${fullArgs.join(" ")} failed: ${e.stderr || e.message || "unknown error"}`,
      );
    }
  }

  let parsed: {
    ok: boolean;
    result?: T;
    error?: { code?: string; message?: string; data?: { recoveryCommand?: string } };
  };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new OrcaCliError(`orca ${fullArgs.join(" ")} returned non-JSON: ${stdout.slice(0, 500)}`);
  }
  if (!parsed.ok) {
    const code = parsed.error?.code ?? null;
    const message = parsed.error?.message ?? JSON.stringify(parsed.error ?? parsed);
    const recovery = parsed.error?.data?.recoveryCommand ?? null;
    throw new OrcaCliError(
      `orca ${args[0]} ${args[1] ?? ""}: ${message}`.trim(),
      code,
      recovery,
    );
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

// --- Runs ------------------------------------------------------------------

/** List Runs, newest first. Read-only: needs no coordinator terminal. */
export async function listRuns(): Promise<OrcaRun[]> {
  const result = await runOrca<{ runs?: OrcaRun[] }>(["orchestration", "run-list", "--limit", "50"]);
  const runs = result.runs ?? [];
  return runs
    .filter((r) => r.legacy !== 1) // the audit tombstone is inspect-only and always empty
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

/**
 * Create a Run and bind it to `from`. `run-create` requires a live Orca
 * terminal (it derives the coordinator pane from `--from`).
 */
export async function createRun(objective: string, from: string): Promise<OrcaRun> {
  const result = await runOrca<{ run: OrcaRun }>([
    "orchestration",
    "run-create",
    "--objective",
    objective,
    "--from",
    from,
  ]);
  return result.run;
}

/**
 * Bind `from` to an existing Run. This FENCES whatever terminal was bound
 * before — the previous coordinator's mutations start failing `consumer_fenced`.
 */
export async function bindRun(runId: string, from: string): Promise<OrcaRun> {
  const result = await runOrca<{ run: OrcaRun }>([
    "orchestration",
    "run-use",
    "--id",
    runId,
    "--from",
    from,
  ]);
  return result.run;
}

// --- Read paths (no coordinator terminal needed) ---------------------------

/** Fetch a Run's tasks. Requires `--run`: an unscoped call fails `run_required`. */
export async function listTasks(runId: string): Promise<OrcaTask[]> {
  const result = await runOrca<{ tasks: OrcaTask[] }>([
    "orchestration",
    "task-list",
    "--run",
    runId,
  ]);
  return result.tasks ?? [];
}

/** Fetch a Run's decision gates, normalized for the UI. */
export async function listGates(runId: string): Promise<Gate[]> {
  const result = await runOrca<{ gates?: unknown[] }>([
    "orchestration",
    "gate-list",
    "--run",
    runId,
  ]);
  const raw = (result.gates ?? []) as Record<string, unknown>[];
  return raw.map((g) => normalizeGate(g));
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

/** Inspect one attempt. Read-only. */
export async function showDispatch(dispatchId: string): Promise<OrcaDispatch | null> {
  try {
    const result = await runOrca<{ worker?: OrcaDispatch; dispatch?: OrcaDispatch }>([
      "orchestration",
      "worker-show",
      "--dispatch",
      dispatchId,
    ]);
    return result.worker ?? result.dispatch ?? null;
  } catch {
    // A dispatch created by the low-level path may not be a supervised worker.
    return null;
  }
}

// --- Mutations (all need `--from <coordinator handle>`) --------------------

/**
 * Resolve a decision gate. Mutating: needs the bound coordinator terminal.
 *
 * `gate-resolve` takes NO `--run` flag — unlike the READS (`task-list`,
 * `gate-list`), mutations resolve their Run scope from the bound `--from`
 * terminal, not from `--run`. The gate id (`--id`) is globally unique. Passing
 * `--run` here used to be rejected with `Unknown flag --run`, which broke every
 * human approval. The Run binding itself is established upstream by
 * `asCoordinator` → `bindRun(runId, handle)` before this is called.
 */
export async function resolveGate(
  gateId: string,
  resolution: string,
  from: string,
): Promise<void> {
  await runOrca([
    "orchestration",
    "gate-resolve",
    "--id",
    gateId,
    "--resolution",
    resolution,
    "--from",
    from,
  ]);
}

/**
 * Update a task's status (and, optionally, its result JSON). Mutating: needs
 * the bound coordinator terminal (`--from`).
 *
 * This exists for the one transition Orca does NOT drive itself: a task left
 * `blocked` after its entry gate was approved. `gate-resolve` records the
 * approval but does not flip the gated task out of `blocked` — and an approval
 * done through the viewer's throwaway coordinator terminal (see `asCoordinator`
 * in index.ts) closes that terminal before any unblock side-effect can land on
 * a live consumer, so the task stays `blocked` and the dispatch loop sees zero
 * `ready` tasks. The bound coordinator (which is alive for the whole run) has
 * to nudge it to `ready` itself. A `rejected` gate is left alone here — that's
 * a task-failure decision the caller should make explicitly.
 *
 * `--run` IS a valid flag for `task-update` (unlike `gate-resolve`), so we pass
 * it for explicit scope alongside the `--from` authority.
 */
export async function taskUpdate(
  taskId: string,
  status: TaskStatus,
  runId: string,
  from: string,
  result?: string,
): Promise<void> {
  const args = [
    "orchestration",
    "task-update",
    "--id",
    taskId,
    "--status",
    status,
    "--run",
    runId,
    "--from",
    from,
  ];
  if (result !== undefined) args.push("--result", result);
  await runOrca(args);
}

// --- Terminals -------------------------------------------------------------

/** A live Orca-managed terminal. */
export interface OrcaTerminal {
  handle: string;
  worktreePath: string;
  worktreeId: string;
  branch: string;
  title: string;
  connected: boolean;
  writable: boolean;
}

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

/** Title we stamp on our own coordinator terminal so we can find it again. */
export const COORDINATOR_TITLE = "orca-dag coordinator";

/**
 * Get (or create) the plain shell terminal this viewer uses as its coordinator
 * identity. It runs no agent — it exists purely so mutating RPCs have a live
 * pane to attribute `--from` to.
 *
 * Note `worker-start --worktree current` resolves "current" against THIS
 * terminal's worktree, not the server's cwd, so the coordinator has to live in
 * the worktree the workers should run in.
 */
export async function ensureCoordinatorTerminal(worktree = "active"): Promise<string> {
  const existing = (await listTerminals()).find(
    (t) => t.title === COORDINATOR_TITLE && t.connected,
  );
  if (existing) return existing.handle;

  const created = await runOrca<{ terminal?: { handle?: string } }>([
    "terminal",
    "create",
    "--worktree",
    worktree,
    "--title",
    COORDINATOR_TITLE,
  ]);
  const handle = created.terminal?.handle;
  if (!handle) throw new OrcaCliError("orca terminal create 未返回 coordinator handle");
  return handle;
}

/**
 * A single-use coordinator terminal for one ad-hoc mutation (gate resolve,
 * run-create). Unique title on purpose: `ensureCoordinatorTerminal` dedupes by
 * exact title, and reusing — or worse, closing — the loop's own terminal from
 * an ad-hoc path would fence and then kill a running coordinator.
 */
let tempSeq = 0;
export async function createTempCoordinatorTerminal(worktree = "active"): Promise<string> {
  const created = await runOrca<{ terminal?: { handle?: string } }>([
    "terminal",
    "create",
    "--worktree",
    worktree,
    "--title",
    `${COORDINATOR_TITLE} · adhoc ${++tempSeq}`,
  ]);
  const handle = created.terminal?.handle;
  if (!handle) throw new OrcaCliError("orca terminal create 未返回 adhoc handle");
  return handle;
}

/** Close a terminal. Best-effort: it may already be gone. */
export async function closeTerminal(handle: string): Promise<void> {
  try {
    await runOrca(["terminal", "close", "--terminal", handle]);
  } catch {
    /* already closed */
  }
}

// --- Starting workers ------------------------------------------------------

/**
 * Harness → launch command for the LEGACY path only (custom commands, or an
 * agent `worker-start` refuses). On the `worker-start` path Orca owns the
 * launcher, so no hand-maintained autonomous flag is needed — which is why
 * these entries only matter for harnesses Orca does not recognize.
 *
 * `claude --dangerously-skip-permissions` is verified; the rest are the bare
 * command and will stall on a permission prompt unless you add the right flag.
 */
export const HARNESS_LAUNCH: Record<string, string> = {
  claude: "claude --dangerously-skip-permissions",
};

export function harnessCommand(harness: string): string {
  return HARNESS_LAUNCH[harness] ?? harness;
}

/** How a task's worker was started — decides how we tear it down. */
export type WorkerMode = "supervised" | "legacy";

export interface StartedWorker {
  mode: WorkerMode;
  /** Supervised attempts only. */
  dispatchId: string | null;
  /** The worker terminal, when we created it ourselves. */
  handle: string | null;
}

/** Dig the dispatch id out of a `worker-start` receipt, whatever its shape. */
function readDispatchId(result: unknown): string | null {
  const r = (result ?? {}) as Record<string, unknown>;
  const direct = r.dispatchId ?? r.dispatch_id;
  if (typeof direct === "string" && direct) return direct;
  for (const key of ["dispatch", "worker"]) {
    const nested = r[key] as Record<string, unknown> | undefined;
    const id = nested?.id ?? nested?.dispatchId ?? nested?.dispatch_id;
    if (typeof id === "string" && id) return id;
  }
  return null;
}

/**
 * Preferred path: let Orca compose worktree + terminal + readiness + dispatch.
 * Exits 0 only when the worker is `ready`; a failed start throws with the
 * receipt's stage/effects in the message.
 */
export async function startSupervisedWorker(opts: {
  taskId: string;
  agent: string;
  runId: string;
  from: string;
  worktree?: string;
}): Promise<StartedWorker> {
  const result = await runOrca<Record<string, unknown>>([
    "orchestration",
    "worker-start",
    "--task",
    opts.taskId,
    "--agent",
    opts.agent,
    "--worktree",
    opts.worktree ?? "current",
    "--run",
    opts.runId,
    "--from",
    opts.from,
  ]);
  return { mode: "supervised", dispatchId: readDispatchId(result), handle: null };
}

/**
 * opencode workaround, verified end-to-end against Orca on 2026-08-10.
 *
 * `worker-start --agent opencode` opens the opencode TUI but does not reliably
 * land the injected preamble (orca #9951) — the app opens with no prompt and
 * never executes. The generic TUI-injection that `startLegacyWorker` uses is
 * the same unreliable channel, so opencode gets its own path:
 *
 *   1. create a BARE SHELL terminal (NOT the opencode TUI),
 *   2. dispatch for tracking only (no `--inject`) to mint a real dispatch_id,
 *   3. fetch the preamble — it now carries that real dispatch_id AND the
 *      worker handle as `--from`, both required for worker_done to settle,
 *   4. run `opencode run --auto "$(cat <preamble-file>)"` in the shell.
 *
 * opencode executes the preamble's `orca orchestration send --type worker_done`
 * via its Bash tool, settling the task (`completed`), which the coordinator
 * loop picks up from task-list. `--auto` is REQUIRED: opencode's default
 * permission policy auto-rejects tool calls (e.g. writing outside the project)
 * and silently kills the task otherwise — the same class of quirk as
 * `claude --dangerously-skip-permissions` above.
 */
async function startOpencodeWorker(opts: {
  taskId: string;
  runId: string;
  from: string;
  worktree?: string;
}): Promise<StartedWorker> {
  const created = await runOrca<{ terminal?: { handle?: string } }>([
    "terminal",
    "create",
    "--worktree",
    opts.worktree ?? "active",
    "--command",
    "/bin/zsh",
  ]);
  const handle = created.terminal?.handle;
  if (!handle) throw new OrcaCliError("orca terminal create 未返回 worker handle (opencode)");

  // Dispatch for tracking only (no --inject). This mints a real dispatch_id,
  // without which the preamble below would still carry the ctx_preview
  // placeholder and worker_done could never settle.
  await runOrca([
    "orchestration",
    "dispatch",
    "--task",
    opts.taskId,
    "--to",
    handle,
    "--run",
    opts.runId,
    "--from",
    opts.from,
  ]);

  // Fetch the preamble. After the tracking dispatch it embeds the real
  // dispatch_id and the worker handle (`--from <handle>`), which the worker
  // process must echo back for worker_done to be accepted.
  const shown = await runOrca<{ preamble?: string }>([
    "orchestration",
    "dispatch-show",
    "--task",
    opts.taskId,
    "--preamble",
    "--from",
    opts.from,
  ]);
  if (!shown.preamble) throw new OrcaCliError("orca dispatch-show 未返回 preamble (opencode)");

  // Write the preamble to a temp file and pass it as ONE shell argument via
  // "$(cat ...)". Embedding the multiline preamble directly would put it
  // through shell quoting/escaping hell; reading it from a file keeps it byte
  // for byte intact.
  const preambleFile = join(tmpdir(), `orca-preamble-${opts.taskId}.txt`);
  await writeFile(preambleFile, shown.preamble);
  const cmd = `opencode run --auto "$(cat ${preambleFile})"`;
  await runOrca(["terminal", "send", "--terminal", handle, "--text", cmd, "--enter"]);

  return { mode: "legacy", dispatchId: null, handle };
}

/**
 * Fallback for harnesses Orca does not know as a configured TUI agent (custom
 * commands, or anything `worker-start` rejects with `agent_unconfigured`).
 *
 * Mirrors what `worker-start` composes, by hand: create the terminal, wait for
 * its TUI, then dispatch. `--inject` needs Orca to recognize a running agent in
 * the pane; when it doesn't, we fall back to dispatching for tracking only and
 * typing the preamble in ourselves.
 *
 * opencode is handled specially (see `startOpencodeWorker`): its TUI does not
 * accept the injected preamble, so it runs `opencode run --auto` in a bare
 * shell instead.
 */
export async function startLegacyWorker(opts: {
  taskId: string;
  harness: string;
  runId: string;
  from: string;
  worktree?: string;
}): Promise<StartedWorker> {
  if (opts.harness === "opencode") {
    return startOpencodeWorker(opts);
  }
  const created = await runOrca<{ terminal?: { handle?: string } }>([
    "terminal",
    "create",
    "--worktree",
    opts.worktree ?? "active",
    "--command",
    harnessCommand(opts.harness),
  ]);
  const handle = created.terminal?.handle;
  if (!handle) throw new OrcaCliError("orca terminal create 未返回 worker handle");

  try {
    await runOrca([
      "terminal",
      "wait",
      "--terminal",
      handle,
      "--for",
      "tui-idle",
      "--timeout-ms",
      "45000",
    ]);
  } catch {
    // some harnesses never report tui-idle; try to dispatch anyway
  }

  const base = [
    "orchestration",
    "dispatch",
    "--task",
    opts.taskId,
    "--to",
    handle,
    "--run",
    opts.runId,
    "--from",
    opts.from,
  ];

  try {
    await runOrca([...base, "--inject"]);
    // `--inject` types the preamble into the TUI but does not reliably submit
    // it — the text can sit unsent in the input box. Settle, then press Enter.
    // A stray Enter on an already-submitted input is a harmless no-op.
    await sleep(2000);
    await runOrca(["terminal", "send", "--terminal", handle, "--enter"]).catch(() => {});
  } catch (err) {
    if ((err as OrcaCliError).code !== "agent_unconfigured") throw err;
    // Bare shell: dispatch for tracking, then deliver the preamble manually.
    await runOrca(base);
    const shown = await runOrca<{ preamble?: string }>([
      "orchestration",
      "dispatch-show",
      "--task",
      opts.taskId,
      "--preamble",
      "--from",
      opts.from,
    ]);
    if (shown.preamble) {
      await runOrca([
        "terminal",
        "send",
        "--terminal",
        handle,
        "--text",
        shown.preamble,
        "--enter",
      ]);
    }
  }

  return { mode: "legacy", dispatchId: null, handle };
}

/** Stop one supervised worker. Closes only its agent terminal. */
export async function stopSupervisedWorker(dispatchId: string): Promise<void> {
  try {
    await runOrca(["orchestration", "worker-stop", "--dispatch", dispatchId]);
  } catch {
    /* already settled */
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- DAG projection --------------------------------------------------------

/** Transform a Run's task list into a nodes/edges DAG for the UI. */
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
    dispatchId: t.dispatch_id ?? null,
    assigneeHandle: t.assignee_handle ?? null,
  }));

  const edges: DagEdge[] = [];
  for (const t of tasks) {
    for (const dep of parseDeps(t.deps)) {
      // Deps are Run-scoped in practice: task-list only returns this Run's rows,
      // so an id we don't know is a dangling edge and is dropped.
      if (idSet.has(dep)) {
        edges.push({ id: `${dep}__${t.id}`, source: dep, target: t.id });
      }
    }
  }
  return { nodes, edges };
}
