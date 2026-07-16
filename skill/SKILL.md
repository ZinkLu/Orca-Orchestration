---
name: orca-dag
description: "Plan software work as an Orca orchestration task DAG. Use when the user wants to break a feature or project into an executable graph of tasks with dependencies and approval gates in Orca, then visualize and fire it. Teaches the exact `orca orchestration` CLI commands to build the DAG, the spec-writing conventions, and how to open the orca-dag viewer so the user can pick a harness per node and fire tasks."
---

# orca-dag

把一个软件需求，通过对话逐步细化，并落地成 **Orca orchestration 的一张任务 DAG**（有向无环图）。你负责**建图与调图**；**执行（fire）由用户在 `orca-dag` viewer 里手动逐节点触发**（选 harness → fire）。

你每一次规划的产出都**必须写进 Orca 的编排状态**（跑 `orca orchestration` 命令），而不是只停留在聊天文字里 —— 因为 viewer 会实时轮询 Orca 并把这张 DAG 画出来。

## 你可以用的工具
- **Bash** 跑 `orca` CLI 读写编排状态。
- **Read / Write / Edit** 在当前工作目录写规划文档（`docs/PRD.md`、`docs/TECH_SPEC.md`）。
- 不要执行与本任务无关的破坏性命令（`rm`、`git push`、删文件等）。

## 开工前检查
```bash
orca status --json      # result.runtime.state 应为 "ready"；若否，提示用户先 `orca open`
```

## 工作流（三阶段，都在对话中完成）
1. **需求澄清（PRD）**：用简短问题对齐目标、MVP 范围、明确排除项。一次只问 1 个最关键的问题。只要 MVP 就只规划 P0，不过度设计。达成一致后写入 `docs/PRD.md`。
2. **技术方案（TECH_SPEC）**：技术栈、数据模型（到字段）、模块接口（伪代码）。写入 `docs/TECH_SPEC.md`。
3. **拆解为任务 DAG**：把方案拆成可并行/串行的子任务，用下面的命令建任务与依赖。**这一步是必须产出。**

## 如何把 DAG 写进 Orca（核心）
逐条创建任务；任务间依赖用 `--deps` 传一个 **JSON 数组**（元素是被依赖任务的 id）。

根任务（无依赖）：
```bash
orca orchestration task-create \
  --task-title "初始化项目" \
  --spec "初始化项目结构与依赖，产出 package.json、src/、.gitignore；验收：npm test 能运行" \
  --json
```
返回 JSON 里 `result.task.id` 就是任务 id（形如 `task_xxxxxxxx`）。

依赖前序任务（把前序 id 放进 `--deps`）：
```bash
orca orchestration task-create \
  --task-title "实现数据模型" \
  --spec "按 TECH_SPEC 数据模型实现 models 与迁移；验收：迁移可运行、含单测" \
  --deps '["task_c8df9d97"]' --json
```
依赖多个：`--deps '["task_aaa","task_bbb"]'`。

**务必记住每个任务返回的 id**，用于后续任务的 `--deps`，从而构建出正确的 DAG。建完一批后自检：
```bash
orca orchestration task-list --json     # 核对依赖是否正确
```

### spec 写作规范（很重要）
每个子任务的 `--spec` 都要**自包含、可独立执行**，让未来的执行 agent **不需要反问、不需要进入 plan 模式**：
- **输入**：依赖了什么、读哪些文件/接口。
- **产出**：要创建/修改哪些文件，交付物是什么。
- **验收标准**：怎样算完成（能跑的测试、可观察的行为）。
- 用祈使句，避免"研究一下""看情况"这类模糊表述。

## 需要人工审批时
在关键节点（如"方案是否批准进入执行"）建一个决策门，它会阻塞对应任务，viewer 上会浮出"批准/驳回"：
```bash
orca orchestration gate-create \
  --task <task_id> \
  --question "是否批准 TECH_SPEC 进入执行阶段？" \
  --options '["approved","rejected"]' --json
```

## 建好 DAG 后：打开 viewer 让 Orca 执行
DAG 有了雏形就让用户打开 viewer：
```bash
orca-dag        # 在当前项目目录运行；起在 http://localhost:8787 并自动开浏览器
```
viewer 里用户的操作是：**实时看 DAG** → **给每个节点选 harness**（claude / kimi / opencode / grok …，或用默认兜底）→ 点 **「▶ 让 Orca 执行」** → **viewer 内置的 coordinator 按依赖把 ready 任务并行派给按需拉起的自主 worker、等 `worker_done`、推进整张图** → **处理审批门**。

也就是说：**执行由 viewer 接管,不是你手动派发。** 你的职责到"把 DAG 建对"为止。

你和用户可以**一边在对话里继续调整 DAG**（增删任务、改依赖、加门），viewer 会实时反映。**默认不要自己去 `orca orchestration dispatch` / `run`**，那是 viewer 在做，除非用户明确要求你在命令行里跑。

## 边界与已知约束
- 聚焦**规划 + 建图**。执行交给 viewer（coordinator）。
- **改不了已建任务的描述**：`orca orchestration task-update` 只能改 `--status` / `--result`，**没有改 spec/标题/依赖的接口**，也没有删除单个任务的命令（只有 `orca orchestration reset --tasks` 整体清空）。**所以要改某个任务或依赖，就重绘 DAG**：`orca orchestration reset --tasks` 清空后按新计划重建（会换 task id）。建图时尽量一次写对。
- 不执行破坏性或与规划无关的系统命令。

## 交流风格
- 跟随用户语言（默认中文）。简洁、直接。
- 每建/改一批任务后，用一句话小结当前 DAG 形状（哪些并行、哪些串行），因为用户会在 viewer 里同步看到它们出现。
