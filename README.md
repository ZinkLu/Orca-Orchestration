# Orca DAG — skill + viewer

English | [简体中文](README_zh.md)

Split "planning by chatting with an agent" from "visualizing + executing" into two independent modules:

1. **skill** (`skill/SKILL.md`): teaches **your own agent** (Claude Code / kimi / …) how to break a requirement down into an **Orca orchestration task DAG**, plus the graph-building conventions. The planning "brain" stays in your agent — **no embedded Claude Agent SDK**.
2. **viewer** (`server/` + `web/`, compiled into the portable `orca-dag` binary): connects to Orca's orchestration state and **visualizes the DAG live**; each node **picks its own harness** (claude / kimi / opencode / grok …) and optionally a **model**; click **"▶ Run with Orca"** and the viewer's built-in **self-driven coordinator** dispatches ready tasks **in parallel** along the dependencies to autonomous workers spun up on demand, until the whole graph is done.

> Core flow: **agent builds the graph → pick a Run and per-node harnesses in the viewer → Run → the DAG executes in dependency-parallel**. To change a task or a dependency, have the agent redraw the DAG — Orca has no interface for editing a single task.
>
> ⚠️ **Requires Orca ≥ 1.4.160.** That release (2026-07-29, PR #9925) rewrote the whole orchestration contract; this project targets it and **no longer supports older Orca**.
>
> ⚠️ Why the viewer still acts as its own coordinator: not because `orca orchestration run` is buggy — that command (along with `coordinator-start`) has been **officially retired** (calling it has no side effects; it just says "go read the skill"). Orca **deliberately ships no scheduler** — the official skill's words: *"Agents still choose placement and concurrency; Orca does not schedule workers."* So the DAG loop belongs to the viewer, but **every step** inside that loop now uses Orca's own Run / Task / Dispatch primitives.

![Crayon-style viewer: full-width DAG, default-harness/max-parallel/Run toolbar, and a read-only node panel with per-node harness and model pickers](docs/screenshot.png)

## How it works

```
   your agent (loads the orca-dag skill)          orca-dag viewer (portable binary)
 ┌───────────────────────────────┐             ┌──────────────────────────────┐
 │  chat → decompose → build DAG │             │  poll task-list → draw DAG   │
 │  Bash: orca orchestration     │             │  pick harness per node       │
 │        task-create / gate-*   │             │  ▶ Run → self-driven         │
 └───────────────┬───────────────┘             └───────────────┬──────────────┘
                 │  writes orchestration state                 │  poll + worker-start (parallel)
                 ▼                                             ▼
        ┌────────────────────  Orca orchestration state  ────────────────────┐
        │  tasks / deps / gates  ·  on-demand autonomous workers (per-node   │
        │                           harness)                                 │
        └─────────────────────────────────────────────────────────────────────┘
```

1. You chat in **your own agent**. It loads the `orca-dag` skill, opens a **Run** with `orca orchestration run-create`, then builds the tasks and dependencies into that Run via `task-create --deps …`.
2. Open the viewer (`orca-dag`). Pick the Run in the top bar; it polls `orca orchestration task-list --run <id> --json` every 2 seconds, lays out with **dagre**, renders with **React Flow**, and recolors statuses live.
3. In the viewer, pick a harness per node (or rely on a default fallback), set "Max parallel", and click **"▶ Run with Orca"**.
4. The viewer's **coordinator loop** takes over: it binds one of its own Orca terminals as the Run's coordinator (gaining mutation authority), then on each tick finds every `ready` task and calls `orca orchestration worker-start --task <id> --agent <harness>` **in parallel** — **Orca itself** creates the worker terminal, waits for readiness, injects the dispatch, and returns a **Dispatch** (one attempt). The worker finishes with `worker_done --outcome` → Orca **automatically** marks the task and dispatch completed/failed → dependents flip to `ready` → repeat until the graph is done, then `worker-stop` reclaims the workers.
5. To change the plan: go back to the agent conversation and have it redraw the DAG.

### The Run / Task / Dispatch layers

| Layer | What it is | Owned by |
|---|---|---|
| **Run** | Namespace + coordinator inbox; only one coordinator is bound at a time (`consumer_generation` does the fencing) | Orca |
| **Task** | A unit of work; `deps` define the DAG edges, `run_id` scopes it to a Run | Orca |
| **Dispatch** | **One attempt** (id shaped like `ctx_*`); carries `failure_count` (circuit-breaks at 3), heartbeats, pane identity, capability credentials. A retry mints a new Dispatch | Orca |
| Per-node harness & model, canvas positions, default harness, max parallel, current Run | The viewer's own preferences | `.orca-dag.config.json` |

A Run is a namespace, **not a DAG** — several unrelated graphs can live in one Run. "One Run = one DAG" is a convention from `skill/SKILL.md`, not an Orca constraint.

### The authority model (why the viewer occupies a terminal)

Every Orca orchestration call goes through `resolveRunScope`:

- **Reads** (`task-list` / `gate-list`) skip the consumer check as long as they pass `--run <id>` — **any process can read**. That's all the viewer's polling needs.
- **Mutations** (`dispatch` / `gate-resolve` / `task-create` / `worker-start`) require the caller to **be the Orca terminal currently bound to that Run**, proven by resolving `--from <handle>` to a pane.

The viewer is an ordinary process with no terminal identity, so every mutation would fail with `run_required`. The fix: the viewer opens its own Orca terminal titled `orca-dag coordinator`, binds it with `run-use`, and passes `--from` on every mutation. **Binding fences the previous coordinator** (usually the agent terminal that drew your graph), so the viewer asks for explicit confirmation before starting; the agent can reclaim the Run anytime with `orca orchestration run-use --id <run>`. On stop, the viewer closes that terminal and releases the Run.

## Prerequisites

- **Orca ≥ 1.4.160** (`result.runtime.appVersion` in `orca status --json`). The Run/Dispatch contract landed in 1.4.160; older versions lack `run-create` / `worker-start` and the viewer cannot run.
- **The orchestration experimental feature is enabled**: Settings → Experimental.
- **Orca is running**: `result.runtime.state` in `orca status --json` should be `"ready"`; otherwise run `orca open` first.
- **The project is an Orca-managed worktree**: adding workers / executing requires the current directory to be a registered repo/worktree (else `orca terminal create` fails with `selector_not_found`). Register with `orca repo add <path>` or `orca worktree …`.
- **An agent that can run the skill** (graph-building side): Claude Code, or anything that can read `SKILL.md` and run Bash.
- **The viewer side depends only on the `orca` CLI** — no `claude`, no `ANTHROPIC_API_KEY`.
- **Bun** (optional, only to build the binary). **Node.js ≥ 20** (for dev / `npm start`).

## Module 1 · Install the skill

```bash
ln -s "$PWD/skill" ~/.claude/skills/orca-dag      # or copy it into your agent's skills directory
```

Then chat through your requirement in the agent. It builds the DAG into Orca per `SKILL.md` and tells you to run `orca-dag` to open the viewer.

## Module 2 · Run the viewer

Development (frontend :5173 + backend :8787, vite proxies /api):

```bash
npm install
npm run dev            # open http://localhost:5173
```

Build the portable binary (recommended — callable from any Orca-managed project directory):

```bash
npm run build:binary                 # produces dist/orca-dag (~60 MB, frontend embedded)
cp dist/orca-dag /usr/local/bin/     # put it on PATH

cd ~/any/orca-managed/project
orca-dag                             # serves http://localhost:8787, opens the browser; uses the cwd as workspace
```

Cross-compile (the target machine only needs `orca`): `TARGET=bun-linux-x64 npm run build:binary`.
Switches: `PORT` (default 8787), `NO_OPEN=1` (don't open the browser), `WORKSPACE_DIR` (overrides the `active` worktree).

## Quick start

An end-to-end pass, assuming the skill is installed and `orca-dag` is on PATH (modules 1 & 2 above):

1. **Get your project under Orca** (once per repo) and make sure Orca is up:

   ```bash
   cd ~/code/my-project
   orca repo add .        # skip if already Orca-managed
   orca status --json     # runtime.state should be "ready"; otherwise `orca open`
   ```

2. **Plan in your agent.** In Claude Code (or any agent with the skill), describe what you want and ask for a DAG:

   > Use the orca-dag skill: break "add CSV export to the reports page" into a task DAG.

   The agent will ask a few clarifying questions, write `docs/PRD.md` / `docs/TECH_SPEC.md`, then run `orca orchestration run-create` + `task-create --deps …`. When it's done it tells you the **Run id** (like `run_ab12cd34ef56`).

3. **Open the viewer** from the project directory:

   ```bash
   orca-dag               # serves :8787 and opens the browser
   ```

4. **Pick the Run** the agent just named in the top-bar dropdown. The DAG appears and refreshes every 2 seconds — you can keep chatting with the agent to reshape it and watch nodes pop in live.

5. **Choose harnesses.** Set the toolbar's **Default harness** (fallback for every node), and optionally click individual nodes to override harness/model per node. Set **Max parallel**.

6. **Click "▶ Run with Orca"** and accept the confirmation (it explains that the viewer takes over the Run's coordinator slot, fencing your agent's terminal — that's expected). Ready tasks fire in parallel; running nodes get the crayon scribble; the graph advances as workers report `worker_done`.

7. **Resolve gates when they pop.** If the plan includes approval gates, approve/reject buttons float over the DAG at the right moment.

8. **Change the plan?** Go back to the agent conversation. It reclaims the Run with `orca orchestration run-use --id <run>` (or just opens a fresh Run and redraws), and the viewer follows along. Then hit Run again.

## What the viewer can do

- **Live DAG visualization** — node statuses `pending / ready / dispatched / completed / failed / blocked` map to colors; each node wears its harness on its corner.
- **Switchable layout algorithms**: the "Layout" segment in the toolbar toggles **layered horizontal / vertical** (dagre / Sugiyama) and **force-directed** (Fruchterman–Reingold); **↻ Re-layout** reruns auto-layout (clearing manual drags). The choice persists.
- **Drag to arrange**: nodes drag freely and hold their positions across live polling refreshes (only untouched nodes follow auto-layout).
- **Execution animations**: `dispatched` (running) nodes get scribbled over and over with diagonal crayon strokes; edges flowing out of a running node start as a swimming dashed draft, then pencil strokes trace them solid toward the downstream node.
- **Per-node harness**: click a node and pick `claude / kimi / opencode / grok / codex` or a custom command in its panel (persisted to the workspace's `.orca-dag.config.json`); nodes without an explicit choice fall back to the toolbar's **default harness**.
- **Per-node model override**: for harnesses that support it — opencode gets a dropdown enumerated from `opencode models`; claude / codex / cursor get free-text (passed via `worker-start --model`). Others run on their default model.
- **▶ Run with Orca / ⏹ Stop** + **Max parallel**: start/stop the viewer's built-in self-driven coordinator; worker count follows the DAG's parallelism (whatever is ready runs together, capped by "Max parallel"), spun up on demand, reused while idle, reclaimed when done — **no manual worker management**. While running it shows "N workers".
- **Approval gates**: after the agent runs `gate-create`, approve/reject buttons float over the DAG.
- **Node details (read-only spec)**: click a node to see its spec / status / result. To change the spec or deps, have the agent redraw the DAG.
- **Hand-drawn crayon style**: 🖍️ SVG feTurbulence wobbled strokes on a cream sketchbook canvas.

## HTTP API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/dag?run=<id>` | The Run's DAG: `{ runId, nodes, edges, gates, generatedAt }` |
| `GET` | `/api/runs` | List orchestration Runs |
| `POST` | `/api/runs` | `{ objective }`: create a Run (via a throwaway coordinator terminal) |
| `GET` | `/api/terminals` | List Orca terminals |
| `POST` | `/api/run` | `{ runId, harnessByTask?, modelByTask?, defaultHarness?, maxConcurrency? }`: start the self-driven coordinator |
| `POST` | `/api/run-stop` | Stop the coordinator and reclaim its workers |
| `GET` | `/api/run-status` | Live coordinator status: `{ running, busy, attempts, error, … }` |
| `POST` | `/api/gates/:id/resolve` | `{ resolution, runId }`: resolve an approval gate |
| `POST` | `/api/reset` | `{ confirmAllRuns: true }`: `orca orchestration reset --tasks` — clears tasks in **all** Runs |
| `GET` | `/api/models/:harness` | Models selectable for a harness (currently only opencode enumerates) |
| `GET` | `/api/config` | Viewer config (harness/model choices, max parallel, layout, last Run), stored in the workspace's `.orca-dag.config.json` |
| `PUT` | `/api/config` | Merge-write the viewer config |
| `GET` | `/api/health` | Health check (returns the workspace directory) |

## Code layout

```
skill/SKILL.md            graph-building conventions + spec-writing rules + how execution works + boundaries
server/src/
  index.ts                Express: dag / runs / run / run-stop / run-status / gates / reset / models / config; serves the SPA
  coordinator.ts          self-driven coordinator loop: polls the DAG, fires ready tasks in parallel via worker-start
  orca.ts                 orca CLI wrapper: task-list→DAG, worker-start/legacy/opencode workers, gates, terminals, models
  config.ts               viewer config persistence: .orca-dag.config.json in the workspace (/api/config)
  webAssets.ts            loader for the frontend assets embedded at build time (production binary)
web/src/
  App.tsx                 full-width DAG shell, 2s polling, hand-drawn SVG filter defs
  components/DagView.tsx     React Flow graph + status nodes (harness label, crayon animations)
  components/ExecControls.tsx default harness + max parallel + Run/Stop + live status
  components/NodePanel.tsx    node details + per-node harness & model pickers
  components/GatePanel.tsx    approval-gate overlay
  components/RunPicker.tsx    Run selector + "New Run"
  components/DoodleSelect.tsx hand-drawn select (portal dropdown, search, keyboard nav)
  harness.ts                reactive config store: per-node harness/model, default, max parallel, layout (persisted via /api/config)
  layout.ts                 layout algorithms: dagre layered (LR/TB) + force-directed (Fruchterman–Reingold)
  types.ts / api.ts
scripts/build-binary.mjs  vite build → embed assets → bun --compile → dist/orca-dag
```

## Design notes and boundaries

- **The brain lives outside**: planning is done by the agent you already have (the skill provides the conventions); the viewer embeds no Claude Agent SDK.
- **The viewer is its own coordinator**: Orca deliberately ships no scheduler, so `server/src/coordinator.ts` drives the loop with Orca's Run/Task/Dispatch primitives. Parallelism follows the DAG (everything ready fires together, capped by `maxConcurrency`); workers are spun up on demand, reused while idle, reclaimed at the end.
- **Workers must be autonomous agents**: hands-off execution requires the worker to run `orca orchestration send --type worker_done` on its own — otherwise it stalls on a permission prompt. `worker-start` launches Orca-configured TUI agents with their autonomous flags; for custom commands the legacy path uses `HARNESS_LAUNCH` in `orca.ts` (only `claude --dangerously-skip-permissions` is verified — add and verify flags for others before relying on them).
- **The `dispatch --inject` quirk** (legacy path): it types the preamble into the agent's input box but often **doesn't submit it** (a readiness race). The coordinator waits ~2s after dispatch and sends an extra Enter; a stray Enter on already-submitted input is a harmless no-op.
- **opencode goes through its own path**: `worker-start --agent opencode` opens the TUI but the injected preamble never lands, so the coordinator opens a bare shell, mints a tracking dispatch, and runs `opencode run --auto "$(cat <preamble>)"` (`--auto` is mandatory — the default permission policy silently auto-rejects tool calls).
- **Per-node harness/model live in a workspace config file**: Orca tasks have no harness/metadata field (`task-create` only takes spec/title/display-name/deps/parent), so the viewer stores harness and model choices, max parallel, and layout in `.orca-dag.config.json` at the workspace root (`server/src/config.ts`, `GET/PUT /api/config`) — surviving browser switches and cleared localStorage. The frontend's `harness.ts` is a reactive store that hydrates from the server and migrates old localStorage values once. At Run time the choices are passed to the backend as `harnessByTask` / `modelByTask`.
- **Created tasks can't be edited**: `orca orchestration task-update` only changes `--status` / `--result` — **no interface to edit spec/title/deps**, and no single-task delete (`reset` clears everything, across all Runs). So "change a task" = **have the agent redraw the DAG in a fresh Run**.
