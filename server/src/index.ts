import express from "express";
import cors from "cors";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join } from "node:path";
import { runChatTurn } from "./claude";
import { listGates, listTasks, runOrca, tasksToDag } from "./orca";
import { loadEmbeddedAssets } from "./webAssets";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = Number(process.env.PORT ?? 8787);
// Directory Claude uses as its working dir when running orca / writing docs.
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

/** Streamed chat turn with Claude, emitting SSE frames (text / tool / done / error). */
app.post("/api/chat", async (req, res) => {
  const message = String(req.body?.message ?? "").trim();
  const sessionId = (req.body?.sessionId as string | null) ?? null;
  if (!message) {
    res.status(400).json({ error: "message required" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Detect a real client disconnect via the RESPONSE stream. `req.on("close")`
  // fires as soon as the POST body is consumed, which would abort immediately.
  const ac = new AbortController();
  let finished = false;
  res.on("close", () => {
    if (!finished) ac.abort();
  });

  await runChatTurn(message, sessionId, WORKSPACE_DIR, ac.signal, {
    onText: (delta) => send("text", { delta }),
    onTool: (tool) => send("tool", tool),
    onDone: (sid) => {
      finished = true;
      send("done", { sessionId: sid });
      res.end();
    },
    onError: (msg) => {
      finished = true;
      send("error", { message: msg });
      res.end();
    },
  });
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
  console.log(`Orca Orchestration Studio → ${url}`);
  console.log(`Workspace dir: ${WORKSPACE_DIR}`);
  // Only pop a browser when this process actually serves the UI (compiled
  // binary or `npm start`), never in dev where the UI lives on Vite's port.
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
