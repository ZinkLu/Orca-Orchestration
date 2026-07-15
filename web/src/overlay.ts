// Per-task viewer-local state. Orca's CLI can't edit a task's stored spec
// (`task-update` only changes status/result), so a fine-tuned description lives
// here in the browser and is sent as the prompt at fire time.

const SPEC_PREFIX = "orca-dag:spec:";
const HARNESS_PREFIX = "orca-dag:harness:";

export function getSpecOverride(taskId: string): string | null {
  return localStorage.getItem(SPEC_PREFIX + taskId);
}

/** Store an edited spec, or clear it when it matches the original. */
export function setSpecOverride(taskId: string, edited: string, original: string): void {
  if (edited === original) localStorage.removeItem(SPEC_PREFIX + taskId);
  else localStorage.setItem(SPEC_PREFIX + taskId, edited);
}

/** The text to fire: the edit if present, else the stored spec. */
export function effectiveSpec(taskId: string, original: string): string {
  return getSpecOverride(taskId) ?? original;
}

export function isEdited(taskId: string, original: string): boolean {
  const o = getSpecOverride(taskId);
  return o !== null && o !== original;
}

export function getHarness(taskId: string, fallback: string): string {
  return localStorage.getItem(HARNESS_PREFIX + taskId) ?? fallback;
}

export function setHarness(taskId: string, harness: string): void {
  localStorage.setItem(HARNESS_PREFIX + taskId, harness);
}
