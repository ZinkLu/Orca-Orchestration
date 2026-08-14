# Orca DAG — skill + viewer

English | [简体中文](README_zh.md)

Split "planning by chatting with an agent" from "visualizing + executing" into two independent modules:

1. **skill** (`skill/SKILL.md`): teaches **your own agent** (Claude Code / kimi / …) how to break a requirement down into an **Orca orchestration task DAG**, plus the graph-building conventions. The planning "brain" stays in your agent — **no embedded Claude Agent SDK**.
2. **viewer** (`server/` + `web/`, shipped as the `orca-dag` npm package and a standalone binary): connects to Orca's orchestration state and **visualizes the DAG live**; each node **picks its own harness** (claude / kimi / opencode / grok …) and optionally a **model**; click **"▶ Run with Orca"** and the viewer's built-in **self-driven coordinator** dispatches ready tasks **in parallel** along the dependencies to autonomous workers spun up on demand, until the whole graph is done.

> Core flow: **agent builds the graph → pick a Run and per-node harnesses in the viewer → Run → the DAG executes in dependency-parallel**. To change a task or a dependency, have the agent redraw the DAG — Orca has no interface for editing a single task.
>
> ⚠️ **Requires Orca ≥ 1.4.160.** That release (2026-07-29, PR #9925) rewrote the whole orchestration contract; this project targets it and **no longer supports older Orca**.
>
> ⚠️ Why the viewer still acts as its own coordinator: not because `orca orchestration run` is buggy — that command (along with `coordinator-start`) has been **officially retired** (calling it has no side effects; it just says "go read the skill"). Orca **deliberately ships no scheduler** — the official skill's words: *"Agents still choose placement and concurrency; Orca does not schedule workers."* So the DAG loop belongs to the viewer, but **every step** inside that loop now uses Orca's own Run / Task / Dispatch primitives.

![Crayon-style viewer: full-width DAG, default-harness/max-parallel/Run toolbar, and a read-only node panel with per-node harness and model pickers](docs/screenshot.png)

## How it works

```
   your agent (loads the orca-dag skill)          orca-dag viewer (npx orca-dag)  
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
2. Open the viewer (`npx orca-dag`). Pick the Run in the top bar; it polls `orca orchestration task-list --run <id> --json` every 2 seconds, lays out with **dagre**, renders with **React Flow**, and recolors statuses live.
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
- **Node.js ≥ 20** to run `npx orca-dag` — or none at all if you use a release binary. **Bun** only if you want to build a binary yourself.

## Install

One command, both halves:

```bash
cd ~/any/orca-managed/project
npx orca-dag
```

That installs the `orca-dag` **skill** into every coding agent on your machine (Claude Code, Codex, Cursor, OpenCode, Gemini CLI, Droid, and the shared `~/.agents/skills` directory — whichever of them exist), then starts the **viewer** on <http://localhost:8787> with the current directory as the workspace. It re-runs safely: the skill is only rewritten when it actually changed, and a skill directory you symlinked yourself is left untouched.

Then just chat your requirement to the agent. It builds the DAG into Orca per `SKILL.md` and tells you to open the viewer.

Needs only **Node.js ≥ 20** — the package is a ~500 KB dependency-free bundle, and `bunx orca-dag` works too. Keep it around with `npm i -g orca-dag`.

No Node on the machine? Grab a standalone binary from the [releases page](https://github.com/ZinkLu/Orca-Orchestration/releases) — same behaviour, bundles its own runtime, needs only the `orca` CLI on PATH:

```bash
tar xzf orca-dag-darwin-arm64.tar.gz && sudo mv orca-dag /usr/local/bin/ && orca-dag
```

Switches: `PORT` (default 8787), `NO_OPEN=1` (don't open the browser), `--no-skill` / `ORCA_DAG_NO_SKILL=1` (don't touch the agent skill directories), `WORKSPACE_DIR` (overrides the `active` worktree).

Want the skill *without* the viewer, or managed by the standard tooling? `npx skills add ZinkLu/Orca-Orchestration --skill orca-dag --global` — the [open agent skills CLI](https://github.com/vercel-labs/skills), the same one `orca skills install` shells out to.

## Uninstall

```bash
npx orca-dag uninstall            # add --dry-run first if you want to see the list
```

Removes the skill from every agent directory it was installed into and closes any `orca-dag coordinator` terminal a crashed viewer left bound to a Run (that one matters — a stale coordinator keeps your own agent fenced out). A skill directory you symlinked yourself is unlinked, never followed, so your checkout is safe.

Two things it won't delete on its own: `.orca-dag.config.json` (your per-node harness/model choices and canvas layout — pass `--purge` to drop it) and the program itself, since a running process can't remove its own binary. It prints the right command for that: `npm rm -g orca-dag`, `rm $(which orca-dag)`, or nothing at all if you only ever ran it through `npx`.

### Building and releasing it yourself

```bash
npm install
npm run dev            # frontend :5173 + backend :8787 (vite proxies /api) → http://localhost:5173
npm run build:npm      # stage the publishable package → dist-npm/ (Node only)
npm run build:binary   # portable single binary → dist/orca-dag (~100 MB, frontend embedded; needs Bun)
npm run release 0.2.0  # tag + push; CI publishes to npm and attaches every binary to a GitHub release
```

Cross-compile a binary for another platform with `TARGET=bun-linux-x64 npm run build:binary`; `bash scripts/build-all-binaries.sh` does every target at once, which is what the release workflow runs.

## Quick start

An end-to-end pass, starting from nothing installed:

1. **Get your project under Orca** (once per repo) and make sure Orca is up:

   ```bash
   cd ~/code/my-project
   orca repo add .        # skip if already Orca-managed
   orca status --json     # runtime.state should be "ready"; otherwise `orca open`
   ```

2. **Start the viewer** from that same directory and leave it running:

   ```bash
   npx orca-dag           # installs the skill into your agents, serves :8787, opens the browser
   ```

3. **Plan in your agent.** In Claude Code (or any agent that just got the skill), describe what you want and ask for a DAG:

   > Use the orca-dag skill: break "add CSV export to the reports page" into a task DAG.

   The agent will ask a few clarifying questions, write `docs/PRD.md` / `docs/TECH_SPEC.md`, then run `orca orchestration run-create` + `task-create --deps …`. When it's done it tells you the **Run id** (like `run_ab12cd34ef56`).

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
  skill.ts                installs skill/SKILL.md into the agents on this machine, on startup
  uninstall.ts            `orca-dag uninstall`: the exact mirror of skill.ts, plus stale-terminal cleanup
  webAssets.ts            loader for the frontend assets (and the skill) embedded at build time
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
scripts/
  build-binary.mjs        vite build → embed assets + skill → bun --compile → dist/orca-dag
  build-npm.mjs           vite build → esbuild the server → dist-npm/ (the publishable `orca-dag` package)
  build-all-binaries.sh   every Bun target + archives + checksums (what the release workflow runs)
  check-skill.mjs         guards SKILL.md's frontmatter, which the skills CLI installs by
  release.mjs             `npm run release <version>`: checks, tags, pushes — CI does the rest
```

## Design notes and boundaries

- **The brain lives outside**: planning is done by the agent you already have (the skill provides the conventions); the viewer embeds no Claude Agent SDK.
- **The viewer is its own coordinator**: Orca deliberately ships no scheduler, so `server/src/coordinator.ts` drives the loop with Orca's Run/Task/Dispatch primitives. Parallelism follows the DAG (everything ready fires together, capped by `maxConcurrency`); workers are spun up on demand, reused while idle, reclaimed at the end.
- **Workers must be autonomous agents**: hands-off execution requires the worker to run `orca orchestration send --type worker_done` on its own — otherwise it stalls on a permission prompt. `worker-start` launches Orca-configured TUI agents with their autonomous flags; for custom commands the legacy path uses `HARNESS_LAUNCH` in `orca.ts` (only `claude --dangerously-skip-permissions` is verified — add and verify flags for others before relying on them).
- **The `dispatch --inject` quirk** (legacy path): it types the preamble into the agent's input box but often **doesn't submit it** (a readiness race). The coordinator waits ~2s after dispatch and sends an extra Enter; a stray Enter on already-submitted input is a harmless no-op.
- **opencode goes through its own path**: `worker-start --agent opencode` opens the TUI but the injected preamble never lands, so the coordinator opens a bare shell, mints a tracking dispatch, and runs `opencode run --auto "$(cat <preamble>)"` (`--auto` is mandatory — the default permission policy silently auto-rejects tool calls).
- **Per-node harness/model live in a workspace config file**: Orca tasks have no harness/metadata field (`task-create` only takes spec/title/display-name/deps/parent), so the viewer stores harness and model choices, max parallel, and layout in `.orca-dag.config.json` at the workspace root (`server/src/config.ts`, `GET/PUT /api/config`) — surviving browser switches and cleared localStorage. The frontend's `harness.ts` is a reactive store that hydrates from the server and migrates old localStorage values once. At Run time the choices are passed to the backend as `harnessByTask` / `modelByTask`.
- **Created tasks can't be edited**: `orca orchestration task-update` only changes `--status` / `--result` — **no interface to edit spec/title/deps**, and no single-task delete (`reset` clears everything, across all Runs). So "change a task" = **have the agent redraw the DAG in a fresh Run**.
