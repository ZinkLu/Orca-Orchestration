import { closeTerminal, dispatchTask, listTasks, spawnWorker } from "./orca";

/**
 * Self-driven coordinator.
 *
 * `orca orchestration run` does not actually dispatch (verified), so the viewer
 * IS the coordinator: a loop that polls the DAG, dispatches every `ready` task
 * to a worker of that task's chosen harness, and advances as workers report
 * `worker_done`. Parallelism is driven by the DAG — all currently-ready tasks
 * run at once, up to `maxConcurrency` — not by a manual worker count.
 *
 * Workers are reused: an idle worker of the right harness takes the next task;
 * otherwise a new one is spawned. When the run ends, spawned workers are closed.
 */

interface Worker {
  handle: string;
  harness: string;
  taskId: string | null; // the task currently assigned to this worker, if any
}

interface StartOpts {
  harnessByTask: Record<string, string>;
  defaultHarness: string;
  maxConcurrency: number;
}

interface State {
  running: boolean;
  opts: StartOpts | null;
  workers: Worker[];
  startedAt: number;
  error: string | null;
  lastTick: number;
}

const POLL_MS = 3500;
const TERMINAL = new Set(["completed", "failed"]);

const state: State = {
  running: false,
  opts: null,
  workers: [],
  startedAt: 0,
  error: null,
  lastTick: 0,
};

export function coordinatorStatus() {
  return {
    running: state.running,
    error: state.error,
    startedAt: state.startedAt,
    workers: state.workers.map((w) => ({ handle: w.handle, harness: w.harness, taskId: w.taskId })),
    busy: state.workers.filter((w) => w.taskId).length,
  };
}

export function startCoordinator(opts: StartOpts): void {
  if (state.running) return;
  state.running = true;
  state.opts = opts;
  state.workers = [];
  state.error = null;
  state.startedAt = Date.now();
  void loop();
}

export async function stopCoordinator(closeWorkers = true): Promise<void> {
  state.running = false;
  const workers = state.workers.slice();
  state.workers = [];
  if (closeWorkers) {
    await Promise.all(workers.map((w) => closeTerminal(w.handle)));
  }
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
  const tasks = await listTasks();
  const byId = new Map(tasks.map((t) => [t.id, t]));
  state.lastTick = Date.now();

  // Free workers whose assigned task has reached a terminal state.
  for (const w of state.workers) {
    if (w.taskId) {
      const t = byId.get(w.taskId);
      if (!t || TERMINAL.has(t.status)) w.taskId = null;
    }
  }

  // Nothing runnable and nothing in flight → the DAG is done (or stuck). Stop.
  const inFlight = tasks.filter((t) => t.status === "dispatched").length;
  const ready = tasks.filter((t) => t.status === "ready");
  if (ready.length === 0 && inFlight === 0) {
    await stopCoordinator(true);
    return;
  }

  // Dispatch ready tasks in parallel, up to the concurrency budget.
  const budget = Math.max(0, opts.maxConcurrency - state.workers.filter((w) => w.taskId).length);
  for (const t of ready.slice(0, budget)) {
    const harness = opts.harnessByTask[t.id] || opts.defaultHarness;
    let worker = state.workers.find((w) => w.harness === harness && !w.taskId);
    if (!worker) {
      // Spawn on demand. Reserve a slot synchronously so we don't over-spawn.
      worker = { handle: "", harness, taskId: t.id };
      state.workers.push(worker);
      try {
        worker.handle = await spawnWorker(harness);
      } catch (e) {
        // spawn failed — drop this reservation and surface the error
        state.workers = state.workers.filter((w) => w !== worker);
        state.error = String((e as Error).message ?? e);
        continue;
      }
    } else {
      worker.taskId = t.id;
    }
    try {
      await dispatchTask(t.id, worker.handle);
    } catch (e) {
      worker.taskId = null;
      state.error = String((e as Error).message ?? e);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
