import type { DagResponse, Terminal } from "./types";

async function post<T = unknown>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(json.error ?? `HTTP ${res.status}`));
  return json as T;
}

export async function fetchHealth(): Promise<{ workspace: string }> {
  const res = await fetch("/api/health");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as { workspace: string };
}

export async function fetchDag(): Promise<DagResponse> {
  const res = await fetch("/api/dag");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as DagResponse;
}

export async function fetchTerminals(): Promise<Terminal[]> {
  const res = await fetch("/api/terminals");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return ((await res.json()) as { terminals: Terminal[] }).terminals ?? [];
}

/** Spawn a worker agent terminal running `harness` (claude/kimi/opencode/...). */
export async function createWorker(harness: string): Promise<{ handle: string; worktreeId: string }> {
  return post(`/api/worker`, { harness });
}

/** Start the coordinator so Orca auto-executes the DAG. */
export async function startRun(spec?: string): Promise<{ runId: string; status: string }> {
  return post(`/api/run`, spec ? { spec } : {});
}

export async function stopRun(): Promise<void> {
  await post(`/api/run-stop`);
}

export async function resolveGate(id: string, resolution: string): Promise<void> {
  await post(`/api/gates/${encodeURIComponent(id)}/resolve`, { resolution });
}

export async function resetTasks(): Promise<void> {
  await post("/api/reset");
}
