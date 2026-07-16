import type { DagResponse, RunStatus } from "./types";

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

export async function fetchDag(): Promise<DagResponse> {
  const res = await fetch("/api/dag");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as DagResponse;
}

export async function fetchRunStatus(): Promise<RunStatus> {
  const res = await fetch("/api/run-status");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as RunStatus;
}

/** Start the self-driven coordinator: it dispatches ready tasks in parallel. */
export async function startRun(
  harnessByTask: Record<string, string>,
  defaultHarness: string,
  maxConcurrency: number,
): Promise<RunStatus> {
  return post(`/api/run`, { harnessByTask, defaultHarness, maxConcurrency });
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
