# Orca DAG — skill + viewer

把「和 agent 聊天规划」与「可视化 + 执行」拆成两个独立模块：

1. **skill**（`skill/SKILL.md`）：教**你自己的 agent**（Claude Code / kimi / …）如何把一个需求拆成 **Orca orchestration 的任务 DAG**，以及建图规范。规划的"大脑"在你的 agent 里，**不内嵌 Claude Agent SDK**。
2. **viewer**（`server/` + `web/`，编译成全局二进制 `orca-dag`）：连到 Orca 的编排状态，**实时可视化**这张 DAG；每个节点**各自选 harness**（claude / kimi / opencode / grok …），点 **「▶ 让 Orca 执行」**，viewer 内置的**自驱动 coordinator** 就按依赖把 ready 任务**并行**派发给按需拉起的自主 worker，直到整张图跑完。

> 核心流程：**agent 建图 → viewer 里选 Run、给节点选 harness → Run → 按 DAG 并行自动执行**。要改某个任务或依赖，就让 agent 重绘 DAG —— Orca 没有改单个任务的接口。
>
> ⚠️ **需要 Orca ≥ 1.4.160。** 该版本（2026-07-29，PR #9925）重写了整个编排契约，本项目已适配，**不再兼容更早的 Orca**。
>
> ⚠️ 为什么 viewer 仍然自己当 coordinator：不是因为 `orca orchestration run` 有 bug —— 那个命令连同 `coordinator-start` 已被**正式退休**（调用无副作用，只返回"去读 skill"）。Orca 是**故意不做调度器**的，官方 skill 原话：*"Agents still choose placement and concurrency; Orca does not schedule workers."* 所以走 DAG 的循环归 viewer，但循环里**每一步**现在都用 Orca 自己的 Run / Task / Dispatch 原语。

![蜡笔风：全宽 DAG + 默认 harness/最多并行/Run 工具条 + 每节点 harness 选择的只读节点详情](docs/screenshot.png)

## 它是怎么工作的

```
   你的 agent（加载 orca-dag skill）                 orca-dag viewer（全局二进制）
 ┌───────────────────────────────┐             ┌──────────────────────────────┐
 │  和你聊需求 → 拆解 → 建图        │             │  轮询 task-list → 画 DAG        │
 │  Bash: orca orchestration      │             │  每节点选 harness              │
 │        task-create / gate-*    │             │  ▶ Run → 自驱动 coordinator     │
 └───────────────┬───────────────┘             └───────────────┬──────────────┘
                 │  写编排状态                                     │  轮询 + dispatch --inject（并行）
                 ▼                                               ▼
        ┌──────────────────────────  Orca 编排状态  ──────────────────────────┐
        │  tasks / deps / gates   ·   按需拉起的自主 worker（各节点的 harness）    │
        └──────────────────────────────────────────────────────────────────┘
```

1. 你在**自己的 agent** 里聊需求。agent 加载 `orca-dag` skill，先 `orca orchestration run-create` 开一个 **Run**，再用 `task-create --deps …` 把任务与依赖建进这个 Run。
2. 打开 viewer（`orca-dag`）。顶栏选 Run，它每 2 秒轮询 `orca orchestration task-list --run <id> --json`，用 **dagre** 布局、**React Flow** 渲染，状态实时变色。
3. 在 viewer 里给节点选 harness（或用一个默认 harness 兜底），设置"最多并行"，点 **「▶ 让 Orca 执行」**。
4. viewer 的 **coordinator 循环**接管：先把自己的一个 Orca 终端绑定为该 Run 的 coordinator（拿写权限），然后每轮找出所有 `ready` 任务，**并行**调 `orca orchestration worker-start --task <id> --agent <harness>` —— 由 **Orca 自己**创建 worker 终端、等就绪、注入 dispatch，并返回一个 **Dispatch**（一次尝试）。worker 干完发 `worker_done --outcome` → Orca **自动**把 task 和 dispatch 置为完成/失败 → 依赖转 `ready` → 继续，直到全跑完，然后 `worker-stop` 回收。
5. 要改计划：回到 agent 对话让它重绘 DAG。

### Run / Task / Dispatch 三层

