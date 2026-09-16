/**
 * Claude Code CLI adapter - the concrete `LlmPort` that wraps the local `claude`
 * binary instead of calling the Anthropic API directly.
 *
 * This is what gives the bot "full permissions from Claude": each turn runs through
 * Claude Code in print mode, so it can actually use tools (files, shell, MCP)
 * with whatever permissions the CLI is launched with. The bot remains the memory
 * owner - her SQLite window is rendered into each stateless invocation, so no
 * CLI session state is relied upon.
 *
 * Two modes:
 * - `complete` uses `--output-format json` and returns the whole reply.
 * - `stream` uses `--output-format stream-json --include-partial-messages` and
 *   forwards text deltas and tool-call progress to a sink as they arrive.
 */
import type { LlmCompleteParams, LlmPort, LlmSession, LlmStreamSink } from "../../application/ports.ts";
import type { PromptMessage } from "../../domain/types.ts";
import type { ToolPolicy } from "../../domain/toolPolicy.ts";
import { redactSecrets } from "../../domain/toolVisibility.ts";

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

const speakerLabel = (m: PromptMessage, assistantName: string): string =>
  m.role === "assistant" ? assistantName : m.speakerId ? `<@${m.speakerId}>` : "User";

/**
 * Render the conversation window into a single print-mode prompt.
 *
 * The window ends with the user's newest turn; earlier turns are supplied as a
 * labelled transcript (speakers tagged by Slack id) so Claude Code has full
 * continuity and knows exactly who to address and tag.
 */
export const renderPrompt = (
  messages: readonly PromptMessage[],
  assistantName = "Assistant",
): string => {
  if (messages.length === 0) return "";

  const history = messages.slice(0, -1);
  const latest = messages[messages.length - 1]!;
  const from = latest.speakerId ? ` (from <@${latest.speakerId}>)` : "";

  if (history.length === 0) {
    return `Respond to this message${from}:\n${latest.content}`;
  }

  const transcript = history.map((m) => `${speakerLabel(m, assistantName)}: ${m.content}`).join("\n");
  return [
    "Recent conversation for context:",
    transcript,
    "",
    `Respond to this newest message${from}:`,
    latest.content,
  ].join("\n");
};

const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

/**
 * Turn a tool_use name + accumulated input JSON into a short card title/details.
 *
 * `command` carries the Bash command in full: the card text is clipped for Slack,
 * but consumers that match on what ran (the review command's progress lines) need
 * the whole thing - a `gh pr review` can sit past 200 chars, after a heredoc body.
 */
export const summarizeTool = (
  name: string,
  jsonStr: string,
): { title: string; details?: string; command?: string } => {
  let input: Record<string, unknown> = {};
  try {
    input = jsonStr ? (JSON.parse(jsonStr) as Record<string, unknown>) : {};
  } catch {
    // partial/invalid json - fall back to the name only
  }
  if (name === "Bash" && typeof input.command === "string") {
    // The card is posted into a channel, so scrub anything credential-shaped
    // from what is shown. `command` stays whole: it is only ever matched on.
    const shown = redactSecrets(input.command);
    return {
      title: truncate(`run: ${shown}`, 200),
      details: truncate(shown, 256),
      command: input.command,
    };
  }
  const firstString = Object.values(input).find((v) => typeof v === "string") as string | undefined;
  return {
    title: truncate(name, 200),
    details: firstString ? truncate(redactSecrets(firstString), 256) : undefined,
  };
};

type CliResult = { subtype?: string; is_error?: boolean; result?: string };

const buildArgs = (
  config: ClaudeCliConfig,
  stream: boolean,
  policy?: ToolPolicy,
  session?: LlmSession,
): string[] => {
  const args = stream
    ? ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]
    : ["-p", "--output-format", "json"];
  // A policy may name its own model - a cheaper one for roles whose chat does
  // not warrant the expensive default.
  const model = policy?.model ?? config.model;
  if (model) args.push("--model", model);
  // A workflow keeps one CLI session alive across turns: claim the id on the
  // first call, resume it on every later one, and the model keeps its context.
  if (session) args.push(session.resume ? "--resume" : "--session-id", session.id);

  // A per-call policy overrides the adapter default. skipPermissions -> full
  // access; otherwise sandbox with an explicit allow/deny tool list.
  const skip = policy ? policy.skipPermissions : config.skipPermissions !== false;
  if (skip) {
    args.push("--dangerously-skip-permissions");
  } else if (policy?.allowedTools && policy.allowedTools.length > 0) {
    args.push("--allowedTools", ...policy.allowedTools);
  }
  // Denials apply either way. `--disallowedTools` is honoured alongside
  // `--dangerously-skip-permissions` (verified), so a full-access role can still
  // be kept off a tool that is wrong for it rather than merely asked not to.
  if (policy?.disallowedTools && policy.disallowedTools.length > 0) {
    args.push("--disallowedTools", ...policy.disallowedTools);
  }
  return args;
};

