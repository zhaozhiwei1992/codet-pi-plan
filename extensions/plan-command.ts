/**
 * codet-pi-plan — 薄桥接 + PLAN 状态机扩展
 *
 * 三条命令：
 *  - /plan <task>    路由到 /skill:pi-plan 让模型只读探索、写 PLAN-<slug>.md；
 *                    agent_end 检测到 PLAN 文件被写后自动进入 PLAN 状态
 *  - /plan-end       退出 PLAN 状态，恢复默认工具集
 *  - /plan-status    查看当前 PLAN 状态与进度
 *
 * PLAN 状态机制（路线 A）：
 *  - 写 .pi/active-plan.json（含 sessionId/slug/steps/createdAt），退出时清掉
 *  - 屏蔽 edit/write 工具；bash 拦截非只读命令
 *  - before_agent_start 每回合把"按 PLAN-x.md 执行 + [DONE:n] 进度"追加到 systemPrompt
 *  - turn_end 扫回复里的 [DONE:n] 标记，更新 steps；全完成自动 /plan-end
 *  - session_start：若状态文件 sessionId 匹配当前 session，恢复 PLAN 状态（resume 也生效）
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const STATE_DIR = ".pi";
const STATE_FILE = join(STATE_DIR, "active-plan.json");
const DISABLED_TOOLS = new Set(["edit", "write"]);

// ==== 只读 bash 白名单 ====

const DESTRUCTIVE_RE = [
  /\brm\b/i, /\brmdir\b/i, /\bmv\b/i, /\bcp\b/i, /\bmkdir\b/i, /\btouch\b/i,
  /\bchmod\b/i, /\bchown\b/i, /\btee\b/i, /\bdd\b/i, /\bshred\b/i,
  /(^|[^<])>(?!>)/, />>/,
  /\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
  /\byarn\s+(add|remove|install|publish)/i,
  /\bpnpm\s+(add|remove|install|publish)/i,
  /\bpip\s+(install|uninstall)/i,
  /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|stash|cherry-pick|revert|tag|init|clone)/i,
  /\bsudo\b/i, /\bkill\b/i, /\breboot\b/i, /\bshutdown\b/i,
  /\b(vim?|nano|emacs|code|subl)\b/i,
];

const SAFE_RE = [
  /^\s*cat\b/, /^\s*head\b/, /^\s*tail\b/, /^\s*less\b/, /^\s*more\b/,
  /^\s*grep\b/, /^\s*egrep\b/, /^\s*fgrep\b/, /^\s*zgrep\b/,
  /^\s*find\b/, /^\s*ls\b/, /^\s*pwd\b/, /^\s*echo\b/, /^\s*printf\b/,
  /^\s*wc\b/, /^\s*sort\b/, /^\s*uniq\b/, /^\s*diff\b/, /^\s*file\b/,
  /^\s*stat\b/, /^\s*du\b/, /^\s*df\b/, /^\s*tree\b/, /^\s*which\b/,
  /^\s*env\b/, /^\s*printenv\b/, /^\s*uname\b/, /^\s*whoami\b/, /^\s*id\b/,
  /^\s*date\b/, /^\s*cal\b/, /^\s*uptime\b/, /^\s*ps\b/,
  /^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
  /^\s*git\s+ls-/i,
  /^\s*npm\s+(list|ls|view|info|outdated|audit)/i,
  /^\s*yarn\s+(list|info|why|audit)/i,
  /^\s*node\s+--version/i, /^\s*python(3)?\s+--version/i,
  /^\s*curl\s/i, /^\s*jq\b/, /^\s*sed\s+-n/i, /^\s*awk\b/,
  /^\s*rg\b/, /^\s*fd\b/, /^\s*bat\b/, /^\s*eza\b/,
];

function isSafeCommand(cmd: string): boolean {
  if (DESTRUCTIVE_RE.some((r) => r.test(cmd))) return false;
  return SAFE_RE.some((r) => r.test(cmd));
}

// ==== 状态文件 ====

interface PlanStep {
  step: number;
  text: string;
  completed: boolean;
}

interface PlanState {
  sessionId: string;
  slug: string;
  planFile: string;
  steps: PlanStep[];
  createdAt: number;
  toolsBefore: string[];
}

function readState(cwd: string): PlanState | undefined {
  const p = join(cwd, STATE_FILE);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as PlanState;
  } catch {
    return undefined;
  }
}

function writeState(cwd: string, st: PlanState): void {
  const dir = join(cwd, STATE_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(cwd, STATE_FILE), JSON.stringify(st, null, 2));
}

function clearState(cwd: string): void {
  const p = join(cwd, STATE_FILE);
  if (existsSync(p)) {
    try {
      unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
}

// 从 PLAN-<slug>.md 的"## 4. 实施步骤"章节抽编号项
function extractSteps(planPath: string): PlanStep[] {
  const md = readFileSync(planPath, "utf-8");
  const m = md.match(/## 4\.\s*实施步骤[\s\S]*?(?=\n## |\n### 5\.|$)/i);
  if (!m) return [];
  const section = m[0];
  const steps: PlanStep[] = [];
  for (const mm of section.matchAll(/^\s*(\d+)[.、)]\s+(.+)$/gm)) {
    const text = mm[2]
      .trim()
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
      .replace(/\s+/g, " ")
      .slice(0, 80);
    const step = Number(mm[1]);
    steps.push({ step, text, completed: false });
  }
  return steps;
}

// 找 Skill 回合结束时新写的 PLAN-*.md（按 mtime 最近的）
function findLatestPlan(cwd: string, sinceMs: number): string | undefined {
  let newest: { f: string; mtime: number } | undefined;
  try {
    for (const f of readdirSync(cwd)) {
      if (!/^PLAN-[^/]+\.(md|markdown)$/i.test(f)) continue;
      const p = join(cwd, f);
      try {
        const s = statSync(p);
        if (s.isFile() && s.mtimeMs >= sinceMs && (!newest || s.mtimeMs > newest.mtime)) {
          newest = { f: p, mtime: s.mtimeMs };
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return newest?.f;
}

// 从 assistant 消息抽 [DONE:n] 标记
function extractDone(message: unknown): number[] {
  if (!message || typeof message !== "object") return [];
  const m = message as { role?: string; content?: unknown };
  if (m.role !== "assistant" || !Array.isArray(m.content)) return [];
  const out: number[] = [];
  for (const block of m.content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
      const t = (block as { text?: string }).text ?? "";
      for (const mm of t.matchAll(/\[DONE:(\d+)\]/gi)) {
        const n = Number(mm[1]);
        if (Number.isFinite(n)) out.push(n);
      }
    }
  }
  return out;
}

// ==== 扩展主体 ====

export default function codetPiPlanExtension(pi: ExtensionAPI): void {
  // 内存里的"是否在 PLAN 状态"，启动时按状态文件恢复
  let inPlanMode = false;
  let planState: PlanState | undefined;
  let skillStartedAt = 0;

  // 进入 / 退出
  function enterPlanMode(ctx: ExtensionContext, slug: string, planFile: string): PlanState {
    if (inPlanMode && planState) {
      // 已经在 PLAN 状态，刷新 steps
      planState.steps = extractSteps(planFile);
      writeState(ctx.cwd, planState);
      ctx.ui.notify(`🔄 已刷新计划步骤：${planState.steps.length} 步`, "info");
      updateStatus(ctx);
      return planState;
    }
    const toolsBefore = pi.getActiveTools().filter((t) => !DISABLED_TOOLS.has(t));
    planState = {
      sessionId: ctx.sessionManager.getSessionId(),
      slug,
      planFile,
      steps: extractSteps(planFile),
      createdAt: Date.now(),
      toolsBefore,
    };
    pi.setActiveTools(toolsBefore);
    writeState(ctx.cwd, planState);
    inPlanMode = true;
    ctx.ui.notify(`🏃 进入 PLAN 状态：按 ${planFile} 第 4 步逐步执行，每完成一步回复 [DONE:n]。运行 /plan-end 退出。`, "info");
    updateStatus(ctx);
    return planState;
  }

  function exitPlanMode(ctx: ExtensionContext, silent = false): void {
    if (!inPlanMode) {
      if (!silent) ctx.ui.notify("当前未处于 PLAN 状态。", "info");
      return;
    }
    if (planState) pi.setActiveTools(planState.toolsBefore.length ? planState.toolsBefore : ["read", "bash", "edit", "write"]);
    clearState(ctx.cwd);
    inPlanMode = false;
    planState = undefined;
    ctx.ui.setStatus("pi-plan", undefined);
    if (!silent) ctx.ui.notify("✅ 已退出 PLAN 状态，默认工具集恢复。", "info");
  }

  function updateStatus(ctx: ExtensionContext): void {
    if (inPlanMode && planState) {
      const done = planState.steps.filter((s) => s.completed).length;
      const total = planState.steps.length;
      const label = total > 0 ? `📋 ${done}/${total}` : "📋 plan";
      ctx.ui.setStatus("pi-plan", ctx.ui.theme.fg(total > 0 && done === total ? "success" : "accent", label));
    } else {
      ctx.ui.setStatus("pi-plan", undefined);
    }
  }

  // === 命令 ===

  pi.registerCommand("plan", {
    description: "只读探索影响面、生成 PLAN-<slug>.md，并自动进入 PLAN 状态按计划执行",
    handler: (args, ctx) => {
      const task = (args ?? "").trim();
      const invocation = `/skill:pi-plan${task ? `\n${task}` : ""}`;
      skillStartedAt = Date.now();
      if (ctx.isIdle()) {
        ctx.ui.notify("🧭 调用 pi-plan Skill，只读探索并由模型写 PLAN-<slug>.md...", "info");
        pi.sendUserMessage(invocation);
      } else {
        ctx.ui.notify("Agent 正忙，pi-plan Skill 已排队（稍后自动执行）。", "info");
        pi.sendUserMessage(invocation, { deliverAs: "followUp" });
      }
      return Promise.resolve();
    },
  });

  pi.registerCommand("plan-end", {
    description: "退出 PLAN 状态，恢复默认工具集",
    handler: (_args, ctx) => {
      exitPlanMode(ctx);
      return Promise.resolve();
    },
  });

  pi.registerCommand("plan-status", {
    description: "查看当前 PLAN 状态与进度",
    handler: (_args, ctx) => {
      const st = readState(ctx.cwd);
      if (!st) {
        ctx.ui.notify("当前未处于 PLAN 状态。运行 /plan <任务> 开始。", "info");
        return Promise.resolve();
      }
      ctx.ui.notify(`📄 计划：${st.planFile}（slug=${st.slug}）`, "info");
      if (st.steps.length === 0) {
        ctx.ui.notify("计划中未抽到编号步骤。", "warning");
      } else {
        const lines = st.steps.map((s) => `${s.completed ? "✓" : "○"} ${s.step}. ${s.text}`);
        const done = st.steps.filter((s) => s.completed).length;
        ctx.ui.notify(`进度 ${done}/${st.steps.length}:\n${lines.join("\n")}`, "info");
      }
      return Promise.resolve();
    },
  });

  // === 事件 ===

  // PLAN 状态下屏蔽 edit/write 与非只读 bash；并拦截其它写副作用工具
  pi.on("tool_call", async (event) => {
    if (!inPlanMode) return;
    const reason = `PLAN 状态：按 ${planState?.planFile ?? "PLAN-*.md"} 第 4 步逐步执行。要自动改源码请先运行 /plan-end 退出 PLAN 状态。`;
    if (DISABLED_TOOLS.has(event.toolName)) {
      return { block: true, reason };
    }
    if (event.toolName === "bash") {
      const cmd = (event as { input: { command: string } }).input.command;
      if (!isSafeCommand(cmd)) {
        return { block: true, reason: `${reason}\n被拦命令: ${cmd.slice(0, 120)}` };
      }
    }
    return;
  });

  // 每回合注入"PLAN 状态"最小激活：只声明状态 + 给动态进度数据；
  // 行为规则（按 PLAN-x 第 4 步执行、[DONE:n] 约定、不偏离计划等）全部由 pi-plan skill 的
  // "执行阶段"章节定义，扩展不重复写规则，保持"以 plan skill 为基础"。
  pi.on("before_agent_start", async () => {
    if (!inPlanMode || !planState) return;
    const st = planState;
    const remaining = st.steps
      .filter((s) => !s.completed)
      .map((s) => `${s.step}. ${s.text}`)
      .join("\n");
    const inject = `[pi-plan PLAN 状态] 你正处于 pi-plan 插件的 PLAN 执行状态。
请严格遵循 pi-plan skill 的"执行阶段"指令推进；当前计划文件：${st.planFile}
剩余步骤（已完成的不必再做，记得每完成一步在回复里写 [DONE:n]）：
${remaining || "(全部完成，回复总结即可，扩展会自动退出 PLAN 状态)"}`;
    return { systemPrompt: inject };
  });

  // 每回合结束抽取 [DONE:n] 更新进度；全完成自动退出
  pi.on("turn_end", async (event, ctx) => {
    if (!inPlanMode || !planState) return;
    const msg = event.message;
    const done = extractDone(msg);
    let changed = false;
    for (const n of done) {
      const s = planState.steps.find((x) => x.step === n);
      if (s && !s.completed) {
        s.completed = true;
        changed = true;
      }
    }
    if (changed) {
      writeState(ctx.cwd, planState);
      updateStatus(ctx);
      const all = planState.steps.length > 0 && planState.steps.every((s) => s.completed);
      if (all) {
        const planFile = planState.planFile;
        ctx.ui.notify("🎉 计划全部完成，自动退出 PLAN 状态。", "info");
        exitPlanMode(ctx, true);
        // 完成即删：计划是临时产物，活干完就没用了
        if (existsSync(planFile)) {
          try {
            unlinkSync(planFile);
            ctx.ui.notify(`🗑️ 已删除计划文件 ${planFile}（活已干完，无需保留）`, "info");
          } catch (err) {
            ctx.ui.notify(`⚠️ 无法删除计划文件 ${planFile}: ${String(err)}`, "warning");
          }
        }
      } else {
        const doneCount = planState.steps.filter((s) => s.completed).length;
        ctx.ui.notify(`✅ 进度 ${doneCount}/${planState.steps.length}`, "info");
      }
    }
  });

  // Skill 回合结束：检测 PLAN-*.md 被写则自动进入 PLAN 状态
  pi.on("agent_end", async (event, ctx) => {
    if (skillStartedAt === 0) return;
    const start = skillStartedAt;
    skillStartedAt = 0;
    const planFile = findLatestPlan(ctx.cwd, start);
    if (!planFile) return;
    const fname = planFile.split(/[\\/]/).pop() ?? planFile;
    const slug = fname.replace(/^PLAN-/i, "").replace(/\.(md|markdown)$/i, "");
    // 校验这个 plan 是不是 Skill 刚写的：读首行
    let firstLine = "";
    try {
      firstLine = readFileSync(planFile, "utf-8").split("\n")[0] ?? "";
    } catch {
      /* ignore */
    }
    if (!/^#\s*计划[:：]?/i.test(firstLine)) return;
    enterPlanMode(ctx, slug, planFile);
    void event;
  });

  // session_start：按状态文件恢复
  pi.on("session_start", async (_event, ctx) => {
    const st = readState(ctx.cwd);
    if (!st) return;
    if (st.sessionId !== ctx.sessionManager.getSessionId()) {
      // 不同 session：旧状态文件残留，提示用户但不自动激活，避免互相干扰
      ctx.ui.notify(
        `⚠️ 检测到上一次会话的 PLAN 状态残留（${st.planFile}）。本会话不自动恢复。要继续就 /plan <task>，要清除运行 /plan-end。`,
        "warning",
      );
      return;
    }
    inPlanMode = true;
    planState = st;
    if (planState.toolsBefore && planState.toolsBefore.length) {
      pi.setActiveTools(planState.toolsBefore.filter((t) => !DISABLED_TOOLS.has(t)));
    }
    updateStatus(ctx);
    ctx.ui.notify(`▶️ 恢复 PLAN 状态：${st.planFile}（${st.steps.filter((s) => s.completed).length}/${st.steps.length}）`, "info");
  });
}