# Orca DAG — skill + viewer

[English](README.md) | 简体中文

把「和 agent 聊天规划」与「可视化 + 执行」拆成两个独立模块：

1. **skill**（`skill/SKILL.md`）：教**你自己的 agent**（Claude Code / kimi / …）如何把一个需求拆成 **Orca orchestration 的任务 DAG**，以及建图规范。规划的"大脑"在你的 agent 里，**不内嵌 Claude Agent SDK**。
2. **viewer**（`server/` + `web/`，以 `orca-dag` npm 包和独立二进制分发）：连到 Orca 的编排状态，**实时可视化**这张 DAG；每个节点**各自选 harness**（claude / kimi / opencode / grok …），还可以**选模型**；点 **「▶ Run with Orca」**，viewer 内置的**自驱动 coordinator** 就按依赖把 ready 任务**并行**派发给按需拉起的自主 worker，直到整张图跑完。

> 核心流程：**agent 建图 → viewer 里选 Run、给节点选 harness → Run → 按 DAG 并行自动执行**。要改某个任务或依赖，就让 agent 重绘 DAG —— Orca 没有改单个任务的接口。
>
> ⚠️ **需要 Orca ≥ 1.4.160。** 该版本（2026-07-29，PR #9925）重写了整个编排契约，本项目已适配，**不再兼容更早的 Orca**。
>
> ⚠️ 为什么 viewer 仍然自己当 coordinator：不是因为 `orca orchestration run` 有 bug —— 那个命令连同 `coordinator-start` 已被**正式退休**（调用无副作用，只返回"去读 skill"）。Orca 是**故意不做调度器**的，官方 skill 原话：*"Agents still choose placement and concurrency; Orca does not schedule workers."* 所以走 DAG 的循环归 viewer，但循环里**每一步**现在都用 Orca 自己的 Run / Task / Dispatch 原语。

![蜡笔风 viewer：全宽 DAG + 默认 harness/最多并行/Run 工具条 + 带每节点 harness 与模型选择的只读节点详情](docs/screenshot.png)

## 它是怎么工作的

```
   你的 agent（加载 orca-dag skill）                 orca-dag viewer（npx orca-dag）
 ┌───────────────────────────────┐             ┌──────────────────────────────┐
 │  和你聊需求 → 拆解 → 建图        │             │  轮询 task-list → 画 DAG        │
 │  Bash: orca orchestration      │             │  每节点选 harness              │
 │        task-create / gate-*    │             │  ▶ Run → 自驱动 coordinator     │
 └───────────────┬───────────────┘             └───────────────┬──────────────┘
                 │  写编排状态                                     │  轮询 + worker-start（并行）
                 ▼                                               ▼
        ┌──────────────────────────  Orca 编排状态  ──────────────────────────┐
        │  tasks / deps / gates   ·   按需拉起的自主 worker（各节点的 harness）    │
        └──────────────────────────────────────────────────────────────────┘
```

1. 你在**自己的 agent** 里聊需求。agent 加载 `orca-dag` skill，先 `orca orchestration run-create` 开一个 **Run**，再用 `task-create --deps …` 把任务与依赖建进这个 Run。
2. 打开 viewer（`npx orca-dag`）。顶栏选 Run，它每 2 秒轮询 `orca orchestration task-list --run <id> --json`，用 **dagre** 布局、**React Flow** 渲染，状态实时变色。
3. 在 viewer 里给节点选 harness（或用一个默认 harness 兜底），设置 "Max parallel"，点 **「▶ Run with Orca」**。
4. viewer 的 **coordinator 循环**接管：先把自己的一个 Orca 终端绑定为该 Run 的 coordinator（拿写权限），然后每轮找出所有 `ready` 任务，**并行**调 `orca orchestration worker-start --task <id> --agent <harness>` —— 由 **Orca 自己**创建 worker 终端、等就绪、注入 dispatch，并返回一个 **Dispatch**（一次尝试）。worker 干完发 `worker_done --outcome` → Orca **自动**把 task 和 dispatch 置为完成/失败 → 依赖转 `ready` → 继续，直到全跑完，然后 `worker-stop` 回收。
5. 要改计划：回到 agent 对话让它重绘 DAG。

### Run / Task / Dispatch 三层

| 层 | 是什么 | 谁维护 |
|---|---|---|
| **Run** | 命名空间 + coordinator 收件箱；同一时刻只有一个绑定的 coordinator（`consumer_generation` 做 fencing） | Orca |
| **Task** | 工作项；`deps` 定义 DAG 边，`run_id` 归属 Run | Orca |
| **Dispatch** | **一次尝试**（id 形如 `ctx_*`）；带 `failure_count`（3 次熔断）、心跳、pane 身份、能力凭证。重试产生新的 Dispatch | Orca |
| 每节点 harness 与模型、画布坐标、默认 harness、最大并行、当前 Run | viewer 自己的偏好 | `.orca-dag.config.json` |

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
- **Node.js ≥ 20** 用于跑 `npx orca-dag` —— 用 release 二进制的话什么都不需要。**Bun** 只在你想自己打二进制时才需要。