const spawnClaude = (
  config: ClaudeCliConfig,
  args: string[],
  prompt: string,
  policy?: ToolPolicy,
  oauthToken?: string,
) =>
  Bun.spawn({
    cmd: [config.binPath ?? "claude", ...args],
    stdin: Buffer.from(prompt),
    stdout: "pipe",
    stderr: "pipe",
    cwd: policy?.cwd ?? config.cwd,
    timeout: policy?.timeoutMs ?? config.timeoutMs ?? 120_000,
    // Non-interactive hint. process.env carries the bot's SLACK_BOT_TOKEN etc so the
    // CLI's Bash tool can call the Slack Web API with her own credentials.
    // A caller's own token replaces the bot's for this spawn only: the CLI honours
    // CLAUDE_CODE_OAUTH_TOKEN over any login on the host, so the turn is billed to
    // them and runs with their account's access.
    env: {
      ...process.env,
      IS_SANDBOX: "1",
      ...(oauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: oauthToken } : {}),
    },
  });

export const createClaudeCliLlm = (config: ClaudeCliConfig = {}): LlmPort => {
  const complete = async ({ system, messages, assistantName, policy, session, oauthToken }: LlmCompleteParams) => {
    const proc = spawnClaude(config, [...buildArgs(config, false, policy, session), "--append-system-prompt", system], renderPrompt(messages, assistantName), policy, oauthToken);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`claude CLI exited with code ${exitCode}: ${stderr.trim() || stdout.trim() || "no output"}`);
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
  };

  const stream = async ({ system, messages, assistantName, policy, session, oauthToken }: LlmCompleteParams, sink: LlmStreamSink) => {
    const proc = spawnClaude(config, [...buildArgs(config, true, policy, session), "--append-system-prompt", system], renderPrompt(messages, assistantName), policy, oauthToken);
    const stderrPromise = new Response(proc.stderr).text();

    // index -> in-flight tool_use block; id -> resolved card, replayed on the result.
    const toolByIndex = new Map<number, { id: string; name: string; json: string }>();
    const cardById = new Map<string, { title: string; command?: string }>();
    let finalText = "";
    let streamedText = "";

    const handleEvent = (e: Record<string, unknown>): void => {
      if (e.type === "stream_event") {
        const ev = (e.event ?? {}) as Record<string, unknown>;
        const index = ev.index as number | undefined;
        if (ev.type === "content_block_start") {
          const block = (ev.content_block ?? {}) as Record<string, unknown>;
          if (block.type === "text" && streamedText.trim() && !streamedText.endsWith("\n\n")) {
            // A fresh text block is a new paragraph: the model wrote it after a
            // tool call, not mid-sentence. Without this the deltas run together
            // and the message reads as one mangled line.
            const gap = streamedText.endsWith("\n") ? "\n" : "\n\n";
            streamedText += gap;
            sink({ type: "text", delta: gap });
          }
          if (block.type === "tool_use" && typeof index === "number") {
            toolByIndex.set(index, {
              id: (block.id as string) ?? `t${index}`,
              name: (block.name as string) ?? "tool",
              json: "",
            });
          }
        } else if (ev.type === "content_block_delta") {
          const delta = (ev.delta ?? {}) as Record<string, unknown>;
          if (delta.type === "text_delta" && typeof delta.text === "string") {
            streamedText += delta.text;
            sink({ type: "text", delta: delta.text });
          } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string" && typeof index === "number") {
            const tb = toolByIndex.get(index);
            if (tb) tb.json += delta.partial_json;
          }
        } else if (ev.type === "content_block_stop" && typeof index === "number") {
          const tb = toolByIndex.get(index);
          if (tb) {
            const { title, details, command } = summarizeTool(tb.name, tb.json);
            cardById.set(tb.id, { title, command });
            sink({ type: "tool", id: tb.id, title, details, command, status: "in_progress" });
          }
        }
      } else if (e.type === "user") {
        const content = ((e.message as Record<string, unknown>)?.content ?? []) as Record<string, unknown>[];
        for (const c of content) {
          if (c.type === "tool_result" && typeof c.tool_use_id === "string") {
            const card = cardById.get(c.tool_use_id);
            sink({
              type: "tool",
              id: c.tool_use_id,
              title: card?.title ?? "tool",
              command: card?.command,
              status: c.is_error ? "error" : "complete",
            });
          }
        }
      } else if (e.type === "result" && typeof e.result === "string") {
        finalText = e.result;
      }
    };

    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const consume = (chunk: string): void => {
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) {
          try {
            handleEvent(JSON.parse(line) as Record<string, unknown>);
          } catch {
            // ignore non-json lines
          }
        }
        nl = buffer.indexOf("\n");
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      consume(decoder.decode(value, { stream: true }));
    }
    if (buffer.trim()) consume("\n");

    const exitCode = await proc.exited;
    const finished = (finalText || streamedText).trim();
    if (exitCode !== 0 && !finished) {
      const stderr = await stderrPromise;
      throw new Error(`claude CLI exited with code ${exitCode}: ${stderr.trim() || "no output"}`);
    }
    // Killed after it had already said something. What we hold is a fragment of
    // a run, not its answer - 143 is the timeout reaping it. Say so rather than
    // letting a caller hand the fragment over as the finished work.
    if (exitCode !== 0) {
      sink({
        type: "aborted",
        reason: exitCode === 143 ? "it ran out of time" : `it exited with code ${exitCode}`,
      });
    }
    return finished;
  };

  return { complete, stream };
};
