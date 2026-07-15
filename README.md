# Orca Orchestration Studio

一个基于 **Claude Agent SDK** 的界面：**以与 Claude 的对话为入口**做需求规划，Claude 把执行计划拆解成 **Orca orchestration 任务 DAG**，右侧**实时可视化**这张 DAG 并随任务状态变色。

聚焦"规划 + DAG 可视化"：Claude 负责把任务、依赖、审批门建进 Orca 编排状态；界面负责实时把它画出来。

视觉上提供两套可切换的手绘主题（顶栏 🖍️蜡笔 / ✏️涂鸦，记忆到 localStorage），把"在纸上画计划"的隐喻贯彻到底：

- **🖍️ 蜡笔**：暖色纸纹 + 圆点画布、站酷快乐体、彩色蜡笔手绘抖动边框、图钉便签式审批门。
- **✏️ 涂鸦**：方格笔记本纸、Kalam 手写体、黑墨钢笔描边 + 更粗手抖、黑墨箭头（Excalidraw 白板气质）。

![清新蜡笔风：左侧与 Claude 聊天，右侧手绘风实时任务 DAG](docs/screenshot.png)

![涂鸦风：方格纸 + 黑墨钢笔描边的同一张 DAG](docs/screenshot-doodle.png)

## 它是怎么工作的

```
┌──────────────────────┐        Claude Agent SDK (query)         ┌───────────────┐
│  浏览器 (web/, React) │ ──POST /api/chat (SSE 流式)──▶ server ──▶│  claude 订阅   │
│  · 聊天面板           │ ◀──text / tool / done 事件──            │  (无需 API Key)│
│  · React Flow DAG     │                                         └───────┬───────┘
│                       │                                    Bash: orca …  │
│                       │ ──GET /api/dag (每 2s 轮询)──▶ server ──▶ orca orchestration
│                       │ ◀── {nodes, edges, gates} ──         task-list --json
└──────────────────────┘
```

1. 你在左侧描述需求。后端用 Claude Agent SDK 的 `query()` 驱动一个"编排协调员"角色的 Claude，通过 **Bash 直接调用 `orca orchestration` CLI** 来创建任务与依赖。
2. Claude 每次运行的 orca 命令会作为 `tool` 事件推给前端，显示成工具芯片。回复文本以 SSE 流式返回。
3. 前端每 2 秒轮询 `GET /api/dag`，后端把 `orca orchestration task-list --json` 转成 `{nodes, edges}`（依赖来自每个 task 的 `deps` 字段），用 **dagre** 自动布局、**React Flow** 渲染。任务状态 `pending / ready / dispatched / completed / failed / blocked` 映射为节点颜色，实时更新。
4. 需要人工审批时，Claude 会 `orca orchestration gate-create`，DAG 上浮出"批准/驳回"按钮，点击调用 `gate-resolve`。

对话通过 SDK 的 `resume`（session id）跨 HTTP 请求续接，所以是连续多轮对话。

## 前置条件

- **Node.js ≥ 20**（本项目在 v22 上验证）
- **Orca 桌面/运行时在运行**：`orca status --json` 应返回 `runtime.state = "ready"`。若未启动：`orca open`
- **已登录的 `claude` CLI**：SDK 复用 Claude Code 的订阅登录，**无需设置 `ANTHROPIC_API_KEY`**（若设置了也会被使用）
- **Bun**（可选，仅在 `npm run build:binary` 打单文件二进制时需要）

## 快速开始

```bash
# 1. 安装依赖（npm workspaces，一次装全部）
npm install

# 2. 启动开发环境（同时起后端 8787 + 前端 5173，vite 代理 /api）
npm run dev

# 3. 打开 http://localhost:5173
```

生产模式（单端口）：

```bash
npm run build      # 构建前端到 web/dist
npm start          # 后端在 8787 同时托管 SPA 与 /api
# 打开 http://localhost:8787
```

## 打包成单文件二进制（在任意项目里调用）

把前端 + 后端 + Claude Agent SDK 编译成一个 **自包含的 Bun 二进制**，之后可以 `cd` 到任何项目目录直接运行，用 **那个目录**当工作区：

```bash
npm run build:binary          # 产出 dist/orca-studio（约 60 MB）

cd ~/some/other/project
/path/to/dist/orca-studio     # 起在 http://localhost:8787，自动打开浏览器
# 这个项目目录即 Claude 运行 orca / 写 PRD、TECH_SPEC 的工作区
```

- **前端资源已内嵌**进二进制（`web/dist` 在编译期被打成 base64 一起打包），所以单文件即可运行、无需附带任何资源目录。
- **仍依赖两个外部 CLI**（二进制只是复用它们，不内置）：
  - **`claude`**（已登录）：复用 Claude Code 订阅登录做鉴权。编译后的二进制无法用 SDK 默认方式定位自带的原生 CLI，因此运行时会从 `PATH` 解析 `claude` 并传给 SDK 的 `pathToClaudeCodeExecutable`。可用 `CLAUDE_CLI_PATH` 覆盖。
  - **`orca`**：编排命令照常通过子进程调用。
- **交叉编译**到别的平台（目标机同样需要自带 `claude` + `orca`）：
  ```bash
  TARGET=bun-linux-x64   npm run build:binary
  TARGET=bun-windows-x64 npm run build:binary
  ```
