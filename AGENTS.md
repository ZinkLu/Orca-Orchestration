# AGENTS.md

Guidance for agents working **in this repo** (editing the viewer/tooling or the skill doc). For using the skill to build DAGs, read `skill/SKILL.md` and `README.md` instead. `CLAUDE.md` is a symlink to this file — edit here, don't replace the link.

## Project shape

Two independent modules in one npm-workspaces repo (`workspaces: [server, web]`):

- **`skill/SKILL.md`** — a published agent skill (frontmatter + prose). Teaches an *external* agent to build an Orca orchestration task DAG via the `orca` CLI. No code; edit it like a doc, keep frontmatter intact.
- **`server/` + `web/`** — the `orca-dag` viewer: an Express API + React Flow SPA that visualizes a Run's DAG and runs a self-driven coordinator loop. Compiles to a single portable binary (`dist/orca-dag`).

This repo is a thin, heavily-commented wrapper over the `orca` CLI. Every Orca quirk is documented in `server/src/orca.ts` comments — **read them before touching orchestration code.**

## Commands

```bash
npm install
npm run dev            # BOTH server (:8787) + web (:5173) via concurrently; vite proxies /api → :8787
npm run dev:server     # tsx watch src/index.ts (server only)
npm run dev:web        # vite (web only)
npm run build          # web only: tsc -b && vite build → web/dist
npm run build:binary   # web build → embed as base64 in server/src/generated/webAssets.ts → bun --compile → dist/orca-dag
npm start              # server (tsx) against web/dist on disk; needs `npm run build` first for UI
```

- **No `lint`, `test`, or `typecheck` scripts exist.** Typecheck manually:
  - web: `npm run build -w web` (runs `tsc -b` first, fails fast on type errors)
  - server: `npx tsc -p server/tsconfig.json --noEmit`
- **`build:binary` requires `bun` on PATH** (not declared as a dependency). Cross-compile with `TARGET=bun-linux-x64 npm run build:binary`.
- Binary runtime env: `PORT` (8787), `NO_OPEN=1` (skip browser), `WORKSPACE_DIR` (overrides `active` worktree), `ORCA_WORKTREE` (default `active`).

## Architecture gotchas

