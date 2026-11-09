/**
 * Per-user Claude Code credentials: the port, the Slack interaction contract,
 * and what happens when someone submits one.
 *
 * Every CLI turn the bot runs on a person's behalf can run on that person's own
 * token. None is required: every turn, `review` included, uses a token when the
 * speaker has one on file and the bot's own when they do not, so nobody is
 * locked out of chat or reviews by a credential they never set up.
 *
 * A token is never typed into a channel. It arrives through a Slack modal, whose
 * input is not a message: it is not in anyone's history, not in search, and not
 * in the bot's own conversation memory.
 */
import { isClaudeToken } from "../domain/claudeToken.ts";
import type { AllowedUser } from "../domain/types.ts";

/** Storage for user tokens. The concrete repo encrypts; this shape does not care. */
export type ClaudeTokenPort = {
  get: (slackId: string) => string | undefined;
  has: (slackId: string) => boolean;
  set: (slackId: string, token: string) => void;
  remove: (slackId: string) => void;
  /** How many users have one on file. */
  count: () => number;
  /** Who has one, newest first. The token itself is never part of this. */
  list: () => { slackId: string; updatedAt: number }[];
  /**
   * Whether this person has already been asked for a token. Nobody gets the
   * whole "here is how to mint one" ask twice - a second attempt gets a single
   * line pointing at the box they already have.
   */
  asked: (slackId: string) => boolean;
  /** Record that the ask went out. Cleared whenever a token is set or removed. */
  markAsked: (slackId: string) => void;
};

/** Button on the "I need your token" message. Opens the modal. */
export const TOKEN_ACTION = "claude_token_add";
/** Callback id of the modal itself, and the ids inside it. */
export const TOKEN_VIEW = "claude_token_view";
export const TOKEN_BLOCK = "claude_token_block";
export const TOKEN_INPUT = "claude_token_input";

/**
 * What the button carries and the modal hands back: the command that was blocked
 * waiting for a token, so submitting one resumes it instead of asking the user to
 * type it again. Slack round-trips this for us (`value`, `private_metadata`), so
 * there is no pending-state table to keep, expire or leak.
 */
export type TokenRequest = {
  channelId: string;
  threadTs?: string;
  /** The command line to run once the token is in, e.g. `review <url>`. */
  line?: string;
};

export const encodeRequest = (req: TokenRequest): string => JSON.stringify(req);

/** Tolerant by design: a payload we cannot read still lets the token be saved. */
export const decodeRequest = (raw: string | undefined): TokenRequest | undefined => {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    const { channelId, threadTs, line } = parsed as Record<string, unknown>;
    if (typeof channelId !== "string" || !channelId) return undefined;
    return {
      channelId,
      threadTs: typeof threadTs === "string" && threadTs ? threadTs : undefined,
      line: typeof line === "string" && line ? line : undefined,
    };
  } catch {
    return undefined;
  }
};

export type TokenSubmission = {
  slackUserId: string;
  token: string;
  request?: TokenRequest;
};

export type TokenOutcome =
  /** Stored. `line` is the command to resume, when one was waiting. */
  | { kind: "saved"; request?: TokenRequest }
  /** Rejected without being stored; `error` is safe to show the user. */
  | { kind: "invalid"; error: string }
  | { kind: "no-store" };

export type TokenDeps = {
  claudeTokens?: ClaudeTokenPort;
};

/**
 * Validate and store a submitted token. Returns what to do next rather than
 * doing it, so the transport owns resuming the command and the modal's own
 * error rendering.
 */
export const submitClaudeToken = (deps: TokenDeps, sub: TokenSubmission): TokenOutcome => {
  if (!deps.claudeTokens) return { kind: "no-store" };
  const token = sub.token.trim();
  if (!isClaudeToken(token)) {
    return {
      kind: "invalid",
      error: token.startsWith("sk-ant-api")
        ? "that is an API key, not a Claude Code token. run `claude setup-token` and paste what it prints"
        : "that does not look like a Claude Code token - it should start with `sk-ant-oat01-`",
    };
  }
  deps.claudeTokens.set(sub.slackUserId, token);
  return { kind: "saved", request: sub.request };
};

/**
 * The token a turn should run under: the speaker's own when they have one.
 * Undefined means "the bot's own credential", which is the CLI's default.
 */
export const tokenFor = (deps: TokenDeps, actor?: Pick<AllowedUser, "slackId">): string | undefined =>
  actor ? deps.claudeTokens?.get(actor.slackId) : undefined;
