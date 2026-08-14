---
name: orca-dag
description: "Plan software work as an Orca orchestration task DAG. Use when the user wants to break a feature or project into an executable graph of tasks with dependencies and approval gates in Orca, then visualize and fire it. Teaches the exact `orca orchestration` CLI commands to build the DAG, the spec-writing conventions, and how to open the orca-dag viewer so the user can pick a harness per node and fire tasks."
---

# orca-dag

Refine a software requirement through conversation and land it as an **Orca orchestration task DAG** (directed acyclic graph). You own **building and reshaping the graph**; **execution is triggered by the user in the `orca-dag` viewer** — the viewer advances the whole graph automatically, in parallel, along its dependencies. It is not fired node by node.

Every planning result **must be written into Orca's orchestration state** (by running `orca orchestration` commands), not left as chat text — the viewer polls Orca live and draws whatever is there.

## Tools you may use
- **Bash** to run the `orca` CLI and read/write orchestration state.
- **Read / Write / Edit** to write planning docs in the working directory (`docs/PRD.md`, `docs/TECH_SPEC.md`).
- Do not run destructive commands unrelated to this task (`rm`, `git push`, deleting files, …).

## Preflight
```bash
orca status --json      # runtime.state should be "ready"; if not, ask the user to run `orca open` first
                        # runtime.appVersion must be >= 1.4.160 (the Run/Dispatch contract)
```

## Workflow (three phases, all in conversation)
1. **Requirement clarification (PRD)**: align on the goal, MVP scope, and explicit non-goals with short questions — one key question at a time. If MVP is enough, plan only P0; don't over-design. Once agreed, write `docs/PRD.md`.
2. **Technical design (TECH_SPEC)**: stack, data model (down to fields), module interfaces (pseudocode). Write `docs/TECH_SPEC.md`.
3. **Decompose into a task DAG**: split the design into parallel/serial subtasks and create the tasks and dependencies with the commands below. **This step is the required output.**

## Writing the DAG into Orca (the core)

### Step 0: create a Run first (required on Orca ≥ 1.4.160)

Tasks are **no longer global**: every task belongs to a Run, and `task-create` / `task-list` fail with `run_required` when no Run is bound. So **start every plan by opening a fresh Run** to hold this DAG:

```bash
orca orchestration run-create --objective "<one sentence on what this plan does>" --json
```

The response carries `result.run.id` (shaped like `run_xxxxxxxx`). `run-create` binds the **current terminal** as that Run's coordinator, so later `task-create` calls don't need `--run`.

> One Run holds one DAG. Orca itself doesn't enforce this (a Run is just a namespace), but the viewer renders "one Run = one graph". To replan, open a new Run — **never** use `reset`.

### Step 1: create tasks one by one

Dependencies between tasks are passed to `--deps` as a **JSON array** of the depended-on task ids.

A root task (no deps):
```bash
orca orchestration task-create \
  --task-title "Scaffold the project" \
  --spec "Initialize project structure and dependencies; produce package.json, src/, .gitignore. Acceptance: npm test runs." \
  --json
```
`result.task.id` in the response is the task id (shaped like `task_xxxxxxxx`).

Depending on an earlier task (put its id into `--deps`):
```bash
orca orchestration task-create \
  --task-title "Implement the data model" \
  --spec "Implement models and migrations per the TECH_SPEC data model. Acceptance: migrations run, unit tests included." \
  --deps '["task_c8df9d97"]' --json
```
Multiple deps: `--deps '["task_aaa","task_bbb"]'`.

**Remember every returned task id** — later tasks reference them in `--deps`, which is what builds the correct DAG. After creating a batch, self-check:
```bash
orca orchestration task-list --run <run_id> --json     # verify the dependencies are right
```
Deps may only point at tasks **within the same Run**.

### Spec-writing rules (important)
Every subtask's `--spec` must be **self-contained and independently executable**, so the future executing agent **never has to ask questions or enter plan mode**:
- **Inputs**: what it depends on, which files/interfaces to read.
- **Outputs**: which files to create/modify, what the deliverable is.
- **Acceptance criteria**: what "done" means (runnable tests, observable behavior).
- Use imperative sentences; avoid vague phrasing like "investigate" or "as appropriate".

## When human approval is needed
At key points (e.g. "approve the design before execution"), create a decision gate. It blocks its task, and the viewer surfaces approve/reject buttons:
```bash
orca orchestration gate-create \
  --task <task_id> \
  --question "Approve the TECH_SPEC and move to execution?" \
  --options '["approved","rejected"]' --json
```

## After the DAG is built: open the viewer and let Orca execute
Once the DAG has taken shape, ask the user to open the viewer, and **tell them the Run id** (they pick it in the viewer's top bar):
```bash
npx orca-dag    # run in the current project directory; serves http://localhost:8787 and opens the browser
```
(If they already have it running — likely, since that command is also what installed this skill — they just need to reselect the Run.)
In the viewer the user will: **pick your new Run in the top bar** → **watch the DAG live** → **choose a harness per node** (claude / codex / opencode / grok …, or a default fallback) → click **"▶ Run with Orca"** → **the viewer uses `worker-start` to spin up workers in dependency-parallel, waits for `worker_done`, and advances the whole graph** → **resolve approval gates**.

In other words: **execution is the viewer's job, not yours.** Your responsibility ends at "the DAG is correct".

⚠️ **You will get fenced — this is normal.** When the user starts execution, the viewer binds the Run's coordinator to its own terminal. From then on **your** mutations against that Run (`task-create` / `gate-resolve` / `dispatch`) fail with `consumer_fenced`. To take it back:

```bash
orca orchestration run-use --id <run_id> --json     # re-bind yourself as coordinator
```

Reads are unaffected — `task-list --run <id>` / `gate-list --run <id>` always work. So **`run-use` to reclaim the binding before adjusting the DAG**, then let the user hit Run again.

You and the user can **keep adjusting the DAG in conversation** (add/remove tasks, change deps, add gates) and the viewer reflects it live. **By default, do not run `orca orchestration dispatch` / `worker-start` yourself** — that's the viewer's loop — unless the user explicitly asks you to drive from the command line.

## Boundaries and known constraints
- Focus on **planning + graph building**. Execution belongs to the viewer (the coordinator).
- **Created tasks cannot be edited**: `orca orchestration task-update` only changes `--status` / `--result`. **There is no interface to edit spec/title/deps**, and no command to delete a single task. Get the graph right on the first pass where possible.
- **To redraw the DAG, open a new Run — never `reset`.** `orca orchestration reset --tasks` has **no `--run` scope**: it clears the entire local orchestration database, deleting other Runs' tasks too. The correct move is `run-create` a new Run and rebuild; the old Run stays as history.
- **Decision gates are Run-scoped, but the flags differ by direction**: `gate-list` (read) takes `--run <id>`; `gate-resolve` (mutation) takes **no `--run`** — it locates the gate via `--from <handle>` (a coordinator terminal bound to the Run) plus the globally unique `--id`. That's why the viewer first binds a coordinator with `run-use`, then resolves via `--from`.
- **`orca orchestration run` / `run-stop` / `coordinator-start` / `coordinator-stop` are retired.** Calling them has no effect; they only return a "go read the orchestration skill" notice. Don't use them.
- Don't run destructive or off-task system commands.

## Communication style
- Follow the user's language. Concise and direct.
- After each batch of task creation/changes, summarize the DAG's current shape in one sentence (what runs in parallel, what is serial) — the user is watching it appear in the viewer.
