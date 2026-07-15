# Orca DAG — skill + viewer

把「和 agent 聊天规划」与「可视化 + 执行」拆成两个独立模块：

1. **skill**（`skill/SKILL.md`）：教**你自己的 agent**（Claude Code / kimi / …）如何把一个需求拆成 **Orca orchestration 的任务 DAG**，以及建图规范。规划的"大脑"在你的 agent 里，**不内嵌 Claude Agent SDK**。
2. **viewer**（`server/` + `web/`，编译成全局二进制 `orca-dag`）：连到 Orca 的编排状态，**实时可视化**这张 DAG；加几个 **worker（选 harness：kimi / claude / opencode / grok …）**，点 **「▶ 让 Orca 执行」**，剩下的**交给 Orca 的 coordinator 自动调度执行**。

> 核心流程：**agent 建图 → viewer 里加 worker → Run → Orca 自己按依赖执行整张 DAG**。要改某个任务或依赖，就让 agent 重绘 DAG（`reset` + 重建）—— Orca 没有改单个任务的接口。

![蜡笔风：全宽 DAG + Workers/Run 工具条 + 只读节点详情](docs/screenshot.png)

![涂鸦风：方格纸 + 黑墨钢笔描边的同一张 DAG](docs/screenshot-doodle.png)

## 它是怎么工作的

```
   你的 agent（加载 orca-dag skill）                 orca-dag viewer（全局二进制）
 ┌───────────────────────────────┐             ┌──────────────────────────────┐
 │  和你聊需求 → 拆解 → 建图        │             │  轮询 task-list → 画 DAG        │
 │  Bash: orca orchestration      │             │  + 加 worker(选 harness)        │
 │        task-create / gate-*    │             │  ▶ Run → orchestration run     │
 └───────────────┬───────────────┘             └───────────────┬──────────────┘
                 │  写编排状态                                     │  读 + 启动 coordinator
                 ▼                                               ▼
        ┌────────────────────────  Orca 编排状态 + coordinator  ────────────────────────┐
        │  tasks / deps / gates   ·   worker 终端(各 harness)   ·   run 自动派发 ready 任务  │
        └──────────────────────────────────────────────────────────────────────────┘
```

1. 你在**自己的 agent** 里聊需求。agent 加载 `orca-dag` skill，按规范用 `orca orchestration task-create --deps …` 把任务与依赖建进 Orca。
2. 打开 viewer（`orca-dag`）。它每 2 秒轮询 `orca orchestration task-list --json`，用 **dagre** 布局、**React Flow** 渲染，状态实时变色。
3. 在 viewer 里**加几个 worker**（选 harness）——`orca terminal create --command "<harness>"` 在当前 worktree 起 agent 会话；然后点 **「▶ 让 Orca 执行」**。
4. viewer 调 `orca orchestration run`，**Orca 的 coordinator 接管**：按依赖把 ready 任务派给空闲 worker、等各自 `worker_done`、推进后续任务，直到整张图跑完。你在 viewer 里看状态实时流动。
5. 要改计划：回到 agent 对话让它重绘 DAG。

## 前置条件

- **Orca 运行中**：`orca status --json` 的 `result.runtime.state` 应为 `"ready"`；否则先 `orca open`。
- **项目是 Orca 管理的 worktree**：加 worker / 执行都要求当前目录是 Orca 注册的 repo/worktree（否则 `orca terminal create` 会报 `selector_not_found`）。用 `orca repo add <path>` 或 `orca worktree …` 先纳管。
- **一个能跑 skill 的 agent**（建图侧）：Claude Code、或任何能读 `SKILL.md` 并执行 Bash 的 agent。
- **viewer 侧只依赖 `orca` CLI** —— 不需要 `claude`、不需要 `ANTHROPIC_API_KEY`。
- **Bun**（可选，仅打二进制时需要）。**Node.js ≥ 20**（跑 dev / `npm start` 时需要）。

## 模块 1 · 安装 skill

```bash
ln -s "$PWD/skill" ~/.claude/skills/orca-dag      # 或直接拷贝到 agent 的 skills 目录
```

然后在 agent 里聊需求，它会按 `SKILL.md` 的规范把 DAG 建进 Orca，并提示你运行 `orca-dag` 打开 viewer。

## 模块 2 · 运行 viewer

开发（前端 5173 + 后端 8787，vite 代理 /api）：

```bash
npm install
npm run dev            # 打开 http://localhost:5173
```

