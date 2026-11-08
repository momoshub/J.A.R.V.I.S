/**
 * Which model the agents a turn starts run on, apart from the turn itself.
 *
 * The turn's own model is per role (`model:<role>`); the owner talks on Opus.
 * Everything it hands off is cheaper by default: Agent tool subagents and Orca
 * workers run on Sonnet, and only planning stays on Opus (Kai). Each kind is a
 * `model:<kind>` setting, read per turn, so changing one needs no restart.
 */

export const AGENT_MODEL_KINDS = ["subagent", "worker", "plan"] as const;
export type AgentModelKind = (typeof AGENT_MODEL_KINDS)[number];
export type AgentModels = Readonly<Record<AgentModelKind, string>>;

export const DEFAULT_AGENT_MODELS: AgentModels = { subagent: "sonnet", worker: "sonnet", plan: "opus" };

/** Env var the prompts pass to `orca ... --model`, so a worker's model follows the setting. */
export const WORKER_MODEL_ENV = "BOT_WORKER_MODEL";

export const agentModelKindOf = (word: string): AgentModelKind | undefined =>
  (AGENT_MODEL_KINDS as readonly string[]).includes(word) ? (word as AgentModelKind) : undefined;

/** Each kind's stored override, or its default when unset or blank. */
export const agentModelsOf = (stored: (kind: AgentModelKind) => string | undefined): AgentModels => ({
  subagent: stored("subagent")?.trim() || DEFAULT_AGENT_MODELS.subagent,
  worker: stored("worker")?.trim() || DEFAULT_AGENT_MODELS.worker,
  plan: stored("plan")?.trim() || DEFAULT_AGENT_MODELS.plan,
});

/**
 * Environment for a turn. `CLAUDE_CODE_SUBAGENT_MODEL` is the model of every
 * subagent whose definition names none (general-purpose, review children);
 * it is a default, not forced, so the Plan override below still wins.
 */
export const agentModelEnv = (m: AgentModels): Record<string, string> => ({
  CLAUDE_CODE_SUBAGENT_MODEL: m.subagent,
  [WORKER_MODEL_ENV]: m.worker,
});

/** What a read-only built-in agent may not touch. */
const READ_ONLY_DENY = ["Agent", "Edit", "Write", "NotebookEdit", "ExitPlanMode"];

/**
 * `--agents` definitions replacing the built-in Explore and Plan agents. Both
 * inherit the turn's model and ignore `CLAUDE_CODE_SUBAGENT_MODEL` (checked on
 * Claude Code 2.1.285), so an owner turn's Explore ran on Opus; and forcing the
 * variable would put Plan on Sonnet too. A definition must carry a prompt, so
 * these restate what the built-ins do.
 */
export const builtinAgentOverrides = (m: AgentModels): Record<string, Record<string, unknown>> => ({
  Explore: {
    description:
      "Read-only search agent for broad fan-out searches across many files, directories or naming conventions when only the conclusion is needed. Say how thorough: quick, medium or very thorough.",
    prompt:
      "You are a read-only codebase search agent. Find what the caller asked for with Glob, Grep, Read and read-only shell commands (ls, git log, git show, find). Never create, edit or delete files, and never run commands that change state. Search wide first, then narrow; read excerpts rather than whole files. Answer with the conclusion: the relevant file paths with line numbers and a short note on each, plus anything you could not find.",
    model: m.subagent,
    disallowedTools: READ_ONLY_DENY,
  },
  Plan: {
    description:
      "Software architect agent for designing implementation plans. Returns step-by-step plans, identifies critical files, and weighs architectural trade-offs.",
    prompt:
      "You are a software architect. Read the code the task touches (Glob, Grep, Read, read-only shell commands) until you understand how it works today, then design how to make the change. Never create, edit or delete files. Answer with a concrete step-by-step implementation plan: the files and functions to change, the order, the risks and trade-offs, and how to verify it (tests to add or run).",
    model: m.plan,
    disallowedTools: READ_ONLY_DENY,
  },
});
