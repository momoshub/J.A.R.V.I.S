/**
 * A fingerprint of the rules the bot is currently operating under.
 *
 * A thread holds one CLI session, resumed turn after turn. The system prompt is
 * passed on every run, but the session also carries everything it has already
 * said - and a model weighs its own past behaviour heavily. So a rule change
 * does NOT reach a thread that is already running: the fix ships, the tests
 * pass, the prompt is verifiably correct, and the thread carries on exactly as
 * before. That happened three times with one language rule before anyone
 * worked out why.
 *
 * So a session records the rules it was opened under. When they change, it is
 * abandoned and the thread starts a fresh one with the thread read back in -
 * the same path a session that the CLI has forgotten already takes.
 *
 * Deliberately NOT included: anything that varies per turn (who is present,
 * which messages are reactable, the run ticket) or learnings, which are added
 * often and are additive rather than behavioural. Only the rules.
 *
 * The memory adapter is split along the same line. Its policy and skill index
 * ARE rules - they change how the bot behaves everywhere - so they are hashed.
 * Its notes, scoped or global, are not: a note is taught often and adds to what
 * the bot knows rather than changing what it does, and hashing those would
 * reset every open thread the moment anybody said "remember this".
 */
import { createHash } from "node:crypto";

/** Fixed stand-ins, so every optional block renders and is therefore covered. */
const SENTINELS = {
  botName: "fingerprint",
  commandPrefix: "//fp",
  grafanaGetScript: "/fp/grafana",
  fileScript: "/fp/file",
  reactScript: "/fp/react",
  runScript: "/fp/run",
  runUrl: "http://fp/run",
  learnUrl: "http://fp/learn",
  slackReadScript: "/fp/slack",
  repoPath: "/fp/repo",
  restartScript: "/fp/restart",
  logSources: ["grafana", "datadog"] as const,
  canRaiseTickets: true,
  commandBudget: 50,
  following: true,
};

/**
 * `build` is `buildSystemPrompt`, passed in rather than imported so this stays
 * a pure function of the rules and cannot drag the whole prompt module into
 * places that only need the hash.
 */
export const promptFingerprint = (
  build: (opts: Record<string, unknown>) => string,
  base?: string,
  /** The adapter's always-on rules: its policy and the skill index, if any. */
  adapterRules?: string,
): string =>
  createHash("sha256")
    .update(build({ ...SENTINELS, logSources: [...SENTINELS.logSources], learnings: [], base }))
    .update(adapterRules ?? "")
    .digest("hex")
    .slice(0, 16);
