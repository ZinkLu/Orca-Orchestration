// Viewer configuration store: per-node harness, default harness, concurrency
// cap, and layout choice. Persisted server-side in `.orca-dag.config.json`
// (workspace root) via /api/config — Orca's task has no harness/metadata
// field, and browser localStorage was lost on browser/profile changes.
// Legacy localStorage keys are read once as a migration source and mirrored
// on every write (harmless fallback when running against an older backend).

import { useSyncExternalStore } from "react";
import { fetchConfig, saveConfig } from "./api";
import type { LayoutKind, ViewerConfig } from "./types";

const NODE_PREFIX = "orca-dag:harness:";
const DEFAULT_KEY = "orca-dag:default-harness";
const LAYOUT_KEY = "orca-dag:layout";
const RUN_KEY = "orca-dag:run-id";

const DEFAULTS: ViewerConfig = {
  defaultHarness: "claude",
  harnessByTask: {},
  maxConcurrency: 4,
  layout: "",
  runId: "",
};

let config: ViewerConfig = { ...DEFAULTS };
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function getSnapshot(): ViewerConfig {
  return config;
}

/** Reactive access to the whole config (re-renders on load and on change). */
export function useConfig(): ViewerConfig {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/**
 * Hydrate the store from the server once at startup. Missing fields fall back
 * to legacy localStorage values; the merged result is written back so the
 * migration completes in one shot.
 */
export async function initConfig(): Promise<void> {
  let server: Partial<ViewerConfig> = {};
  try {
    server = await fetchConfig();
  } catch {
    // backend unreachable — stay on defaults / localStorage mirror
  }
  config = {
    defaultHarness:
      asString(server.defaultHarness) || localStorage.getItem(DEFAULT_KEY) || DEFAULTS.defaultHarness,
    harnessByTask: asHarnessMap(server.harnessByTask) ?? readLegacyNodeHarnesses(),
    maxConcurrency: asConcurrency(server.maxConcurrency) ?? DEFAULTS.maxConcurrency,
    layout: asLayout(server.layout) || asLayout(localStorage.getItem(LAYOUT_KEY)) || "",
    runId: asString(server.runId) || localStorage.getItem(RUN_KEY) || "",
  };
  emit();
  persist();
}

function update(patch: Partial<ViewerConfig>): void {
  config = { ...config, ...patch };
  mirrorToLocalStorage();
  emit();
  persist();
}

let persistTimer: number | null = null;
/** Debounced write-through to the server-side config file. */
function persist(): void {
  if (persistTimer !== null) window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    saveConfig(config).catch(() => {
      /* keep the in-memory state; next change retries */
    });
  }, 250);
}

function mirrorToLocalStorage(): void {
  try {
    localStorage.setItem(DEFAULT_KEY, config.defaultHarness);
    if (config.layout) localStorage.setItem(LAYOUT_KEY, config.layout);
    if (config.runId) localStorage.setItem(RUN_KEY, config.runId);
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(NODE_PREFIX)) localStorage.removeItem(key);
    }
    for (const [id, h] of Object.entries(config.harnessByTask)) {
      localStorage.setItem(NODE_PREFIX + id, h);
    }
  } catch {
    /* private mode etc. — the server file is the source of truth anyway */
  }
}

function readLegacyNodeHarnesses(): Record<string, string> {
  const map: Record<string, string> = {};
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(NODE_PREFIX)) continue;
      const v = localStorage.getItem(key);
      if (v) map[key.slice(NODE_PREFIX.length)] = v;
    }
  } catch {
    /* ignore */
  }
  return map;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
function asHarnessMap(v: unknown): Record<string, string> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const map: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string" && val.trim()) map[k] = val.trim();
  }
  return map;
}
function asConcurrency(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(1, Math.min(16, Math.round(v))) : null;
}
function asLayout(v: unknown): LayoutKind | "" {
  return v === "layered-lr" || v === "layered-tb" || v === "force" ? v : "";
}

// --- field accessors (kept compatible with the old localStorage API) -------

export function getNodeHarness(taskId: string): string | null {
  return config.harnessByTask[taskId] ?? null;
}

export function setNodeHarness(taskId: string, harness: string | null): void {
  const harnessByTask = { ...config.harnessByTask };
  if (harness) harnessByTask[taskId] = harness;
  else delete harnessByTask[taskId];
  update({ harnessByTask });
}

export function getDefaultHarness(): string {
  return config.defaultHarness;
}

export function setDefaultHarness(harness: string): void {
  update({ defaultHarness: harness });
}

export function getMaxConcurrency(): number {
  return config.maxConcurrency;
}

export function setMaxConcurrency(n: number): void {
  update({ maxConcurrency: Math.max(1, Math.min(16, Math.round(n) || 1)) });
}

export function getLayout(): LayoutKind | "" {
  return config.layout;
}

export function setLayout(layout: LayoutKind): void {
  update({ layout });
}

/** The Run whose DAG the viewer is showing. Empty until one is chosen. */
export function getRunId(): string {
  return config.runId;
}

export function setRunId(runId: string): void {
  update({ runId });
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
