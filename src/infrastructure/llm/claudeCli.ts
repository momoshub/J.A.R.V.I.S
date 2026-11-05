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
import type {
  LlmCompleteParams,
  LlmPort,
  LlmSession,
  LlmStreamSink,
  LlmUsage,
  UsagePayer,
  UsageSink,
} from "../../application/ports.ts";
import type { PromptMessage } from "../../domain/types.ts";
import type { ToolPolicy } from "../../domain/toolPolicy.ts";
import { isNoiseTool, redactPaths, redactSecrets } from "../../domain/toolVisibility.ts";
import { stopProcess } from "./killTree.ts";

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
  /**
   * Told what each finished run consumed. The CLI reports its own token counts
   * and list-price cost on the final `result` line, which is the only place
   * that number exists - nothing downstream can reconstruct it.
   */
  onUsage?: UsageSink;
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
    // and the host's own paths from what is shown. `command` stays whole: it
    // is only ever matched on.
    const shown = redactPaths(redactSecrets(input.command));
    return {
      title: truncate(`run: ${shown}`, 200),
      details: truncate(shown, 256),
      command: input.command,
    };
  }
  const firstString = Object.values(input).find((v) => typeof v === "string") as string | undefined;
  return {
    title: truncate(name, 200),
    details: firstString ? truncate(redactPaths(redactSecrets(firstString)), 256) : undefined,
  };
};

type CliResult = { subtype?: string; is_error?: boolean; result?: string };

/** The usage fields of the CLI's final `result` line (verified against it). */
type ResultUsage = {
  total_cost_usd?: number;
  duration_ms?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  modelUsage?: Record<string, unknown>;
};

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * What a finished run consumed, or undefined when the line carries no usage at
 * all. The model name comes from `modelUsage`, whose single key is the model
 * that actually served the run - which is not always the one that was asked
 * for, and the difference is the whole point of recording it.
 */
export const usageOf = (result: Record<string, unknown>): LlmUsage | undefined => {
  const r = result as ResultUsage;
  if (!r.usage && r.total_cost_usd === undefined) return undefined;
  const u = r.usage ?? {};
  return {
    model: Object.keys(r.modelUsage ?? {})[0] ?? "",
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens),
    cacheWriteTokens: num(u.cache_creation_input_tokens),
    costUsd: num(r.total_cost_usd),
    durationMs: num(r.duration_ms),
  };
};

/** Whose credential paid for a run. */
export const payerOf = (oauthToken?: string, useHostLogin?: boolean): UsagePayer =>
  oauthToken ? "caller" : useHostLogin ? "host" : "bot";

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
  useHostLogin?: boolean,
  signal?: AbortSignal,
  runTicket?: string,
) => {
  const proc = Bun.spawn({
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
    env: { ...hostLoginEnv(oauthToken, useHostLogin), ...(runTicket ? { JARVIS_RUN_TICKET: runTicket } : {}) },
  });
  // Stopping kills the whole TREE, not just the CLI: the model's shell commands
  // are its children, and a turn wedged inside one of them ignores a signal to
  // the parent entirely. SIGTERM first so the session file is flushed, SIGKILL
  // after a grace period for anything still standing.
  if (signal) {
    const stop = () => stopProcess(proc);
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
  }
  return proc;
};

/**
 * The environment the CLI is spawned with.
 *
 * `useHostLogin` REMOVES the token rather than merely omitting it: the bot's own
 * credential is in `process.env`, so leaving it there would win and the run
 * would once again have no connectors.
 */
const hostLoginEnv = (oauthToken?: string, useHostLogin?: boolean): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = { ...process.env, IS_SANDBOX: "1" };
  if (useHostLogin) {
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    return env;
  }
  if (oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
  return env;
};

