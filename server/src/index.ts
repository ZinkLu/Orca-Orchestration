import express from "express";
import cors from "cors";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join } from "node:path";
import { listGates, listTasks, listTerminals, runOrca, tasksToDag } from "./orca";
import { coordinatorStatus, startCoordinator, stopCoordinator } from "./coordinator";
import { loadEmbeddedAssets } from "./webAssets";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = Number(process.env.PORT ?? 8787);
// Directory used to resolve the `active` worktree for workers / the coordinator.
const WORKSPACE_DIR = process.env.WORKSPACE_DIR ?? process.cwd();

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, workspace: WORKSPACE_DIR });
});

/** Current orchestration DAG derived from the live orca task list. */
app.get("/api/dag", async (_req, res) => {
  try {
    const [tasks, gates] = await Promise.all([listTasks(), listGates()]);
    const { nodes, edges } = tasksToDag(tasks);
    res.json({ nodes, edges, gates, generatedAt: Date.now() });
  } catch (err) {
    res.status(500).json({ error: String((err as Error).message ?? err) });
  }
});

/** Live terminals (running agent/shell sessions) a task can be dispatched to. */
app.get("/api/terminals", async (_req, res) => {
  try {
    res.json({ terminals: await listTerminals() });
  } catch (err) {
    res.status(500).json({ error: String((err as Error).message ?? err) });
  }
});

/**
 * Start the self-driven coordinator. It dispatches ready tasks in parallel to
 * per-task harness workers until the DAG is done.
 * Body: { harnessByTask?: {taskId:harness}, defaultHarness?, maxConcurrency? }.
 */
app.post("/api/run", (req, res) => {
  const harnessByTask = (req.body?.harnessByTask ?? {}) as Record<string, string>;
  const defaultHarness = String(req.body?.defaultHarness ?? "claude").trim() || "claude";
  const maxConcurrency = Math.max(1, Math.min(16, Number(req.body?.maxConcurrency) || 4));
  startCoordinator({ harnessByTask, defaultHarness, maxConcurrency });
  res.json({ ok: true, ...coordinatorStatus() });
});

/** Stop the coordinator and tear down spawned workers. */
app.post("/api/run-stop", async (_req, res) => {
  try {
    await stopCoordinator(true);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String((err as Error).message ?? err) });
  }
});

/** Live coordinator status (running, active workers, per-worker task). */
app.get("/api/run-status", (_req, res) => {
  res.json(coordinatorStatus());
});

/** Resolve a decision gate (human approval). */
app.post("/api/gates/:id/resolve", async (req, res) => {
  const resolution = String(req.body?.resolution ?? "").trim();
  if (!resolution) {
    res.status(400).json({ error: "resolution required" });
    return;
  }
  try {
    await runOrca(["orchestration", "gate-resolve", "--id", req.params.id, "--resolution", resolution]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String((err as Error).message ?? err) });
  }
});

/** Clear all orchestration tasks. */
app.post("/api/reset", async (_req, res) => {
  try {
    await runOrca(["orchestration", "reset", "--tasks"]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String((err as Error).message ?? err) });
  }
});

// --- Serve the built SPA -------------------------------------------------
// Two sources, in priority order:
//   1. assets embedded at `bun build --compile` time  → portable single binary
//   2. a `web/dist` folder on disk                     → plain `npm run build && npm start`
// In `npm run dev` neither is used: Vite serves the UI on :5173 and proxies /api.
let servingUI = false;
const embedded = await loadEmbeddedAssets();
if (embedded.size > 0) {
  const indexHtml = embedded.get("index.html");
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api/")) return next();
    const key = req.path.replace(/^\/+/, "") || "index.html";
    // Exact asset, else fall back to index.html for SPA client routes.
    const hit = embedded.get(key) ?? (extname(key) ? undefined : indexHtml);
    if (!hit) return next();
    res.setHeader("Content-Type", hit.type);
    res.setHeader("Cache-Control", key === "index.html" ? "no-cache" : "public, max-age=31536000, immutable");
    res.end(hit.body);
  });
  servingUI = true;
} else {
  const distDir = join(__dirname, "..", "..", "web", "dist");
  if (existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get("*", (_req, res) => res.sendFile(join(distDir, "index.html")));
    servingUI = true;
  }
}

app.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Orca DAG viewer → ${url}`);
  console.log(`Workspace dir: ${WORKSPACE_DIR}`);
  if (servingUI && process.env.NO_OPEN !== "1") openBrowser(url);
});

/** Best-effort "open my default browser at this URL", per platform. Never throws. */
function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // headless / no browser — the URL is already printed above
  }
}
