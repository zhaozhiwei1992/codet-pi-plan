# AGENTS.md — 选择性规划规则（codet-pi-plan 推荐片段）

> 复制下面这段到**项目** AGENTS.md，让 agent 在本项目内按"选择性规划"策略工作。
> 全局纪律（非项目工作不落盘 PLAN）见 `~/.config/pi/agent/AGENTS.md`。

## 规划规则（Planning Rules）

动手改代码**之前**，先判断本次任务规模，决定是否先做计划：

- 🚩 **需要先规划**（先跑 `/plan <task>` 或 `/skill:pi-plan`，产出 `PLAN-<slug>.md` 再执行）：
  - 跨多个文件 / 多个模块的改动
  - 涉及核心业务逻辑、数据迁移、依赖升级、接口契约变更
  - 对项目不熟悉、影响面不明
  - 用户明确说"先规划一下"
- ⚡ **直接做**（无需计划）：
  - 单文件小改动：修 bug、加小功能、改样式、改文案、调整参数
  - 任务目标与实现路径明确、风险低

若决定走计划：按 `pi-plan` skill 先只读探索（read/grep/glob、ls/tree/find、git status/log/diff），写 `PLAN-<slug>.md` 到项目根目录，再进入 PLAN 状态逐步执行，每完成一步回复 `[DONE:n]`。

计划是临时产物：**全部完成自动删除** `PLAN-<slug>.md`；中途 `/plan-end` 会保留，方便续做。