export const createClaudeCliLlm = (config: ClaudeCliConfig = {}): LlmPort => {
  const report = (
    result: Record<string, unknown>,
    oauthToken: string | undefined,
    useHostLogin: boolean | undefined,
    bill: LlmCompleteParams["bill"],
  ): void => {
    if (!config.onUsage) return;
    const usage = usageOf(result);
    if (!usage) return;
    // Accounting must never be able to take a turn down with it.
    try {
      config.onUsage(usage, payerOf(oauthToken, useHostLogin), bill);
    } catch {
      // nothing here is worth the answer
    }
  };

  const complete = async ({ system, messages, assistantName, policy, session, oauthToken, useHostLogin, signal, runTicket, bill }: LlmCompleteParams) => {
    const proc = spawnClaude(config, [...buildArgs(config, false, policy, session), "--append-system-prompt", system], renderPrompt(messages, assistantName), policy, oauthToken, useHostLogin, signal, runTicket);
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
    report(parsed as Record<string, unknown>, oauthToken, useHostLogin, bill);
    if (parsed.is_error || parsed.subtype !== "success") {
      throw new Error(`claude CLI error (${parsed.subtype ?? "unknown"}): ${parsed.result ?? ""}`);
    }
    return (parsed.result ?? "").trim();
  };

  const stream = async ({ system, messages, assistantName, policy, session, oauthToken, useHostLogin, signal, runTicket, bill }: LlmCompleteParams, sink: LlmStreamSink) => {
    const proc = spawnClaude(config, [...buildArgs(config, true, policy, session), "--append-system-prompt", system], renderPrompt(messages, assistantName), policy, oauthToken, useHostLogin, signal, runTicket);
    const stderrPromise = new Response(proc.stderr).text();

    /**
     * Emit to the caller without ever letting it break the read loop.
     *
     * The sink posts to Slack, and Slack fails - `msg_too_long` alone shows up
     * dozens of times in the log. A throw from here used to escape the loop
     * below, which abandoned the child's stdout. A pipe nobody drains fills
     * after ~64KB and the CLI blocks writing to it FOREVER: 0% CPU, no
     * children, alive. That is what a wedged turn looked like in production,
     * and it ignored SIGTERM. Reporting a hiccup is never worth a stuck turn.
     */
    const emit = (ev: Parameters<LlmStreamSink>[0]): void => {
      try {
        const r = sink(ev) as unknown;
        if (r && typeof (r as Promise<void>).catch === "function") (r as Promise<void>).catch(() => {});
      } catch {
        // the transport's problem, not the run's
      }
    };

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
            emit({ type: "text", delta: gap });
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
            emit({ type: "text", delta: delta.text });
          } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string" && typeof index === "number") {
            const tb = toolByIndex.get(index);
            if (tb) tb.json += delta.partial_json;
          }
        } else if (ev.type === "content_block_stop" && typeof index === "number") {
          const tb = toolByIndex.get(index);
          if (tb && !isNoiseTool(tb.name)) {
            const { title, details, command } = summarizeTool(tb.name, tb.json);
            cardById.set(tb.id, { title, command });
            emit({ type: "tool", id: tb.id, title, details, command, status: "in_progress" });
          }
        }
      } else if (e.type === "user") {
        const content = ((e.message as Record<string, unknown>)?.content ?? []) as Record<string, unknown>[];
        for (const c of content) {
          if (c.type === "tool_result" && typeof c.tool_use_id === "string") {
            // No card means nothing was shown for it: a plumbing tool, or a
            // subagent's own step. Closing it anyway drew a bare "tool" card.
            const card = cardById.get(c.tool_use_id);
            if (!card) continue;
            emit({
              type: "tool",
              id: c.tool_use_id,
              title: card.title,
              command: card.command,
              status: c.is_error ? "error" : "complete",
            });
          }
        }
      } else if (e.type === "result") {
        // Recorded even when the run errored: a turn that burned nine minutes
        // and then failed cost exactly as much as one that worked.
        report(e, oauthToken, useHostLogin, bill);
        // Also handed to the renderer, which puts it under the reply.
        const u = usageOf(e);
        if (u) emit({ type: "usage", usage: u });
        if (typeof e.result === "string") finalText = e.result;
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

    // Whatever happens in here - a parse blowing up, the caller unwinding, an
    // abort - the child gets stopped and the reader released on the way out.
    // Leaving either behind is how a turn survives its own stream call.
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        consume(decoder.decode(value, { stream: true }));
      }
      if (buffer.trim()) consume("\n");
    } catch (err) {
      stopProcess(proc);
      throw err;
    } finally {
      reader.releaseLock();
    }

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
      emit({
        type: "aborted",
        reason: exitCode === 143 ? "it ran out of time" : `it exited with code ${exitCode}`,
      });
    }
    return finished;
  };

  return { complete, stream };
};
