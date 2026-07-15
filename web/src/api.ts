import type { DagResponse, TaskStatus, Terminal } from "./types";

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

export async function fetchTerminals(): Promise<Terminal[]> {
  const res = await fetch("/api/terminals");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return ((await res.json()) as { terminals: Terminal[] }).terminals ?? [];
}

/** Fire a task on a harness with the (possibly edited) prompt. */
export async function fireTask(
  taskId: string,
  harness: string,
  prompt: string,
): Promise<{ handle: string; worktreeId: string }> {
  return post(`/api/fire`, { taskId, harness, prompt });
}

/** Dispatch a task to an already-running terminal (coordinator-wired). */
export async function dispatchTask(taskId: string, handle: string): Promise<void> {
  await post(`/api/dispatch`, { taskId, handle });
}

export async function setTaskStatus(taskId: string, status: TaskStatus): Promise<void> {
  await post(`/api/tasks/${encodeURIComponent(taskId)}/status`, { status });
}

export async function resolveGate(id: string, resolution: string): Promise<void> {
  await post(`/api/gates/${encodeURIComponent(id)}/resolve`, { resolution });
}

export async function resetTasks(): Promise<void> {
  await post("/api/reset");
}
