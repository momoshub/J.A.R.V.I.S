/**
 * What a tool call is allowed to show in the Slack timeline.
 *
 * Most tool calls are worth showing - a lookup or a command is part of the
 * answer, and the timeline is how you watch the work happen. Two kinds are not:
 *
 * - the bot's own quiet self-actions (reacting, keeping a learning), which it is
 *   told to do without announcing
 * - anything reaching its own machine, which is nobody's business in a channel
 *   and only ever exposes internals (ports, loopback endpoints, local paths)
 *
 * Whatever does show is scrubbed of anything that looks like a credential
 * first: a card is posted to a Slack channel, so a token pasted into a command
 * would be a leak that outlives the conversation.
 */

const HIDDEN = [
  // Self-actions the bot performs silently.
  /slack\.com\/api\/reactions\.(add|remove)/i,
  /slack-react\.sh\b/i,
  /jarvis-run\.sh\b/i,
  /\/api\/learnings\b/i,
  // Anything aimed at the host the bot runs on.
  /\blocalhost\b/i,
  /\b127\.0\.0\.1\b/,
  /\b0\.0\.0\.0\b/,
  /\[::1\]/,
];

/** True when this shell command must not appear as a step in the thread. */
export const isHiddenAction = (command?: string): boolean =>
  !!command && HIDDEN.some((re) => re.test(command));

/**
 * Tools that are the model's own plumbing, not work anyone asked to watch. A
 * card for each one is just "ToolSearch, ToolSearch, TodoWrite" noise between
 * the steps that matter.
 */
const NOISE_TOOLS = new Set([
  "ToolSearch",
  "TodoWrite",
  "TaskOutput",
  "TaskStop",
  "KillShell",
  "BashOutput",
  "ExitPlanMode",
  "ScheduleWakeup",
  "ListMcpResourcesTool",
]);

/** True when a tool call by this name is plumbing and should leave no card. */
export const isNoiseTool = (name: string): boolean => NOISE_TOOLS.has(name);

/**
 * Shorten the machine's own paths in anything user-visible: the workspace root
 * becomes `$Workspaces` and the home directory `~`. Whose laptop the bot runs
 * on, and how it is laid out, is nobody's business in a channel.
 */
export const redactPaths = (text: string, home: string = process.env.HOME ?? ""): string => {
  if (!home || home === "/") return text;
  return text.split(`${home}/Workspaces`).join("$Workspaces").split(home).join("~");
};

/**
 * Credential shapes worth scrubbing from anything user-visible. A shell variable
 * (`$SLACK_BOT_TOKEN`) is not a secret and is left alone - it is the expanded
 * value that must never be rendered.
 */
const SECRETS: readonly RegExp[] = [
  /xox[baprs]-[A-Za-z0-9-]{8,}/g,
  /xapp-[A-Za-z0-9-]{8,}/g,
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /gh[pousr]_[A-Za-z0-9]{16,}/g,
  /AKIA[0-9A-Z]{12,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
];

export const REDACTED = "[redacted]";

/** Replace anything credential-shaped with a marker. */
export const redactSecrets = (text: string): string =>
  SECRETS.reduce((out, re) => out.replace(re, REDACTED), text);