- **The viewer is the scheduler.** Orca ships no scheduler by design (`run`/`run-stop`/`coordinator-start`/`coordinator-stop` are retired no-ops). `server/src/coordinator.ts` owns the dispatch loop: each tick starts a worker for every `ready` task up to `maxConcurrency`.
- **Authority model shapes the whole server.** Reads (`task-list`/`gate-list`) need only `--run <id>` (any process). Mutations (`dispatch`/`gate-resolve`/`task-create`/`worker-start`) require the caller to be the live Orca terminal bound to the Run, proven via `--from <handle>`. So the server keeps its own "orca-dag coordinator" Orca terminal for pane identity (`ensureCoordinatorTerminal` in `orca.ts`).
- **`asCoordinator` (index.ts) never reuses the loop's terminal** for one-off mutations — it creates a throwaway, uniquely-titled terminal, binds, acts, closes. Reusing the loop's terminal would fence and then kill a running coordinator. Preserve this pattern.
- **`dispatch --inject` does not reliably submit** the preamble into the agent TUI. `startLegacyWorker` sleeps ~2s then sends an Enter; a stray Enter on already-submitted input is an intentional no-op. Don't "fix" this.
- **opencode bypasses `worker-start` entirely** (`coordinator.ts` routes harness `opencode` straight to legacy). `worker-start --agent opencode` opens the TUI but never lands the injected preamble (orca #9951), so `startOpencodeWorker` opens a **bare shell**, mints a tracking dispatch (for a real `dispatch_id`), fetches the preamble, and runs `opencode run --auto "$(cat <preamble-file>)"`. **`--auto` is mandatory** — opencode's default permission policy auto-rejects tool calls (e.g. writing outside the project) and silently kills the task. Verified end-to-end 2026-08-10.
- **Per-node model override (`modelByTask` in `.orca-dag.config.json`)** is only wired for harnesses that support it: **opencode** (`opencode run -m <provider/model>`, enumerable via `opencode models` → `listModels` in `orca.ts`), and **claude/codex/cursor** (`worker-start --model <plain model>`, no enumerable list so the UI uses free-text). Everything else ignores the field. The dispatch loop threads the model through `startSupervisedWorker`/`startOpencodeWorker` (serialized as an arg for opencode, quoted for shell safety).
- **Viewer must run inside an Orca-managed worktree** — `orca terminal create --worktree` needs the cwd to be registered (`orca repo add`/`orca worktree`), else `selector_not_found`.
- **Requires Orca ≥ 1.4.160** (the Run/Task/Dispatch contract, PR #9925, 2026-07-29). Older Orca lacks `run-create`/`worker-start`.

## Web app gotchas

- **`web/src/harness.ts` is the single config store** (`useSyncExternalStore`). The server-side `.orca-dag.config.json` is the source of truth; localStorage is only a one-time migration source plus a write-through mirror. Writes debounce 250ms before `PUT /api/config`.
- **Hydration order matters**: `App.tsx` gates `RunPicker`'s auto-pick behind a `hydrated` flag — if the picker fell back to "newest Run" before `initConfig()` resolved, it would overwrite the stored Run choice.
- The UI polls `GET /api/dag` every 2s. Manually dragged nodes keep their positions across refreshes (only untouched nodes follow auto-layout; ↻ Re-layout bumps `reorgNonce` to clear drags). Layout algorithms live in `web/src/layout.ts` (dagre layered LR/TB + Fruchterman–Reingold force).
- **The crayon look is SVG `feTurbulence` filters** defined once in `App.tsx` (`#crayon*`, `#pencil-edge*`, `#crayon-fill`), with tuned seeds/regions — e.g. `pencil-edge` uses `userSpaceOnUse` with an oversized region so perfectly horizontal edges don't collapse the filter to nothing. The comments explain each knob; read them before retuning. `DoodleSelect.tsx` replaces native `<select>`s to keep the style.

## Generated / runtime artifacts (never edit, never commit)

- `server/src/generated/webAssets.ts` — written by `build:binary` only, gitignored, deleted in its `finally`. Don't create by hand.
- `.orca-dag.config.json` (workspace root) — viewer config (per-node harness, default harness, concurrency, layout, last runId). Written by `config.ts` via tmp+rename. Orca tasks have no metadata field, so this file is the viewer's own store.
- `dist/`, `web/dist/`, `node_modules/`, `*.tsbuildinfo` — all gitignored.

## Orca integration constraints (also in skill/SKILL.md)

- **`orca orchestration reset --tasks` has NO `--run` scope** — it wipes the *entire* local orchestration DB, every Run at once. To redo one DAG, create a new Run (`run-create`); do **not** reset.
- **`task-update` only changes `--status`/`--result`** — no edit to spec/title/deps, no delete-single-task. "Changing a task" = rebuild the DAG.
- **Gates are Run-scoped, but the flag differs by direction**: `gate-list` (read) takes `--run <id>`; `gate-resolve` (mutation) takes NO `--run` — it resolves Run scope from the bound `--from <handle>` (plus a globally-unique `--id`). The viewer binds the coordinator terminal to the Run first via `run-use`, then resolves by `--from`.
- **`HARNESS_LAUNCH` in `orca.ts` only has `claude --dangerously-skip-permissions` verified.** Other harnesses need their own autonomous flag added and verified, and only matter on the legacy path (custom commands or `agent_unconfigured` from `worker-start`).

## Conventions

- **Rich "why" comments** are the norm for anything touching Orca — the quirks are non-obvious and the comments are load-bearing. Match this style; don't strip context when editing.
- **All docs and user-facing strings are English** (the project is open source; translated 2026-08-11). Keep new UI text, server errors, and docs in English. `README_zh.md` is the Simplified Chinese mirror of `README.md` — update both when changing README content.
- TypeScript is `strict` in both packages; web also enforces `noUnusedLocals`/`noUnusedParameters`. ESM everywhere (`"type": "module"`, ES2022).
