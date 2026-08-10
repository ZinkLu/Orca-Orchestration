import {
  OrcaCliError,
  bindRun,
  closeTerminal,
  ensureCoordinatorTerminal,
  listGates,
  listTasks,
  showDispatch,
  startLegacyWorker,
  startSupervisedWorker,
  stopSupervisedWorker,
  taskUpdate,
  type OrcaTask,
  type StartedWorker,
} from "./orca";

/**
 * Self-driven coordinator.
 *
 * Orca ships no scheduler on purpose — `orchestration run` / `coordinator-start`
 * are retired and the current skill states plainly that "agents still choose
 * placement and concurrency; Orca does not schedule workers". So the viewer
 * remains the thing that walks the DAG: each tick it finds every `ready` task
 * and starts a worker for it, up to a concurrency cap.
 *
 * What changed in Orca 1.4.160 is everything *below* that loop. We no longer
 * hand-roll terminal creation, TUI readiness and dispatch, and we no longer
 * keep our own worker table: `worker-start` composes the whole thing and hands
 * back a Dispatch, which is Orca's own record of "one attempt of one task" —
 * complete with failure_count, heartbeats and stop/abandon semantics.
 *
 * Authority: mutations require a live Orca terminal bound to the Run, so the
 * coordinator owns one (`ensureCoordinatorTerminal`) and binds it on start.
 * That fences whoever was bound before — see `startCoordinator`.
 */

/** One in-flight attempt, mirroring the Orca Dispatch we started. */
interface Attempt {
  taskId: string;
  harness: string;
  mode: StartedWorker["mode"];
  dispatchId: string | null;
  /** Worker terminal, only when we created it on the legacy path. */
  handle: string | null;
  /** Live from `worker-show`, for the UI. */
  failureCount: number;
  lastHeartbeatAt: string | null;
}

interface StartOpts {
  runId: string;
  harnessByTask: Record<string, string>;
  defaultHarness: string;
  maxConcurrency: number;
  /** Worktree the coordinator terminal (and therefore `current` workers) lives in. */
  worktree: string;
}

interface State {
  running: boolean;
  /** Set once the coordinator terminal is bound; null while starting. */
  runId: string | null;
  coordinatorHandle: string | null;
  opts: StartOpts | null;
  attempts: Map<string, Attempt>;
  startedAt: number;
  error: string | null;
  lastTick: number;
}

const POLL_MS = 3500;
const TERMINAL_STATUS = new Set(["completed", "failed"]);
/** Orca rejects these agents for `worker-start`; retry them the legacy way. */
const UNCONFIGURED_AGENT_CODES = new Set(["agent_unconfigured", "invalid_argument"]);

const state: State = {
  running: false,
  runId: null,
  coordinatorHandle: null,
  opts: null,
  attempts: new Map(),
  startedAt: 0,
  error: null,
  lastTick: 0,
};

export function coordinatorStatus() {
  return {
    running: state.running,
    runId: state.runId,
    coordinatorHandle: state.coordinatorHandle,
    error: state.error,
    startedAt: state.startedAt,
    lastTick: state.lastTick,
    attempts: [...state.attempts.values()].map((a) => ({
      taskId: a.taskId,
      harness: a.harness,
      mode: a.mode,
      dispatchId: a.dispatchId,
      handle: a.handle,
      failureCount: a.failureCount,
      lastHeartbeatAt: a.lastHeartbeatAt,
    })),
    busy: state.attempts.size,
  };
}

/**
 * Bind the Run and start the dispatch loop.
 *
 * Binding is the side effect worth knowing about: it fences whatever terminal
 * was coordinating this Run, so the user's agent terminal will start getting
 * `consumer_fenced` on its own mutations until it runs `run-use` again.
 */
export async function startCoordinator(opts: StartOpts): Promise<void> {
  if (state.running) return;
  state.running = true;
  state.opts = opts;
  state.attempts = new Map();
  state.error = null;
  state.runId = null;
  state.startedAt = Date.now();

  try {
    const handle = await ensureCoordinatorTerminal(opts.worktree);
    // The user may have hit stop while we were creating/binding — if so the
    // stop already ran with no handle to close, so close it here ourselves.
    if (!state.running) {
      await closeTerminal(handle);
      return;
    }
    await bindRun(opts.runId, handle);
    if (!state.running) {
      await closeTerminal(handle);
      return;
    }
    state.coordinatorHandle = handle;
    state.runId = opts.runId;
  } catch (err) {
    state.running = false;
    state.error = String((err as Error).message ?? err);
    throw err;
  }

  void loop();
}

/** Stop the loop and tear down everything we started. */
export async function stopCoordinator(closeWorkers = true): Promise<void> {
  state.running = false;
  const attempts = [...state.attempts.values()];
  const coordinator = state.coordinatorHandle;
  state.attempts = new Map();
  state.coordinatorHandle = null;

  if (!closeWorkers) return;

  await Promise.all(
    attempts.map(async (a) => {
      if (a.dispatchId) await stopSupervisedWorker(a.dispatchId);
      else if (a.handle) await closeTerminal(a.handle);
    }),
  );
  // Release our claim on the Run: with the pane gone, the user's agent can
  // rebind with `orca orchestration run-use --id <run>`.
  if (coordinator) await closeTerminal(coordinator);
}

async function loop(): Promise<void> {
  while (state.running) {
    try {
      await tick();
    } catch (e) {
      state.error = String((e as Error).message ?? e);
    }
    if (!state.running) break;
    await sleep(POLL_MS);
  }
}

