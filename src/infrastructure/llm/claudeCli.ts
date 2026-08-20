/**
 * Claude Code CLI adapter - the concrete `LlmPort` that wraps the local `claude`
 * binary instead of calling the Anthropic API directly.
 *
 * This is what gives E.V. "full permissions from Claude": each turn runs through
 * Claude Code in print mode, so she can actually use tools (files, shell, MCP)
 * with whatever permissions the CLI is launched with. E.V. remains the memory
 * owner - her SQLite window is rendered into each stateless invocation, so no
 * CLI session state is relied upon.
 */
import type { LlmPort } from "../../application/ports.ts";
import type { PromptMessage } from "../../domain/types.ts";

export type ClaudeCliConfig = {
  /** Path or name of the claude binary. Default "claude". */
  binPath?: string;
  /** Model alias or id passed as --model (e.g. "opus"). Omitted when undefined. */
  model?: string;
  /** Pass --dangerously-skip-permissions for full tool access. Default true. */
  skipPermissions?: boolean;
  /** Working directory the CLI runs in (scopes tool access). */
  cwd?: string;
  /** Hard timeout for a single invocation, ms. Default 120000. */
  timeoutMs?: number;
};

const roleLabel = (role: PromptMessage["role"]): string =>
  role === "assistant" ? "E.V." : "User";

/**
 * Render the conversation window into a single print-mode prompt.
 *
 * The window ends with the user's newest turn; earlier turns are supplied as
 * labelled context so Claude Code answers with full continuity.
 */
export const renderPrompt = (messages: readonly PromptMessage[]): string => {
  if (messages.length === 0) return "";
  if (messages.length === 1) return messages[0]!.content;

  const history = messages.slice(0, -1);
  const latest = messages[messages.length - 1]!;
  const transcript = history.map((m) => `${roleLabel(m.role)}: ${m.content}`).join("\n");
  return [
    "Recent conversation for context:",
    transcript,
    "",
    "Respond to this newest message:",
    latest.content,
  ].join("\n");
};

type CliResult = {
  subtype?: string;
  is_error?: boolean;
  result?: string;
};

export const createClaudeCliLlm = (config: ClaudeCliConfig = {}): LlmPort => {
  const bin = config.binPath ?? "claude";
  const timeout = config.timeoutMs ?? 120_000;

  const buildArgs = (system: string): string[] => {
    const args = ["-p", "--output-format", "json", "--append-system-prompt", system];
    if (config.model) args.push("--model", config.model);
    if (config.skipPermissions !== false) args.push("--dangerously-skip-permissions");
    return args;
  };

  return {
    complete: async ({ system, messages }) => {
      const prompt = renderPrompt(messages);
      const proc = Bun.spawn({
        cmd: [bin, ...buildArgs(system)],
        stdin: Buffer.from(prompt),
        stdout: "pipe",
        stderr: "pipe",
        cwd: config.cwd,
        timeout,
        // Non-interactive sandbox hint; do not inherit an interactive TTY.
        env: { ...process.env, IS_SANDBOX: "1" },
      });

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      if (exitCode !== 0) {
        throw new Error(
          `claude CLI exited with code ${exitCode}: ${stderr.trim() || stdout.trim() || "no output"}`,
        );
      }

      let parsed: CliResult;
      try {
        parsed = JSON.parse(stdout) as CliResult;
      } catch {
        throw new Error(`claude CLI returned non-JSON output: ${stdout.slice(0, 500)}`);
      }

      if (parsed.is_error || parsed.subtype !== "success") {
        throw new Error(`claude CLI error (${parsed.subtype ?? "unknown"}): ${parsed.result ?? ""}`);
      }

      return (parsed.result ?? "").trim();
    },
  };
};