打成全局二进制（推荐，可在任意 Orca-managed 项目目录直接调用）：

```bash
npm run build:binary                 # 产出 dist/orca-dag（约 60 MB，前端已内嵌）
cp dist/orca-dag /usr/local/bin/     # 装到 PATH

cd ~/any/orca-managed/project
orca-dag                             # 起在 http://localhost:8787，自动开浏览器；用当前目录当工作区
```

交叉编译（目标机自带 `orca` 即可）：`TARGET=bun-linux-x64 npm run build:binary`。
开关：`PORT`（默认 8787）、`NO_OPEN=1`（不自动开浏览器）、`WORKSPACE_DIR`（覆盖 `active` worktree）。

## viewer 能做什么

- **实时可视化** DAG，节点状态 `pending / ready / dispatched / completed / failed / blocked` 映射颜色。
- **加 worker**：选 `claude / kimi / opencode / grok / codex` 或自定义命令 → 「+ 加 worker」在当前 worktree 起一个 agent 会话，构成 coordinator 的执行池。
- **▶ 让 Orca 执行 / ⏹ 停止**：启动 / 停止 coordinator（`orca orchestration run` / `run-stop`）。执行、调度、按依赖推进都由 Orca 做。
- **审批门**：agent `gate-create` 后，DAG 上浮出「批准 / 驳回」。
- **节点详情（只读）**：点节点看 spec / 状态 / 结果。改描述或依赖 → 让 agent 重绘 DAG。
- **两套手绘主题**：🖍️ 蜡笔 / ✏️ 涂鸦，顶栏切换，记忆到 localStorage。

## HTTP 接口

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/api/dag` | 当前 DAG：`{ nodes, edges, gates, generatedAt }` |
| `GET` | `/api/terminals` | 活动终端（worker）列表 |
| `POST` | `/api/worker` | `{ harness }`：在当前 worktree 起一个 harness worker 会话 |
| `POST` | `/api/run` | `{ spec? }`：启动 coordinator，Orca 自动执行 DAG |
| `POST` | `/api/run-stop` | 停止当前 coordinator run |
| `POST` | `/api/gates/:id/resolve` | `{ resolution }`：解决审批门 |
| `POST` | `/api/reset` | `orca orchestration reset --tasks` 清空任务 |
| `GET` | `/api/health` | 健康检查（返回 workspace 目录） |

## 代码结构

```
skill/SKILL.md            建图规范 + spec 写作约定 + 如何执行（加 worker + Run）+ 边界
server/src/
  index.ts                Express：DAG / terminals / worker / run / run-stop / gates / reset；托管 SPA
  orca.ts                 orca CLI 封装：task-list→DAG、terminals、createWorker、startRun/stopRun
  webAssets.ts            编译期内嵌前端资源的加载器（生产二进制用）
web/src/
  App.tsx                 全宽 DAG 主壳、每 2s 轮询、主题切换
  components/DagView.tsx     React Flow 图 + 自定义状态节点
  components/ExecControls.tsx worker 池（选 harness）+ Run/Stop
  components/NodePanel.tsx    只读节点详情
  components/GatePanel.tsx    审批门浮层
  layout.ts / types.ts / api.ts
scripts/build-binary.mjs  vite build → 内嵌资源 → bun --compile → dist/orca-dag
```

## 设计说明与边界

- **大脑外移**：规划由你已有的 agent 承担（skill 提供规范），viewer 不内嵌 Claude Agent SDK，也不需要机器上装 `claude`。
- **执行交给 Orca 的 coordinator**：viewer 不做手动派发 —— 点 Run 就是 `orca orchestration run`，由 Orca 按依赖自动调度到空闲 worker、收集 `worker_done`、推进 DAG。`run` 立即返回一个 `runId`，coordinator 跑在 Orca runtime 里。
- **worker 必须预先存在**：`run` 不自己拉起 agent，只把 ready 任务派给**已连接、空闲**的 worker 终端。所以 viewer 提供"加 worker"——harness 就是终端里跑的命令，这也是选 agent 的地方。
- **改不了已建任务**：`orca orchestration task-update` 只能改 `--status` / `--result`，**没有改 spec/标题/依赖的接口**，也没有删除单个任务的命令（只有 `reset` 整体清空）。所以"修改任务"= **让 agent 重绘 DAG**（`reset --tasks` 后重建，会换 id）。建图时尽量一次写对。
