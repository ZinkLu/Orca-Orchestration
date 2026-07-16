// Per-node harness selection, stored in the browser (Orca's task has no harness
// field). Each task node can pick its own agent; nodes without an explicit
// choice fall back to the global default.

const NODE_PREFIX = "orca-dag:harness:";
const DEFAULT_KEY = "orca-dag:default-harness";

export function getNodeHarness(taskId: string): string | null {
  return localStorage.getItem(NODE_PREFIX + taskId);
}

export function setNodeHarness(taskId: string, harness: string | null): void {
  if (harness) localStorage.setItem(NODE_PREFIX + taskId, harness);
  else localStorage.removeItem(NODE_PREFIX + taskId);
}

export function getDefaultHarness(): string {
  return localStorage.getItem(DEFAULT_KEY) || "claude";
}

export function setDefaultHarness(harness: string): void {
  localStorage.setItem(DEFAULT_KEY, harness);
}

/** Effective harness for a node: its own override, else the global default. */
export function effectiveHarness(taskId: string): string {
  return getNodeHarness(taskId) || getDefaultHarness();
}

/** Map of {taskId: harness} for nodes with an explicit override (the rest use default). */
export function harnessMap(taskIds: string[]): Record<string, string> {
  const m: Record<string, string> = {};
  for (const id of taskIds) {
    const h = getNodeHarness(id);
    if (h) m[id] = h;
  }
  return m;
}