| 层 | 是什么 | 谁维护 |
|---|---|---|
| **Run** | 命名空间 + coordinator 收件箱；同一时刻只有一个绑定的 coordinator（`consumer_generation` 做 fencing） | Orca |
| **Task** | 工作项；`deps` 定义 DAG 边，`run_id` 归属 Run | Orca |
| **Dispatch** | **一次尝试**（id 形如 `ctx_*`）；带 `failure_count`（3 次熔断）、心跳、pane 身份、能力凭证。重试产生新的 Dispatch | Orca |
| 每节点 harness、画布坐标、默认 harness、最大并行、当前 Run | viewer 自己的偏好 | `.orca-dag.config.json` |

Run 是命名空间，**不等于 DAG** —— 一个 Run 里可以躺多张互不相连的图。"一个 Run 一张图"是 `skill/SKILL.md` 里的约定，不是 Orca 的约束。

### 权限模型（为什么 viewer 要占一个终端）

Orca 的所有编排调用都过 `resolveRunScope`：

- **读**（`task-list` / `gate-list`）只要带 `--run <id>` 就跳过 consumer 检查，**任何进程都能读**。viewer 的轮询只需要这个。
- **写**（`dispatch` / `gate-resolve` / `task-create` / `worker-start`）要求调用方**就是当前绑定该 Run 的那个 Orca 终端**，靠 `--from <handle>` 解析出 pane 来比对。

viewer 是个普通进程，没有终端身份，所以写操作一律 `run_required`。解法是 viewer 自己开一个标题为 `orca-dag coordinator` 的 Orca 终端，`run-use` 绑定，然后所有写操作带 `--from`。**绑定会 fence 掉原来的 coordinator**（通常就是给你画图的那个 agent 终端），所以点执行前 viewer 会明确确认一次；agent 随时可以用 `orca orchestration run-use --id <run>` 抢回去。停止执行时 viewer 会关掉这个终端，把 Run 让出来。

## 前置条件

- **Orca ≥ 1.4.160**（`orca status --json` 里的 `result.runtime.appVersion`）。Run/Dispatch 契约是 1.4.160 引入的；更老的版本没有 `run-create` / `worker-start`，本 viewer 跑不了。
- **编排实验特性已开启**：Settings → Experimental。
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

- **实时可视化** DAG，节点状态 `pending / ready / dispatched / completed / failed / blocked` 映射颜色；每个节点角上标着它的 harness。
- **布局算法切换**：顶栏「布局」段控可切 **横向分层 / 纵向分层**（dagre / Sugiyama）与 **力导向**（Fruchterman–Reingold）；**↻ 重排** 一键重新自动布局（清除手动拖拽）。选择记忆到 localStorage。
- **拖拽布局**：节点可自由拖动，位置在实时轮询刷新中保持不变（只有你没动过的节点跟随自动布局）。
- **执行动画**：`dispatched`（执行中）节点用蜡笔斜纹从左上到右下一遍遍「涂鸦」；从执行中节点流出的连线先是游动的虚线草稿，再有铅笔笔触从本节点向下游一遍遍「描」成实线。
- **每节点选 harness**：点节点在面板里选 `claude / kimi / opencode / grok / codex` 或自定义命令（持久化到 workspace 的 `.orca-dag.config.json`）；没单独设的节点用顶栏的**默认 harness** 兜底。
- **▶ 让 Orca 执行 / ⏹ 停止** + **最多并行**：启动/停止 viewer 内置的自驱动 coordinator；worker 数由 DAG 并行度决定(能并行就并行,受"最多并行"上限约束)、按需拉起、空闲复用、跑完回收 —— **不用手动加 worker**。执行中显示"N worker"。
- **审批门**：agent `gate-create` 后，DAG 上浮出「批准 / 驳回」。
- **节点详情（只读 spec）**：点节点看 spec / 状态 / 结果。改描述或依赖 → 让 agent 重绘 DAG。
- **手绘蜡笔风**：🖍️ SVG feTurbulence 波动描边 + 米色速写本画布。