async function tick(): Promise<void> {
  const opts = state.opts!;
  const runId = state.runId!;
  let tasks = await listTasks(runId);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  state.lastTick = Date.now();

  // Drop attempts whose task reached a terminal state, and refresh the rest
  // from Orca's own Dispatch record — in parallel, since each worker-show is a
  // full CLI round-trip and a serial sweep would stretch the tick.
  for (const [taskId] of [...state.attempts]) {
    const task = byId.get(taskId);
    if (!task || TERMINAL_STATUS.has(task.status)) state.attempts.delete(taskId);
  }
  await Promise.all(
    [...state.attempts.values()].map(async (attempt) => {
      const task = byId.get(attempt.taskId);
      // task-list only carries dispatch_id while dispatched; adopt it so legacy
      // attempts get a Dispatch identity too.
      if (!attempt.dispatchId && task?.dispatch_id) attempt.dispatchId = task.dispatch_id;
      if (!attempt.dispatchId) return;
      const d = await showDispatch(attempt.dispatchId);
      if (d) {
        attempt.failureCount = d.failure_count ?? 0;
        attempt.lastHeartbeatAt = d.last_heartbeat_at ?? null;
      }
    }),
  );

  // Release any task still `blocked` whose entry gate has already been
  // approved. Orca records the gate resolution but does NOT flip the gated
  // task out of `blocked` — and an approval done through the viewer's
  // throwaway coordinator terminal (see `asCoordinator` in index.ts) closes
  // that terminal before the unblock side-effect can land on a live consumer,
  // so the task stays `blocked` and the loop below would otherwise see zero
  // `ready` tasks and stop on the first tick. As the bound consumer (alive
  // for the whole run) we nudge it to `ready` ourselves. `rejected` gates are
  // left `blocked` — turning those into `failed` is a caller's call, not ours.
  const blocked = tasks.filter((t) => t.status === "blocked");
  if (blocked.length > 0) {
    const gates = await listGates(runId);
    const approvedTaskIds = new Set(
      gates
        .filter((g) => g.taskId && g.status === "resolved" && g.resolution === "approved")
        .map((g) => g.taskId!),
    );
    const toRelease = blocked.filter((t) => approvedTaskIds.has(t.id));
    if (toRelease.length > 0) {
      await Promise.all(
        toRelease.map((t) => taskUpdate(t.id, "ready", runId, state.coordinatorHandle!)),
      );
      // re-read so this same tick dispatches the freshly-released tasks
      tasks = await listTasks(runId);
    }
  }

  const ready = tasks.filter((t) => t.status === "ready");
  const inFlight = tasks.filter((t) => t.status === "dispatched").length;

  // Nothing runnable and nothing in flight → the DAG is done (or stuck).
  if (ready.length === 0 && inFlight === 0 && state.attempts.size === 0) {
    await stopCoordinator(true);
    return;
  }

  const budget = Math.max(0, opts.maxConcurrency - state.attempts.size);
  const batch = ready.filter((t) => !state.attempts.has(t.id)).slice(0, budget);
  if (batch.length === 0) return;

  // Reserve every slot synchronously so a slow start can't let the next tick
  // over-dispatch, then start the batch in parallel.
  const reserved = batch.map((task) => {
    const harness = opts.harnessByTask[task.id] || opts.defaultHarness;
    const attempt: Attempt = {
      taskId: task.id,
      harness,
      mode: "supervised",
      dispatchId: null,
      handle: null,
      failureCount: 0,
      lastHeartbeatAt: null,
    };
    state.attempts.set(task.id, attempt);
    return { task, attempt };
  });

  await Promise.all(reserved.map(({ task, attempt }) => startOne(task, attempt, opts, runId)));
}

async function startOne(
  task: OrcaTask,
  attempt: Attempt,
  opts: StartOpts,
  runId: string,
): Promise<void> {
  const from = state.coordinatorHandle!;
  try {
    let started: StartedWorker;
    // opencode's TUI does not reliably accept `worker-start`'s injected
    // preamble (orca #9951) even though orca recognizes it as an agent — the
    // app opens with no prompt and never runs. Route it straight through the
    // legacy path, which runs `opencode run --auto` in a bare shell instead of
    // pasting into the TUI (verified 2026-08-10).
    if (attempt.harness === "opencode") {
      started = await startLegacyWorker({
        taskId: task.id,
        harness: attempt.harness,
        runId,
        from,
        worktree: opts.worktree,
      });
    } else {
      try {
        started = await startSupervisedWorker({
          taskId: task.id,
          agent: attempt.harness,
          runId,
          from,
          worktree: "current",
        });
      } catch (err) {
        // A harness Orca doesn't know as a configured TUI agent (or a custom
        // command) can't go through worker-start — compose it by hand instead.
        const code = (err as OrcaCliError).code;
        if (!code || !UNCONFIGURED_AGENT_CODES.has(code)) throw err;
        started = await startLegacyWorker({
          taskId: task.id,
          harness: attempt.harness,
          runId,
          from,
          worktree: opts.worktree,
        });
      }
    }
    attempt.mode = started.mode;
    attempt.dispatchId = started.dispatchId;
    attempt.handle = started.handle;
  } catch (err) {
    // Free the slot so the next tick can retry; Orca circuit-breaks the task
    // itself after 3 consecutive attempt failures.
    state.attempts.delete(task.id);
    state.error = `任务 ${task.id} 启动失败：${String((err as Error).message ?? err)}`;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
