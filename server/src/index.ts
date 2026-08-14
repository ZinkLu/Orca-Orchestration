import express from "express";
import cors from "cors";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join } from "node:path";
import {
  OrcaCliError,
  bindRun,
  closeTerminal,
  createRun,
  createTempCoordinatorTerminal,
  listGates,
  listModels,
  listRuns,
  listTasks,
  listTerminals,
  resolveGate,
  runOrca,
  tasksToDag,
} from "./orca";
import { loadConfig, saveConfig } from "./config";
import { coordinatorStatus, startCoordinator, stopCoordinator } from "./coordinator";
import { loadEmbeddedAssets } from "./webAssets";
import { describeSkillInstall, installSkill } from "./skill";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 8787);
// Directory used to resolve the `active` worktree for the coordinator terminal.
const WORKSPACE_DIR = process.env.WORKSPACE_DIR ?? process.cwd();
const WORKTREE = process.env.ORCA_WORKTREE ?? "active";

// --- Subcommands ----------------------------------------------------------
// Handled before anything else so `uninstall` and `--help` never bind a port,
// create an Orca terminal, or install the skill on their way out.
const argv = process.argv.slice(2);

if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`orca-dag — visualize and run an Orca orchestration task DAG

Usage:
  orca-dag                 install the orca-dag skill into your agents, then serve the viewer
  orca-dag uninstall       remove the skill and close leftover Orca terminals
  orca-dag --help          show this

Options:
  --no-skill               don't touch the agent skill directories on startup
  --purge                  (uninstall) also delete this workspace's .orca-dag.config.json
  --dry-run                (uninstall) report what would be removed, change nothing

Environment:
  PORT=8787                port to serve on
  NO_OPEN=1                don't open a browser tab
  ORCA_DAG_NO_SKILL=1      same as --no-skill
  WORKSPACE_DIR=<path>     workspace to use instead of the current directory
  ORCA_WORKTREE=active     Orca worktree selector for the coordinator terminal`);
  process.exit(0);
}

if (argv.includes("uninstall")) {
  const { runUninstall } = await import("./uninstall");
  await runUninstall({
    dryRun: argv.includes("--dry-run"),
    purge: argv.includes("--purge"),
    workspace: WORKSPACE_DIR,
  });
  process.exit(0);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

/** Turn an Orca CLI failure into a response the UI can explain to the user. */
function fail(res: express.Response, err: unknown): void {
  const e = err as OrcaCliError;
  const code = e?.code ?? null;
  const status = code === "run_required" || code === "run_not_found" ? 409 : 500;
  // Orca hands back the exact unblocking command for some refusals — most
  // usefully `run-use --takeover-legacy` for a Run adopted by the 1.4.160
  // migration, which plain `run-use` refuses while it still has live work.
  const recovery = e?.recoveryCommand ?? null;
  const message = recovery ? `${e.message}\n\nUnblock with: ${recovery}` : String(e?.message ?? err);
  res.status(status).json({ error: message, code, recoveryCommand: recovery });
}

/**
 * Run a mutating orchestration call as the bound coordinator.
 *
 * Mutations (`gate-resolve`, `dispatch`, `worker-start`, …) are rejected unless
 * the caller is the live Orca terminal currently bound to the Run, so we borrow
 * one. If the coordinator loop is already running we reuse its terminal;
 * otherwise we create one, bind, act, and close it again so we don't sit on the
 * Run's coordinator slot (which would keep the user's agent fenced).
 */
async function asCoordinator<T>(runId: string, fn: (from: string) => Promise<T>): Promise<T> {
  const live = coordinatorStatus();
  if (live.running && live.coordinatorHandle && live.runId === runId) {
    return fn(live.coordinatorHandle);
  }
  // NEVER reuse the loop's terminal here: rebinding it to another Run would
  // fence the running coordinator, and the finally below would then close its
  // terminal. A throwaway uniquely-titled terminal keeps the paths independent.
  const handle = await createTempCoordinatorTerminal(WORKTREE);
  try {
    await bindRun(runId, handle);
    return await fn(handle);
  } finally {
    await closeTerminal(handle);
  }
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, workspace: WORKSPACE_DIR, worktree: WORKTREE });
});

/** Runs available to view. Tasks are Run-scoped since Orca 1.4.160. */
app.get("/api/runs", async (_req, res) => {
  try {
    res.json({ runs: await listRuns() });
  } catch (err) {
    fail(res, err);
  }
});

/** Create a new Run (and bind it just long enough to create it). */
app.post("/api/runs", async (req, res) => {
  const objective = String(req.body?.objective ?? "").trim();
  if (!objective) {
    res.status(400).json({ error: "objective required" });
    return;
  }
  try {
    // Throwaway terminal — see asCoordinator for why we never reuse the loop's.
    const handle = await createTempCoordinatorTerminal(WORKTREE);
    try {
      res.json({ run: await createRun(objective, handle) });
    } finally {
      await closeTerminal(handle);
    }
  } catch (err) {
    fail(res, err);
  }
});

/**
 * The DAG of one Run. `?run=<id>` is required — an unscoped `task-list` fails
 * with `run_required` because this process is not a bound coordinator.
 */
app.get("/api/dag", async (req, res) => {
  const runId = String(req.query.run ?? "").trim();
  if (!runId) {
    res.status(400).json({ error: "run query parameter required", code: "run_required" });
    return;
  }
  try {
    const [tasks, gates] = await Promise.all([listTasks(runId), listGates(runId)]);
    const { nodes, edges } = tasksToDag(tasks);
    res.json({ runId, nodes, edges, gates, generatedAt: Date.now() });
  } catch (err) {
    fail(res, err);
  }
});