- 常用开关：`PORT`（默认 8787）、`NO_OPEN=1`（不自动打开浏览器）、`WORKSPACE_DIR`（覆盖工作区，默认取启动时 `cwd`）。

## 试一试

在左侧输入，例如：

> 帮我规划一个多人协作的待办事项 SaaS 的 MVP

Claude 会澄清需求、给方案，并逐步创建任务与依赖 —— 右侧 DAG 会实时长出来。也可以直接下达：

> 把它拆成 setup → models →（api、frontend 并行）→ integration 的任务 DAG

## 配置（环境变量）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 后端端口 |
| `WORKSPACE_DIR` | 启动时的 `cwd` | Claude 运行 orca / 写 PRD、TECH_SPEC 文档的工作目录 |
| `DEBUG_SDK` | — | 设为任意值可把 SDK stderr 打到服务端日志 |

## HTTP 接口

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `POST` | `/api/chat` | 一轮对话，SSE 流：`event: text/tool/done/error`。请求体 `{ message, sessionId }` |
| `GET` | `/api/dag` | 当前 DAG：`{ nodes, edges, gates, generatedAt }` |
| `POST` | `/api/gates/:id/resolve` | 解决审批门，请求体 `{ resolution }` |
| `POST` | `/api/reset` | `orca orchestration reset --tasks` 清空任务 |
| `GET` | `/api/health` | 健康检查 |

## 代码结构

```
server/src/
  index.ts          Express 服务：SSE 聊天、DAG、审批、reset；生产时托管 SPA
  claude.ts         Claude Agent SDK 驱动：流式文本、抽取工具调用、session 续接
  systemPrompt.ts   "编排协调员" 系统提示词（三阶段工作流 + orca 命令用法 + 边界）
  orca.ts           orca CLI 封装 + task-list → DAG(nodes/edges) 转换
web/src/
  App.tsx           两栏主壳、每 2s 轮询 DAG、节点详情面板
  components/Chat.tsx      流式聊天 + 工具芯片
  components/DagView.tsx   React Flow 图 + 自定义状态节点 + minimap
  components/GatePanel.tsx 审批门浮层
  layout.ts         dagre 自动布局（确定性，状态刷新不抖动）
  types.ts / api.ts 共享类型 / SSE 客户端
```

## 设计说明与边界

- **驱动方式**：Claude 通过 Bash 直接调 `orca` CLI（解耦清晰：界面只需轮询 `task-list` 即可反映 DAG 变化）。系统提示词把它约束在编排命令 + 规划文档写作上，`permissionMode: "bypassPermissions"` 让本地单用户工具免去逐条授权。这是本地开发工具的取舍——如需更强隔离，可改用 `canUseTool` 白名单或 `PreToolUse` hook。
- **不含执行阶段**：本界面负责建 DAG（任务/依赖/审批门），**不会**自动 `dispatch`/`run` 去拉起 worker 终端。若要真正跑执行（派发给 kimi/opencode、`orca orchestration run` 自动 coordinator），可在此基础上加一层执行编排——`orca.ts` 已封好 `runOrca()`，接 `dispatch` / `check --wait` / `run` 即可。
- **不继承全局配置**：SDK 以 `settingSources: []` 启动，不会把机器上的全局 `CLAUDE.md` / settings 带进协调员。

### 视觉主题：两套可切换的手绘风

顶栏切换器在 `🖍️蜡笔` / `✏️涂鸦` 间切换，写入 `localStorage`。实现是一套 `data-theme` + CSS 变量覆盖：同一份 DAG 标记，两种画法，无需改组件。

- **共用签名元素**：`web/src/App.tsx` 的 SVG `feTurbulence`+`feDisplacementMap` 滤镜给节点边框（`.task-node::before`）和依赖线（`.react-flow__edge-path`）加手绘抖动。蜡笔用 `#crayon`/`#crayon-edge`（柔和），涂鸦用 `#doodle`/`#doodle-edge`（更粗、频率更高的钢笔抖）。调幅度改滤镜的 `scale`。
- **🖍️ 蜡笔**：纸 `#FCFAF4` + 石墨墨 `#4A4754`；状态蜡笔色见 `web/src/types.ts` 的 `STATUS_META`；圆点画布、彩色描边、贴纸按钮。拉丁用 **Fredoka**，**所有中文**（标题与正文）用 **站酷快乐体**。
- **✏️ 涂鸦**：纸 `#FBFBF7` + 钢笔墨 `#2C2A30`；保留状态浅填充但改**黑墨描边**；方格线画布、黑墨箭头、墨线分隔（`styles.css` 里的 `:root[data-theme="doodle"]` 与 `[data-theme="doodle"] …` 覆盖块）。拉丁用 **Kalam**，**所有中文**用 **站酷庆科黄油**。
- **字体统一**：`--font-body` 的字体栈把 CJK 手绘字体排在拉丁字体之后，浏览器逐字回落，于是拉丁走手写体、每个汉字走对应主题的手绘体 —— 正文不再回落到系统黑体。
- **动效**：消息气泡入场、工具芯片滑入、DAG 节点弹入（`node-in`，靠 `backwards` 填充只播一次且不破坏 hover）；流式时「思考」是三颗弹跳点，正文尾部跟一个闪烁光标。全部在 `prefers-reduced-motion` 下自动关闭；键盘 `:focus-visible` 可见。
