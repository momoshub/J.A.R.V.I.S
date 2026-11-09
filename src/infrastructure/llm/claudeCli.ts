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
  ToolTrace,
  ToolTraceSink,
  UsagePayer,
  UsageSink,
} from "../../application/ports.ts";
import type { PromptMessage } from "../../domain/types.ts";
import type { ToolPolicy } from "../../domain/toolPolicy.ts";
import { isNoiseTool, redactPaths, redactSecrets } from "../../domain/toolVisibility.ts";
import { stopProcess } from "./killTree.ts";
import { ignoreQuietly } from "../../application/ignoredError.ts";
import { NO_CLAUDEAI_CONNECTORS_ENV, createClaudeJsonReader, mcpConfigFor } from "./mcpConfig.ts";

export type ClaudeCliConfig = {
  /** Path or name of the claude binary. Default "claude". */
  binPath?: string;
  /** Model alias or id passed as --model (e.g. "opus"). Omitted when undefined. */
  model?: string;
  /** Pass --dangerously-skip-permissions for full tool access. Default true. */
  skipPermissions?: boolean;
  /** Working directory the CLI runs in (scopes tool access). */
  cwd?: string;
  /** The host's `~/.claude.json`, read for the MCP server list. Default `~/.claude.json`; tests point it elsewhere. */
  claudeJsonPath?: string;
  /** Hard timeout for a single invocation, ms. Default 120000. */
  timeoutMs?: number;
  /**
   * Told what each finished run consumed. The CLI reports its own token counts
   * and list-price cost on the final `result` line, which is the only place
   * that number exists - nothing downstream can reconstruct it.
   */
  onUsage?: UsageSink;
  /** Told every tool call and result in full, for the per-thread debug log. */
  onToolTrace?: ToolTraceSink;
  /**
   * Extra environment for every spawned turn, asked fresh each time. Carries the
   * bot's own Orca terminal handle; an undefined value removes an inherited one.
   */
  turnEnv?: () => Promise<Record<string, string | undefined>>;
  /**
   * Agent definitions passed as `--agents`, asked fresh each turn. Replaces
   * built-in agents of the same name, e.g. to pin Explore and Plan's models.
   */
  agents?: () => Record<string, Record<string, unknown>>;
};

/** A tool_result's content as text: a string, or the text parts of a block list. */
export const toolOutput = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content === undefined ? "" : JSON.stringify(content);
  return content
    .map((p) => {
      const part = p as { type?: string; text?: unknown };
      if (part.type === "text" && typeof part.text === "string") return part.text;
      return `[${part.type ?? "part"}]`;
    })
    .join("\n");
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
 * True for a Bash call that does nothing but run the react helper
 * (`.../bin/slack-react.sh <channel> <ts> <emoji>`), possibly chained with
 * `&&` / `;` / newlines. The model reacts to close a thread right after writing
 * its answer in the same message, so such a message's text is the answer, not
 * self-talk. Anything else (another tool, a chained real command, unreadable
 * input) is not a react call.
 */
export const isReactCall = (name: string, inputJson: string): boolean => {
  if (name !== "Bash") return false;
  let command: unknown;
  try {
    command = (JSON.parse(inputJson) as Record<string, unknown>).command;
  } catch {
    return false;
  }
  if (typeof command !== "string") return false;
  const segments = command
    .split(/&&|\|\||;|\n/)
    .map((x) => x.trim())
    .filter(Boolean);
  return segments.length > 0 && segments.every((x) => /^(?:\w+=\S*\s+)*(?:bash\s+)?\S*slack-react\.sh(?:\s|$)/.test(x));
};

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
/**
 * What the thread is told when a run ended with background work still going.
 * Names each task so whoever asked knows what to have picked back up.
 */
