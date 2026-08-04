import type { DagResponse, OrcaRun, RunStatus, ViewerConfig } from "./types";

/** An /api error that carries Orca's machine-readable error code. */
export class ApiError extends Error {
  readonly code: string | null;
  constructor(message: string, code: string | null = null) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}

async function post<T = unknown>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ApiError(
      String(json.error ?? `HTTP ${res.status}`),
      typeof json.code === "string" ? json.code : null,
    );
  }
  return json as T;
}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ApiError(
      String(json.error ?? `HTTP ${res.status}`),
      typeof json.code === "string" ? json.code : null,
    );
  }
  return json as T;
}

/** Runs available to view. Tasks are Run-scoped since Orca 1.4.160. */
export async function fetchRuns(): Promise<OrcaRun[]> {
  const { runs } = await get<{ runs: OrcaRun[] }>("/api/runs");
  return runs ?? [];
}

export async function createRun(objective: string): Promise<OrcaRun> {
  const { run } = await post<{ run: OrcaRun }>("/api/runs", { objective });
  return run;
}

/** The DAG of one Run. */
export async function fetchDag(runId: string): Promise<DagResponse> {
  return get<DagResponse>(`/api/dag?run=${encodeURIComponent(runId)}`);
}

export async function fetchRunStatus(): Promise<RunStatus> {
  return get<RunStatus>("/api/run-status");
}

/**
 * Start the self-driven coordinator on `runId`. It binds an Orca terminal as
 * the Run's coordinator — fencing any agent terminal currently coordinating it.
 */
export async function startRun(
  runId: string,
  harnessByTask: Record<string, string>,
  defaultHarness: string,
  maxConcurrency: number,
): Promise<RunStatus> {
  return post(`/api/run`, { runId, harnessByTask, defaultHarness, maxConcurrency });
}

export async function stopRun(): Promise<void> {
  await post(`/api/run-stop`);
}

export async function resolveGate(id: string, resolution: string, runId: string): Promise<void> {
  await post(`/api/gates/${encodeURIComponent(id)}/resolve`, { resolution, runId });
}

/**
 * Clear tasks. `orca orchestration reset` has no `--run` scope: it wipes every
 * Run's tasks in the local orchestration database, so the caller must opt in.
 */
export async function resetTasks(): Promise<void> {
  await post("/api/reset", { confirmAllRuns: true });
}

/** Load the persisted viewer config (harness choices, concurrency, layout, Run). */
export async function fetchConfig(): Promise<Partial<ViewerConfig>> {
  return get<Partial<ViewerConfig>>("/api/config");
}

/** Merge a patch into the persisted viewer config. */
export async function saveConfig(patch: Partial<ViewerConfig>): Promise<void> {
  const res = await fetch("/api/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new ApiError(`HTTP ${res.status}`);
}
