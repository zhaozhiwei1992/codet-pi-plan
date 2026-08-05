# codet-pi-plan

给 Pi Coding Agent 加一个 `/plan` 命令：**只读探索**当前项目的影响面，在**项目根目录**生成一份结构化变更计划 `PLAN-<slug>.md`（与 `AGENTS.md` 同级）。完成后自动进入 **PLAN 状态**——模型按计划逐步执行，每完成一步用 `[DONE:n]` 标记；不需要每次手动 `/implement`，要中途退出运行 `/plan-end`。

## 行为基础（两条设计原则）

1. **PLAN 状态下一切以 `pi-plan` skill 为唯一行为基础**：规划（只读探索 + 输出契约）和执行（第 4 步逐步推进、`[DONE:n]` 约定、不偏离计划）的**规则全部写在 `skills/pi-plan/SKILL.md`** 里。扩展层只做状态机机制（写/清状态文件、屏蔽 `edit`/`write`/非只读 `bash`、跟踪 `[DONE:n]` 进度、每回合注入最小激活 + 动态进度数据），**不重复定义行为规则**。
2. **默认状态以官方 agent/skill 行为为主**：非 PLAN 状态扩展不干预——不改 systemPrompt、不改工具集、不拦截任何工具。只有 `inPlanMode=true` 时才注入最小约束、屏蔽写工具。`/plan` 也只是路由到 `/skill:pi-plan`，探索阶段完全由 skill 驱动。

## 两条使用路径

| 路径 | 触发方式 | 行为 |
|------|---------|------|
| **主动规划** | `/plan <task>` | 只读探索 → 写 `PLAN-<slug>.md` → 自动进入 PLAN 状态按步执行 |
| **自动规划** | agent 收到变更任务，先派 `/skill:pi-plan` 规划再动手 | 同上 |

## 安装

```bash
pi install ./codet-pi-plan          # 本地
pi install npm:codet-pi-plan         # npm（发布后）
```

> 需在 `settings.json` 设 `"enableSkillCommands": true`。

## 命令

| 命令 | 说明 |
|------|------|
| `/plan <task>` | 只读探索并写 `PLAN-<slug>.md`，自动进入 PLAN 状态 |
| `/plan`        | 不带任务 → Skill 从上文对话提取；都没有会追问 |
| `/plan-status` | 查看当前 PLAN 状态与进度 |
| `/plan-end`    | 退出 PLAN 状态，恢复默认工具集（计划文件保留） |

## 选择性规划（何时用 /plan）

`/plan` 是**用户主动要结构化计划**时的入口。agent 平时按 AGENTS.md 的规划规则自行判断：

- 🚩 **先规划**（`/plan` 或 `/skill:pi-plan`）：跨多文件/模块、核心逻辑、数据迁移、依赖升级、不熟悉的改动
- ⚡ **直接做**：单文件小 bug、小功能、样式/文案、参数调整

规则片段见 `templates/AGENTS-planning-rules.md`，复制到项目 `AGENTS.md` 即可启用。这样 agent 不会为小任务强制走 plan skill（官方 agent/skill 行为为主）。

## PLAN 状态机制

进入 PLAN 状态后，扩展做四件事，确保模型**按计划执行、不乱改**：

1. **写状态文件** `.pi/active-plan.json`（含 `sessionId` / `slug` / `planFile` / `steps`）—— 退出时清掉
2. **屏蔽写工具**：`edit`/`write` 被拦，`bash` 非只读命令被拦
3. **每回合注入约束**：`before_agent_start` 注入最小激活（声明 PLAN 状态 + 剩余步骤 + 引用 pi-plan skill 执行阶段），不重复规则
4. **进度跟踪**：`turn_end` 扫回复里的 `[DONE:n]`，更新 `steps[n-1].completed`；**全完成自动退出并删除 `PLAN-<slug>.md`（完成即删）**

> resume 进入同一 session 自动恢复 PLAN 状态；session 切换则不自动激活，避免互相干扰。

## 用法

```bash
cd my-project
pi
/plan 把登录改成 JWT
# → 🧭 调用 pi-plan Skill ...
# → 🐱 PLAN-login-jwt.md 已写入
# → 🏃 进入 PLAN 状态：按 PLAN-login-jwt.md 第 4 步逐步执行 ...
# （之后每回合自动按计划推进；模型每完成一步回复 [DONE:n]）
# → 🎉 计划全部完成，自动退出 PLAN 状态
# → 🗑️ 已删除 PLAN-login-jwt.md（完成即删）

# 中途想取消 → /plan-end（计划文件保留，方便续做）
# 中途看进度 → /plan-status
```

`PLAN-<slug>.md` 在计划期间与 `AGENTS.md` 同级，完成后自动删除：

```
my-project/
├── AGENTS.md
├── PLAN-login-jwt.md     # 计划期间存在，全部完成后自动删
└── .pi/active-plan.json  # PLAN 状态文件，退出后自动清
```

## Skill 行为约束

规则全在 `skills/pi-plan/SKILL.md`，分两个阶段：

### 只读探索阶段（写 PLAN 之前）
- 只能用只读工具：`read` / `grep` / `glob` / `ls` / `tree` / `find` / `git status|log|diff`
- 🚫 禁止：`write`/`edit` 源码、`rm`、`git push`、`git commit`、`npm install` 等任何写副作用命令
- 唯一允许写：项目根目录的 `PLAN-<slug>.md`

### 执行阶段（进入 PLAN 状态之后）
- 只执行 `PLAN-<slug>.md` 第 4 步的实施步骤，逐条推进，不添加/删减/调序
- 每完成一步在回复里写 `[DONE:n]`；已完成步骤不重复做
- 严格限制改动范围：只改计划里列到的文件/逻辑，计划外一律不动，拿不准先问
- 每步做完跑第 5 步验证命令，失败先修再继续
- 全部完成写一句总结即停，扩展自动退出 PLAN 状态

## 计划文件章节

`PLAN-<slug>.md` 含 7 章节（顺序固定）：

1. 背景与目标（含验收标准）
2. 现状（只读探索结果，附 `path/to/file.ts:行号`）
3. 方案与取舍（≥2 个备选，⭐ 推荐 + 理由）
4. **实施步骤**（有序、`1. ...` 2. ...` 3. ...` 编号列表 —— 扩展从这里抽步骤做进度跟踪）
5. 验证（真实测试/构建命令，从项目配置取）
6. 风险与回滚
7. 交接给执行状态的提示

## 许可

MIT License