## 安装

一条命令，两个模块一起到位：

```bash
cd ~/any/orca-managed/project
npx orca-dag
```

它会把 `orca-dag` **skill** 装进你本机所有的 coding agent（Claude Code、Codex、Cursor、OpenCode、Gemini CLI、Droid，以及共享的 `~/.agents/skills` —— 存在哪个装哪个），然后在 <http://localhost:8787> 起 **viewer**，并把当前目录当作工作区。重复执行是安全的：skill 只在内容真的变了时才重写，你自己做的 symlink 目录会被完全跳过。

接着直接在 agent 里聊需求就行，它会按 `SKILL.md` 的规范把 DAG 建进 Orca，并提示你打开 viewer。

只要 **Node.js ≥ 20** —— 包是个约 500 KB、零依赖的 bundle，`bunx orca-dag` 同样可用。想常驻就 `npm i -g orca-dag`。

机器上没有 Node？去 [releases 页](https://github.com/ZinkLu/Orca-Orchestration/releases) 拿独立二进制，行为完全一样，自带运行时，只需要 PATH 上有 `orca`：

```bash
tar xzf orca-dag-darwin-arm64.tar.gz && sudo mv orca-dag /usr/local/bin/ && orca-dag
```

开关：`PORT`（默认 8787）、`NO_OPEN=1`（不自动开浏览器）、`--no-skill` / `ORCA_DAG_NO_SKILL=1`（不碰 agent 的 skill 目录）、`WORKSPACE_DIR`（覆盖 `active` worktree）。

只想要 skill、不要 viewer，或者想用标准工具管理？`npx skills add ZinkLu/Orca-Orchestration --skill orca-dag --global` —— 即 [open agent skills CLI](https://github.com/vercel-labs/skills)，`orca skills install` 底层调的也是它。

## 卸载

```bash
npx orca-dag uninstall            # 想先看清单就加 --dry-run
```

把 skill 从所有装过的 agent 目录里删掉，并关掉 viewer 崩溃后残留的 `orca-dag coordinator` 终端 —— 后面这条其实最要紧，残留的 coordinator 会一直占着 Run，把你自己的 agent 挡在外面。你自己做的 symlink 只会被 unlink，不会顺着链接删，checkout 是安全的。

有两样它默认不删：`.orca-dag.config.json`（每个节点的 harness/模型选择和画布布局，要删加 `--purge`），以及程序本身 —— 进程删不掉自己正在跑的文件。它会直接把对应命令打出来：`npm rm -g orca-dag`、`rm $(which orca-dag)`，或者你一直用 `npx` 的话什么都不用做。

### 自己构建和发版

```bash
npm install
npm run dev            # 前端 5173 + 后端 8787（vite 代理 /api）→ http://localhost:5173
npm run build:npm      # 打出可发布的包 → dist-npm/（只要 Node）
npm run build:binary   # 便携单文件二进制 → dist/orca-dag（约 100 MB，前端已内嵌；需要 Bun）
npm run release 0.2.0  # 打 tag 并推送；CI 负责发 npm + 把各平台二进制挂到 GitHub release
```

用 `TARGET=bun-linux-x64 npm run build:binary` 交叉编译到别的平台；`bash scripts/build-all-binaries.sh` 一次编出全部目标，release workflow 跑的就是它。

## Quick start

从零开始，完整走一遍：

1. **把项目纳入 Orca 管理**（每个仓库一次），并确认 Orca 在运行：

   ```bash
   cd ~/code/my-project
   orca repo add .        # 已纳管则跳过
   orca status --json     # runtime.state 应为 "ready"；否则先 `orca open`
   ```

2. **在同一个目录起 viewer**，让它一直开着：

   ```bash
   npx orca-dag           # 装 skill 到你的 agent，起在 :8787 并自动开浏览器
   ```

3. **在 agent 里做规划。** 在 Claude Code（或任何刚拿到 skill 的 agent）里描述需求并要一张 DAG：

   > 用 orca-dag skill：把「给报表页加 CSV 导出」拆成一张任务 DAG。

   agent 会先问几个澄清问题，写 `docs/PRD.md` / `docs/TECH_SPEC.md`，然后跑 `orca orchestration run-create` + `task-create --deps …`。建完会告诉你 **Run id**（形如 `run_ab12cd34ef56`）。

4. **在顶栏下拉框选中** agent 刚报的那个 Run。DAG 出现并每 2 秒刷新 —— 你可以继续和 agent 聊着调整计划，看节点实时长出来。

5. **选 harness。** 设置工具条上的 **Default harness**（所有节点的兜底），需要的话再点单个节点覆盖它的 harness/模型。设好 **Max parallel**。

6. **点「▶ Run with Orca」**，确认弹窗（它会说明 viewer 将接管该 Run 的 coordinator，你的 agent 终端会被 fence —— 这是预期行为）。ready 任务并行开跑；执行中的节点出现蜡笔涂鸦；worker 回报 `worker_done` 后整张图逐步推进。

7. **审批门弹出时处理它。** 计划里有审批门的话，到点会在 DAG 上浮出批准/驳回按钮。

8. **要改计划？** 回到 agent 对话。它用 `orca orchestration run-use --id <run>` 抢回绑定（或干脆开个新 Run 重绘），viewer 会跟着刷新。改完再点一次 Run。

## viewer 能做什么

- **实时可视化** DAG，节点状态 `pending / ready / dispatched / completed / failed / blocked` 映射颜色；每个节点角上标着它的 harness。
- **布局算法切换**：顶栏 "Layout" 段控可切**横向/纵向分层**（dagre / Sugiyama）与**力导向**（Fruchterman–Reingold）；**↻ Re-layout** 一键重新自动布局（清除手动拖拽）。选择会持久化。
- **拖拽布局**：节点可自由拖动，位置在实时轮询刷新中保持不变（只有你没动过的节点跟随自动布局）。
- **执行动画**：`dispatched`（执行中）节点用蜡笔斜纹从左上到右下一遍遍「涂鸦」；从执行中节点流出的连线先是游动的虚线草稿，再有铅笔笔触从本节点向下游一遍遍「描」成实线。
- **每节点选 harness**：点节点在面板里选 `claude / kimi / opencode / grok / codex` 或自定义命令（持久化到 workspace 的 `.orca-dag.config.json`）；没单独设的节点用顶栏的**默认 harness** 兜底。
- **每节点选模型**：支持的 harness 才有 —— opencode 用 `opencode models` 枚举出下拉框；claude / codex / cursor 是自由文本（通过 `worker-start --model` 传入）。其余 harness 用各自的默认模型。
- **▶ Run with Orca / ⏹ Stop** + **Max parallel**：启动/停止 viewer 内置的自驱动 coordinator；worker 数由 DAG 并行度决定（能并行就并行，受 "Max parallel" 上限约束）、按需拉起、空闲复用、跑完回收 —— **不用手动加 worker**。执行中显示 "N workers"。
- **审批门**：agent `gate-create` 后，DAG 上浮出批准/驳回按钮。
- **节点详情（只读 spec）**：点节点看 spec / 状态 / 结果。改描述或依赖 → 让 agent 重绘 DAG。
- **手绘蜡笔风**：🖍️ SVG feTurbulence 波动描边 + 米色速写本画布。

## HTTP 接口

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/api/dag?run=<id>` | 该 Run 的 DAG：`{ runId, nodes, edges, gates, generatedAt }` |
| `GET` | `/api/runs` | 列出编排 Run |
| `POST` | `/api/runs` | `{ objective }`：新建一个 Run（走一次性 coordinator 终端） |
| `GET` | `/api/terminals` | 列出 Orca 终端 |
| `POST` | `/api/run` | `{ runId, harnessByTask?, modelByTask?, defaultHarness?, maxConcurrency? }`：启动自驱动 coordinator |
| `POST` | `/api/run-stop` | 停止 coordinator 并回收已拉起的 worker |
| `GET` | `/api/run-status` | coordinator 实时状态：`{ running, busy, attempts, error, … }` |
| `POST` | `/api/gates/:id/resolve` | `{ resolution, runId }`：解决审批门 |
| `POST` | `/api/reset` | `{ confirmAllRuns: true }`：`orca orchestration reset --tasks` —— 清空**所有** Run 的任务 |
| `GET` | `/api/models/:harness` | 该 harness 可选的模型（目前只有 opencode 能枚举） |
| `GET` | `/api/config` | viewer 配置（harness/模型选择、最多并行、布局、上次的 Run），存在 workspace 的 `.orca-dag.config.json` |
| `PUT` | `/api/config` | 合并写入 viewer 配置 |
| `GET` | `/api/health` | 健康检查（返回 workspace 目录） |

## 代码结构

```
skill/SKILL.md            建图规范 + spec 写作约定 + 如何执行（选 harness + Run）+ 边界
server/src/
  index.ts                Express：dag / runs / run / run-stop / run-status / gates / reset / models / config；托管 SPA
  coordinator.ts          自驱动 coordinator 循环：轮询 DAG，用 worker-start 并行派发 ready 任务
  orca.ts                 orca CLI 封装：task-list→DAG、worker-start/legacy/opencode worker、门、终端、模型
  config.ts               viewer 配置持久化：workspace 下 .orca-dag.config.json 的读写（/api/config）
  skill.ts                启动时把 skill/SKILL.md 装进本机的各个 agent
  uninstall.ts            `orca-dag uninstall`：skill.ts 的严格镜像，外加清理残留终端
  webAssets.ts            编译期内嵌前端资源（以及 skill）的加载器
web/src/
  App.tsx                 全宽 DAG 主壳、每 2s 轮询、手绘 SVG filter 定义
  components/DagView.tsx     React Flow 图 + 状态节点（含 harness 标签、蜡笔动画）
  components/ExecControls.tsx 默认 harness + 最多并行 + Run/Stop + 实时状态
  components/NodePanel.tsx    节点详情 + 每节点 harness 与模型选择
  components/GatePanel.tsx    审批门浮层
  components/RunPicker.tsx    Run 选择器 + 新建 Run
  components/DoodleSelect.tsx 手绘风下拉框（portal 弹层、搜索、键盘导航）
  harness.ts                响应式配置 store：每节点 harness/模型 / 默认 harness / 最多并行 / 布局（/api/config 持久化）
  layout.ts                 布局算法：dagre 分层（LR/TB）+ 力导向（Fruchterman–Reingold）
  types.ts / api.ts
scripts/
  build-binary.mjs        vite build → 内嵌资源和 skill → bun --compile → dist/orca-dag
  build-npm.mjs           vite build → esbuild 打包 server → dist-npm/（可发布的 `orca-dag` 包）
  build-all-binaries.sh   全部 Bun target + 压缩 + 校验和（release workflow 跑的就是它）
  check-skill.mjs         守住 SKILL.md 的 frontmatter —— skills CLI 靠它识别安装
  release.mjs             `npm run release <version>`：检查、打 tag、推送，剩下交给 CI
```

## 设计说明与边界

- **大脑外移**：规划由你已有的 agent 承担（skill 提供规范），viewer 不内嵌 Claude Agent SDK。
- **viewer 自己当 coordinator**：Orca 故意不做调度器，所以 `server/src/coordinator.ts` 用 Orca 的 Run/Task/Dispatch 原语自己驱动循环。并行度由 DAG 决定（同时 ready 的任务一起派，受 `maxConcurrency` 上限）；worker 按需拉起、空闲复用、跑完回收。
- **worker 必须是自主 agent**：hands-off 执行要求 worker 能自己跑 `orca orchestration send --type worker_done` 回报 —— 否则会卡在权限确认。`worker-start` 会带各 TUI agent 的免审批开关启动；自定义命令走 legacy 路径，用 `orca.ts` 的 `HARNESS_LAUNCH`（目前只验证过 `claude --dangerously-skip-permissions`，其余 harness 需各自填好并验证）。
- **`dispatch --inject` 的坑**（legacy 路径）：它把 preamble 打进 agent 输入框，但常常**不自动提交**（就绪竞态）。coordinator 因此在 dispatch 后停 ~2s 再补发一个 Enter；对已提交/空输入的多余 Enter 是无害 no-op。
- **opencode 走单独的路径**：`worker-start --agent opencode` 能打开 TUI 但注入的 preamble 落不进去，所以 coordinator 开一个裸 shell、铸一个跟踪用 dispatch，然后跑 `opencode run --auto "$(cat <preamble>)"`（**`--auto` 必须带** —— 默认权限策略会静默拒掉工具调用）。
- **每节点 harness/模型存 workspace 配置文件**：Orca 的 task 没有 harness/metadata 字段（`task-create` 只有 spec/title/display-name/deps/parent），所以 viewer 把 harness 与模型选择、最多并行、布局存到 workspace 根的 `.orca-dag.config.json`（`server/src/config.ts`，`GET/PUT /api/config`），换浏览器 / 清 localStorage 都不丢；前端 `harness.ts` 是响应式 store，启动时从服务器加载并把旧的 localStorage 值一次性迁移上去。Run 时以 `harnessByTask` / `modelByTask` 传给后端。
- **改不了已建任务**：`orca orchestration task-update` 只能改 `--status` / `--result`，**没有改 spec/标题/依赖的接口**，也没有删除单个任务的命令（`reset` 是整体清空，且波及所有 Run）。所以"修改任务"= **让 agent 开新 Run 重绘 DAG**。