## HTTP 接口

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/api/dag` | 当前 DAG：`{ nodes, edges, gates, generatedAt }` |
| `POST` | `/api/run` | `{ harnessByTask?, defaultHarness?, maxConcurrency? }`：启动自驱动 coordinator |
| `POST` | `/api/run-stop` | 停止 coordinator 并回收已拉起的 worker |
| `GET` | `/api/run-status` | coordinator 实时状态：`{ running, busy, workers, error }` |
| `POST` | `/api/gates/:id/resolve` | `{ resolution }`：解决审批门 |
| `POST` | `/api/reset` | `orca orchestration reset --tasks` 清空任务 |
| `GET` | `/api/config` | viewer 配置（harness 选择 / 最多并行 / 布局），存在 workspace 的 `.orca-dag.config.json` |
| `PUT` | `/api/config` | 合并写入 viewer 配置 |
| `GET` | `/api/health` | 健康检查（返回 workspace 目录） |

## 代码结构

```
skill/SKILL.md            建图规范 + spec 写作约定 + 如何执行（选 harness + Run）+ 边界
server/src/
  index.ts                Express：DAG / run / run-stop / run-status / gates / reset；托管 SPA
  coordinator.ts          自驱动 coordinator 循环：轮询 DAG，并行 dispatch --inject 到按需/复用的 worker
  orca.ts                 orca CLI 封装：task-list→DAG、spawnWorker(自主 agent)、dispatchTask、close
  config.ts               viewer 配置持久化：workspace 下 .orca-dag.config.json 的读写（/api/config）
  webAssets.ts            编译期内嵌前端资源的加载器（生产二进制用）
web/src/
  App.tsx                 全宽 DAG 主壳、每 2s 轮询
  components/DagView.tsx     React Flow 图 + 状态节点（含 harness 标签）
  components/ExecControls.tsx 默认 harness + 最多并行 + Run/Stop + 实时状态
  components/NodePanel.tsx    节点详情 + 每节点 harness 选择
  components/GatePanel.tsx    审批门浮层
  harness.ts                响应式配置 store：每节点 harness / 默认 harness / 最多并行 / 布局（/api/config 持久化）
  layout.ts                 布局算法：dagre 分层（LR/TB）+ 力导向（Fruchterman–Reingold）
  types.ts / api.ts
scripts/build-binary.mjs  vite build → 内嵌资源 → bun --compile → dist/orca-dag
```

## 设计说明与边界

- **大脑外移**：规划由你已有的 agent 承担（skill 提供规范），viewer 不内嵌 Claude Agent SDK。
- **viewer 自己当 coordinator**：实测 `orca orchestration run` 不真派发任务，所以 `server/src/coordinator.ts` 用已验证的 `dispatch --inject` 自驱动。并行度由 DAG 决定（同时 ready 的任务一起派，受 `maxConcurrency` 上限）；worker 按需拉起、空闲复用、跑完回收。
- **worker 必须是自主 agent**：hands-off 执行要求 worker 能自己跑 `orca orchestration send --type worker_done` 回报 —— 否则会卡在权限确认。所以 `spawnWorker` 用免审批方式起 agent：`claude --dangerously-skip-permissions`（已验证）。其余 harness 的免审批开关见 `orca.ts` 的 `HARNESS_LAUNCH`，需各自填好并验证。
- **`dispatch --inject` 的坑**：它把 preamble 打进 agent 输入框，但常常**不自动提交**（就绪竞态）。coordinator 因此在 dispatch 后停 ~2s 再补发一个 Enter；对已提交/空输入的多余 Enter 是无害 no-op。
- **每节点 harness 存 workspace 配置文件**：Orca 的 task 没有 harness/metadata 字段（`task-create` 只有 spec/title/display-name/deps/parent），所以 viewer 把 harness 选择、最多并行、布局存到 workspace 根的 `.orca-dag.config.json`（`server/src/config.ts`，`GET/PUT /api/config`），换浏览器 / 清 localStorage 都不丢；前端 `harness.ts` 是响应式 store，启动时从服务器加载并把旧的 localStorage 值一次性迁移上去。Run 时仍以 `harnessByTask` 传给后端。
- **改不了已建任务**：`orca orchestration task-update` 只能改 `--status` / `--result`，**没有改 spec/标题/依赖的接口**，也没有删除单个任务的命令（只有 `reset` 整体清空）。所以"修改任务"= **让 agent 重绘 DAG**（`reset --tasks` 后重建，会换 id）。