export const backgroundCutOffNotice = (tasks: readonly string[]): string => {
  const names = tasks.map((t) => `\`${t.replace(/\s+/g, " ").slice(0, 80)}\``).join(", ");
  const what = tasks.length === 1 ? "a background job was" : `${tasks.length} background jobs were`;
  return `_heads up: my run ended while ${what} still going, so it stopped before finishing: ${names}. ask me to pick it up again_`;
};

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
  const agents = config.agents?.();
  if (agents && Object.keys(agents).length > 0) args.push("--agents", JSON.stringify(agents));
  // A workflow keeps one CLI session alive across turns: claim the id on the
  // first call, resume it on every later one, and the model keeps its context.
  if (session) args.push(session.resume ? "--resume" : "--session-id", session.id);
  if (session?.name) args.push("--name", session.name);

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
  session?: LlmSession,
  extraEnv: Record<string, string | undefined> = {},
) => {
  const proc = Bun.spawn({
    cmd: [config.binPath ?? "claude", ...args, ...connectorArgs(config, policy, useHostLogin)],
    stdin: Buffer.from(prompt),
    stdout: "pipe",
    stderr: "pipe",
    cwd: policy?.cwd ?? config.cwd,
    // Non-interactive hint. process.env carries the bot's SLACK_BOT_TOKEN etc so the
    // CLI's Bash tool can call the Slack Web API with her own credentials.
    // A caller's own token replaces the bot's for this spawn only: the CLI honours
    // CLAUDE_CODE_OAUTH_TOKEN over any login on the host, so the turn is billed to
    // them and runs with their account's access.
    // The session id lets a turn recognise its own process: a long turn that
    // lists processes otherwise finds `claude -p --resume <id>` working in its
    // repo and reports itself as a second writer. A one-shot run has no
    // session, and an inherited id from a parent turn must not leak into it.
    env: {
      ...hostLoginEnv(oauthToken, useHostLogin),
      ...extraEnv,
      ...(runTicket ? { JARVIS_RUN_TICKET: runTicket } : {}),
      BOT_SESSION_ID: session?.id,
    },
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
  // The time limit goes the same way, not through Bun's own spawn timeout:
  // that one sends a single SIGTERM to the CLI, and a CLI stuck inside a tool
  // call shrugs it off. A background investigate ran on like that for over an
  // hour, never settled, and never told its thread anything.
  const limit = setTimeout(() => stopProcess(proc), policy?.timeoutMs ?? config.timeoutMs ?? 120_000);
  limit.unref?.();
  void proc.exited.then(() => clearTimeout(limit));
  return proc;
};

const claudeJsonReaders = new Map<string, () => unknown>();

/**
 * Keeps unauthenticated MCP servers out of a bot turn (see
 * `UNAUTHENTICATED_MCP_SERVERS`). Every other configured server is passed
 * explicitly under `--strict-mcp-config`, which is what drops the rest. A
 * host-login spawn is left alone: its commands (read, ticket, note, close) use
 * the account's connectors. Goes last because `--mcp-config` is variadic and
 * the flag after it ends the list.
 */
const connectorArgs = (config: ClaudeCliConfig, policy?: ToolPolicy, useHostLogin?: boolean): string[] => {
  if (useHostLogin) return [];
  const key = config.claudeJsonPath ?? "";
  let read = claudeJsonReaders.get(key);
  if (!read) {
    read = createClaudeJsonReader(config.claudeJsonPath);
    claudeJsonReaders.set(key, read);
  }
  const json = mcpConfigFor(read(), policy?.cwd ?? config.cwd);
  return json ? ["--mcp-config", json, "--strict-mcp-config"] : [];
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
  // The account's claude.ai connectors are never wanted in a bot turn.
  Object.assign(env, NO_CLAUDEAI_CONNECTORS_ENV);
  if (oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
  return env;
};

export const createClaudeCliLlm = (config: ClaudeCliConfig = {}): LlmPort => {
  // Whatever goes wrong asking for it, the turn still runs - just without it.
  const turnEnv = async (): Promise<Record<string, string | undefined>> => {
    try {
      return config.turnEnv ? await config.turnEnv() : {};
    } catch {
      return {};
    }
  };

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

  /** Hand the caller its run's usage; like accounting, never at the turn's expense. */
  const tell = (onUsage: LlmCompleteParams["onUsage"], usage: LlmUsage | undefined): void => {
    if (!onUsage || !usage) return;
    try {
      onUsage(usage);
    } catch {
      // the caller's problem, not the run's
    }
  };

  const completeOneShot = async ({ system, messages, assistantName, policy, session, oauthToken, useHostLogin, signal, runTicket, bill, onUsage }: LlmCompleteParams) => {
    const proc = spawnClaude(config, [...buildArgs(config, false, policy, session), "--append-system-prompt", system], renderPrompt(messages, assistantName), policy, oauthToken, useHostLogin, signal, runTicket, session, await turnEnv());
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
    tell(onUsage, usageOf(parsed as Record<string, unknown>));
    if (parsed.is_error || parsed.subtype !== "success") {
      throw new Error(`claude CLI error (${parsed.subtype ?? "unknown"}): ${parsed.result ?? ""}`);
    }
    return (parsed.result ?? "").trim();
  };

  /**
   * Run the CLI in stream-json mode and read it to the end. Shared by `stream`
   * and by `complete` when tool calls are being traced: the one-shot json
   * output carries only the final answer, so a run made that way left no
   * record of what it ran.
   */
  const runStreaming = async ({ system, messages, assistantName, policy, session, oauthToken, useHostLogin, signal, runTicket, bill, onUsage }: LlmCompleteParams, sink: LlmStreamSink) => {
    const proc = spawnClaude(config, [...buildArgs(config, true, policy, session), "--append-system-prompt", system], renderPrompt(messages, assistantName), policy, oauthToken, useHostLogin, signal, runTicket, session, await turnEnv());
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
        if (r && typeof (r as Promise<void>).catch === "function") (r as Promise<void>).catch(ignoreQuietly("llm stream sink"));
      } catch {
        // the transport's problem, not the run's
      }
    };

    // The full record, for the thread's debug log. Like `emit`, a logger that
    // throws must never cost the run its stdout.
    const trace = (t: ToolTrace): void => {
      if (!config.onToolTrace) return;
      try {
        config.onToolTrace(t, bill);
      } catch {
        // a debug log is never worth the answer
      }
    };

    // index -> in-flight tool_use block; id -> resolved card, replayed on the result.
    const toolByIndex = new Map<number, { id: string; name: string; json: string }>();
    const cardById = new Map<string, { title: string; command?: string }>();
    let finalText = "";
    let lastResult = "";
    let streamedText = "";
    // Text the model writes in a message that goes on to call a tool is it
    // talking to itself ("Partial work exists. Resume the agent."), not the
    // answer - and it went straight into the Slack thread. So a message's text
    // is held until the message ends, sent if it ended the turn, and dropped
    // if a tool call followed. `held` keeps the last dropped piece, in case the
    // turn then ends with nothing to say: an answer written before a closing
    // tool call is still the answer.
    //
    // One tool call does not make the text self-talk: a message whose only
    // calls are `slack-react.sh` (the closing 🔥 on the thread) wrote the
    // ANSWER and then reacted. The command arrives through input_json_delta,
    // after the block started, so that is decided when the message ends.
    let pending: string[] = [];
    let held = "";
    // Text set aside at the first tool_use of the message, decided at its end.
    let candidate: string[] = [];
    // The tool calls of the message in flight (the json fills in as it streams).
    let messageTools: { name: string; json: string }[] = [];
    // Answers streamed because they preceded a react call. The result event
    // carries only the last round's text, so these are added back to the
    // finished text below.
    const reactAnswers: string[] = [];
    const streamOut = (parts: string[]): string => {
      const text = parts.join("");
      if (!text.trim()) return "";
      for (const d of parts) emit({ type: "text", delta: d });
      streamedText += text;
      held = "";
      return text;
    };
    const flush = (): void => {
      streamOut(pending);
      pending = [];
    };
    // The message ended on a tool call: its text is the answer when every call
    // was a react, self-talk otherwise.
    const settleToolMessage = (): void => {
      const parts = [...candidate, ...pending];
      candidate = [];
      pending = [];
      const calls = messageTools;
      messageTools = [];
      if (calls.length > 0 && calls.every((t) => isReactCall(t.name, t.json))) {
        const text = streamOut(parts);
        if (text) reactAnswers.push(text);
        return;
      }
      const text = parts.join("");
      if (text.trim()) held = text;
    };
    let resultEvent: Record<string, unknown> | undefined;
    // The background tasks the CLI says are still running, as of its latest
    // `background_tasks_changed`. Whatever is left here when the process exits
    // was killed with it.
    let backgroundTasks: string[] = [];

    const handleEvent = (e: Record<string, unknown>): void => {
      if (e.type === "stream_event") {
        const ev = (e.event ?? {}) as Record<string, unknown>;
        const index = ev.index as number | undefined;
        if (ev.type === "content_block_start") {
          const block = (ev.content_block ?? {}) as Record<string, unknown>;
          const sofar = streamedText + pending.join("");
          if (block.type === "text" && sofar.trim() && !sofar.endsWith("\n\n")) {
            // A fresh text block is a new paragraph: the model wrote it after a
            // tool call, not mid-sentence. Without this the deltas run together
            // and the message reads as one mangled line.
            pending.push(sofar.endsWith("\n") ? "\n" : "\n\n");
          }
          if (block.type === "tool_use") {
            candidate.push(...pending);
            pending = [];
          }
          if (block.type === "tool_use" && typeof index === "number") {
            const tb = {
              id: (block.id as string) ?? `t${index}`,
              name: (block.name as string) ?? "tool",
              json: "",
            };
            toolByIndex.set(index, tb);
            messageTools.push(tb);
          }
        } else if (ev.type === "content_block_delta") {
          const delta = (ev.delta ?? {}) as Record<string, unknown>;
          if (delta.type === "text_delta" && typeof delta.text === "string") {
            pending.push(delta.text);
          } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string" && typeof index === "number") {
            const tb = toolByIndex.get(index);
            if (tb) tb.json += delta.partial_json;
          }
        } else if (ev.type === "message_delta") {
          const stop = ((ev.delta ?? {}) as Record<string, unknown>).stop_reason;
          if (stop === "tool_use") settleToolMessage();
          else if (typeof stop === "string") flush();
        } else if (ev.type === "message_start") {
          candidate = [];
          messageTools = [];
        } else if (ev.type === "message_stop") {
          flush();
        } else if (ev.type === "content_block_stop" && typeof index === "number") {
          const tb = toolByIndex.get(index);
          if (tb) trace({ kind: "call", id: tb.id, name: tb.name, input: tb.json });
          if (tb && !isNoiseTool(tb.name)) {
            const { title, details, command } = summarizeTool(tb.name, tb.json);
            cardById.set(tb.id, { title, command });
            emit({ type: "tool", id: tb.id, title, details, command, status: "in_progress" });
          }
        }
      } else if (e.type === "assistant" && typeof e.parent_tool_use_id === "string") {
        // A subagent's own steps arrive whole rather than as stream deltas.
        // The main agent's come through `stream_event` above, so only these.
        const content = ((e.message as Record<string, unknown>)?.content ?? []) as Record<string, unknown>[];
        for (const c of content) {
          if (c.type === "tool_use" && typeof c.id === "string") {
            trace({
              kind: "call",
              id: c.id,
              name: typeof c.name === "string" ? c.name : "tool",
              input: JSON.stringify(c.input ?? {}),
              parent: e.parent_tool_use_id,
            });
          }
        }
      } else if (e.type === "user") {
        const content = ((e.message as Record<string, unknown>)?.content ?? []) as Record<string, unknown>[];
        for (const c of content) {
          if (c.type === "tool_result" && typeof c.tool_use_id === "string") {
            trace({
              kind: "result",
              id: c.tool_use_id,
              isError: c.is_error === true,
              output: toolOutput(c.content),
              ...(typeof e.parent_tool_use_id === "string" ? { parent: e.parent_tool_use_id } : {}),
            });
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
      } else if (e.type === "system" && e.subtype === "background_tasks_changed" && Array.isArray(e.tasks)) {
        backgroundTasks = (e.tasks as Record<string, unknown>[]).map((t) =>
          typeof t.description === "string" && t.description.trim() ? t.description.trim() : String(t.task_id ?? "a task"),
        );
      } else if (e.type === "result") {
        // Recorded even when the run errored: a turn that burned nine minutes
        // and then failed cost exactly as much as one that worked.
        report(e, oauthToken, useHostLogin, bill);
        // Also handed to the renderer, which puts it under the reply.
        const u = usageOf(e);
        if (u) emit({ type: "usage", usage: u });
        tell(onUsage, u);
        // One run can end more than once. A background agent that reports after
        // the answer wakes the CLI for another round in the same process, and
        // that round ends with its own `result`. Keeping only the last one
        // swapped the answer to the person's question for a status update
        // about the background job. So every round's text is kept, in order.
        const text = typeof e.result === "string" ? e.result.trim() : "";
        if (text && text !== lastResult) {
          finalText = finalText ? `${finalText}\n\n${text}` : text;
          lastResult = text;
        }
        resultEvent = e;
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
      // A run cut off mid-message still hands back what it had said.
      flush();
      if (!streamedText.trim() && held.trim()) {
        emit({ type: "text", delta: held });
        streamedText = held;
      }
    } catch (err) {
      stopProcess(proc);
      throw err;
    } finally {
      reader.releaseLock();
    }

    const exitCode = await proc.exited;
    // finalText is the last round's text only; an answer streamed before a
    // react call belongs in front of it.
    const lead = reactAnswers.map((t) => t.trim()).filter((t) => t && !finalText.includes(t));
    const finished = (finalText ? [...lead, finalText].join("\n\n") : streamedText).trim();
    return { exitCode, finished, finalText, resultEvent, stderr: stderrPromise, emit, backgroundTasks };
  };

  const stream = async (params: LlmCompleteParams, sink: LlmStreamSink) => {
    const { exitCode, finished: answer, stderr, emit, backgroundTasks } = await runStreaming(params, sink);
    if (exitCode !== 0 && !answer) {
      throw new Error(`claude CLI exited with code ${exitCode}: ${(await stderr).trim() || "no output"}`);
    }
    // Background work still listed when the CLI exited died with it. The CLI
    // gives it a grace period after the answer (about ten minutes), then kills
    // it - and nothing said so, so a long job just stopped and somebody had to
    // ask "???" to find out. Say it in the reply itself: streamed if the
    // message is still open, and in the returned text for a caller that posts
    // or rewrites it.
    const notice = backgroundTasks.length > 0 ? backgroundCutOffNotice(backgroundTasks) : "";
    if (notice) emit({ type: "text", delta: `\n\n${notice}` });
    const finished = notice ? `${answer}\n\n${notice}` : answer;
    // Killed after it had already said something. What we hold is a fragment of
    // a run, not its answer - 143 (or 137 after the hard kill) is the timeout reaping it. Say so rather than
    // letting a caller hand the fragment over as the finished work.
    if (exitCode !== 0) {
      emit({
        type: "aborted",
        reason: exitCode === 143 || exitCode === 137 ? "it ran out of time" : `it exited with code ${exitCode}`,
      });
    }
    return finished;
  };

  /** `complete`'s contract - throw unless it finished cleanly - over a streamed run. */
  const completeTraced = async (params: LlmCompleteParams): Promise<string> => {
    const { exitCode, finalText, resultEvent, stderr } = await runStreaming(params, () => {});
    if (exitCode !== 0) {
      throw new Error(`claude CLI exited with code ${exitCode}: ${(await stderr).trim() || "no output"}`);
    }
    if (!resultEvent) throw new Error("claude CLI ended without a result");
    if (resultEvent.is_error || resultEvent.subtype !== "success") {
      throw new Error(`claude CLI error (${String(resultEvent.subtype ?? "unknown")}): ${finalText}`);
    }
    return finalText.trim();
  };

  // Traced runs go through the stream so their tool calls are on record.
  const complete = (params: LlmCompleteParams): Promise<string> =>
    config.onToolTrace ? completeTraced(params) : completeOneShot(params);

  return { complete, stream };
};