/** Live terminals (running agent/shell sessions). */
app.get("/api/terminals", async (_req, res) => {
  try {
    res.json({ terminals: await listTerminals() });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * Start the self-driven coordinator on one Run. It binds a coordinator terminal
 * (fencing any agent currently coordinating that Run) and then dispatches every
 * ready task in parallel until the DAG settles.
 */
app.post("/api/run", async (req, res) => {
  const runId = String(req.body?.runId ?? "").trim();
  if (!runId) {
    res.status(400).json({ error: "runId required", code: "run_required" });
    return;
  }
  const harnessByTask = (req.body?.harnessByTask ?? {}) as Record<string, string>;
  const modelByTask = (req.body?.modelByTask ?? {}) as Record<string, string>;
  const defaultHarness = String(req.body?.defaultHarness ?? "claude").trim() || "claude";
  const maxConcurrency = Math.max(1, Math.min(16, Number(req.body?.maxConcurrency) || 4));
  try {
    await startCoordinator({
      runId,
      harnessByTask,
      modelByTask,
      defaultHarness,
      maxConcurrency,
      worktree: WORKTREE,
    });
    res.json({ ok: true, ...coordinatorStatus() });
  } catch (err) {
    fail(res, err);
  }
});

/** Stop the coordinator, tear down its workers, and release the Run. */
app.post("/api/run-stop", async (_req, res) => {
  try {
    await stopCoordinator(true);
    res.json({ ok: true });
  } catch (err) {
    fail(res, err);
  }
});

/** Live coordinator status (running, bound Run, in-flight attempts). */
app.get("/api/run-status", (_req, res) => {
  res.json(coordinatorStatus());
});

/** Resolve a decision gate (human approval) — a Run-scoped mutation. */
app.post("/api/gates/:id/resolve", async (req, res) => {
  const resolution = String(req.body?.resolution ?? "").trim();
  const runId = String(req.body?.runId ?? "").trim();
  if (!resolution || !runId) {
    res.status(400).json({ error: "resolution and runId required" });
    return;
  }
  try {
    await asCoordinator(runId, (from) => resolveGate(req.params.id, resolution, from));
    res.json({ ok: true });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * Clear orchestration tasks.
 *
 * `orchestration reset` has NO `--run` flag: it wipes the whole local
 * orchestration database, every Run at once. That used to be "clear my graph"
 * back when tasks were global; it is now a much bigger hammer, so the caller
 * has to say so explicitly.
 */
app.post("/api/reset", async (req, res) => {
  if (req.body?.confirmAllRuns !== true) {
    res.status(400).json({
      error:
        "orca orchestration reset clears tasks in ALL local Runs — it has no --run scope. " +
        "Retry with confirmAllRuns: true to confirm.",
      code: "confirm_required",
    });
    return;
  }
  try {
    await runOrca(["orchestration", "reset", "--tasks"]);
    res.json({ ok: true });
  } catch (err) {
    fail(res, err);
  }
});

/** Viewer config (harness choices, concurrency, layout, last Run). */
app.get("/api/config", async (_req, res) => {
  res.json(await loadConfig(WORKSPACE_DIR));
});

app.put("/api/config", async (req, res) => {
  try {
    res.json(await saveConfig(WORKSPACE_DIR, req.body ?? {}));
  } catch (err) {
    fail(res, err);
  }
});

/**
 * Models available for a harness, for the node model picker.
 *
 * Only opencode actually has an enumerable list (`opencode models`). claude/
 * codex/cursor return an empty array here — their models have no programmatic
 * source, so the UI offers free-text input for them instead.
 */
app.get("/api/models/:harness", async (req, res) => {
  const harness = String(req.params.harness ?? "").trim().toLowerCase();
  try {
    res.json({ harness, models: await listModels(harness) });
  } catch (err) {
    fail(res, err);
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

// `orca-dag` is meant to be the single command that makes the whole project
// work, so starting the viewer also puts the DAG-building skill in front of
// whatever agents this machine has. Best-effort and idempotent — see skill.ts.
const skillReport = describeSkillInstall(
  await installSkill(__dirname, !argv.includes("--no-skill") && process.env.ORCA_DAG_NO_SKILL !== "1"),
);

app.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  if (skillReport) console.log(skillReport);
  console.log(`Orca DAG viewer → ${url}`);
  console.log(`Workspace dir: ${WORKSPACE_DIR} (worktree: ${WORKTREE})`);
  if (servingUI && process.env.NO_OPEN !== "1") void openBrowser(url);
});

/**
 * Open the viewer URL. Prefers an Orca built-in browser tab (`orca tab create`)
 * so the DAG lives inside the Orca window next to the terminals/workers it
 * drives; falls back to the OS default browser when Orca isn't reachable (dev
 * from a non-worktree dir, Orca not yet open, tab creation refused). Best-effort:
 * never throws — the URL is already logged above.
 */
async function openBrowser(url: string): Promise<void> {
  // `tab create` resolves the current worktree from cwd, so it works wherever
  // the viewer runs inside an Orca-managed project. Fails fast if the runtime
  // isn't up — then we drop to the system browser below.
  try {
    const created = await runOrca<{ browserPageId?: string }>(["tab", "create", "--url", url]);
    // `tab create` makes the new tab the active one, but does NOT raise the
    // Orca window to the foreground. `tab switch --focus` reveals the window
    // (and the tab), so the DAG shows up in front instead of behind something.
    const pageId = created?.browserPageId;
    if (pageId) {
      try {
        await runOrca(["tab", "switch", "--page", pageId, "--focus"]);
      } catch {
        // Tab is created and active; only the window-raise failed — leave it.
      }
    }
    return;
  } catch {
    // Orca not running / not a worktree / tab refused — fall through.
  }
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // headless / no browser — the URL is already printed above
  }
}
