/**
 * `cloudwatch`: ask, confirm, run, audit.
 *
 * The rule (domain/cloudwatch.ts): the owner is warned and runs straight away,
 * executer and admin get a Confirm / Cancel message and nothing runs until the
 * requester (or the owner) presses Confirm, anyone else is refused. The press
 * is handled HERE, in code - the `jv:cloudwatch:` buttons are never handed to
 * the model, because a model that could press its own Confirm would make the
 * guard decorative.
 */
import {
  CANCEL_ACTION,
  CONFIRM_ACTION,
  CONFIRM_TTL_MS,
  DEFAULT_REGION,
  cloudwatchMode,
  confirmText,
  costWarning,
  estimateOf,
  formatResult,
  parseCloudwatchArgs,
  refusal,
  requestSummary,
  settledText,
  type CloudwatchRequest,
  type Estimate,
  type GroupInfo,
  type QueryResult,
} from "../domain/cloudwatch.ts";
import { SIGNATURES } from "../domain/messageFooter.ts";
import type { AllowedUser } from "../domain/types.ts";
import type { Clock } from "./ports.ts";
import type { SlackAdminPort } from "./slackAdmin.ts";
import { logAndIgnore } from "./ignoredError.ts";
import type { CloudwatchRepo, StoredCloudwatch } from "../infrastructure/db/cloudwatchRepo.ts";
import type { SettingsRepo } from "../infrastructure/db/settingsRepo.ts";
import { SETTING_KEYS } from "../infrastructure/db/settingsRepo.ts";
import type { UserRepo } from "../infrastructure/db/userRepo.ts";

/** What the command needs from AWS. The adapter is `infrastructure/aws/cloudwatchCli.ts`. */
export type CloudwatchPort = {
  /** The named groups that exist, with their stored size. A name AWS does not know is left out. */
  describeGroups: (names: readonly string[], region: string) => Promise<GroupInfo[]>;
  /** Run an Insights query to completion (or stop it when `signal` aborts or it runs too long). */
  runQuery: (req: CloudwatchRequest, signal?: AbortSignal) => Promise<QueryResult>;
};

export type CloudwatchDeps = {
  aws: CloudwatchPort;
  repo: CloudwatchRepo;
  users: UserRepo;
  slack?: SlackAdminPort;
  settings?: SettingsRepo;
  clock: Clock;
  ownerSlackId: string;
  /** How long a Confirm message stays live. */
  ttlMs?: number;
  /** Timer for settling an unanswered request; injected so tests need not wait. */
  timer?: (fn: () => void, ms: number) => void;
  log?: (msg: string) => void;
};

const ttlOf = (deps: CloudwatchDeps): number => deps.ttlMs ?? CONFIRM_TTL_MS;
const logOf = (deps: CloudwatchDeps) => deps.log ?? ((m: string) => console.log(`[cloudwatch] ${m}`));

export type Prepared = { request: CloudwatchRequest; groups: GroupInfo[]; estimate: Estimate };

/** Parse, check the groups exist, estimate the scan. A string is what to tell the person. */
export const prepare = async (deps: CloudwatchDeps, args: readonly string[], usage: string): Promise<Prepared | string> => {
  const parsed = parseCloudwatchArgs(args, deps.clock(), {
    region: deps.settings?.get(SETTING_KEYS.cloudwatchRegion) || DEFAULT_REGION,
    group: deps.settings?.get(SETTING_KEYS.cloudwatchGroup) || undefined,
  });
  if (!parsed.ok) return `${parsed.error}.\n\`${usage}\``;
  const { request } = parsed;
  let groups: GroupInfo[];
  try {
    groups = await deps.aws.describeGroups(request.groups, request.region);
  } catch (err) {
    return `I could not look up the log group${request.groups.length === 1 ? "" : "s"}: ${err instanceof Error ? err.message : String(err)}`;
  }
  const missing = request.groups.filter((g) => !groups.some((k) => k.name === g));
  if (missing.length > 0) {
    return `No such log group in ${request.region}: ${missing.map((g) => `\`${g}\``).join(", ")}. Nothing ran.`;
  }
  return { request, groups, estimate: estimateOf(request, groups, deps.clock()) };
};

export type AskContext = {
  actor: AllowedUser;
  channelId: string;
  threadTs?: string;
  /** Post into the invocation's destination, when the transport wired one. */
  reply?: (text: string) => Promise<void>;
  usage: string;
};

/** Run a stored request now and return what to post. Records the outcome either way. */
export const execute = async (deps: CloudwatchDeps, stored: StoredCloudwatch, confirmedBy: string): Promise<string> => {
  const log = logOf(deps);
  log(`#${stored.id} run by ${stored.requestedBy}, confirmed by ${confirmedBy}: ${stored.request.groups.join(",")} ${stored.request.region} ${new Date(stored.request.startMs).toISOString()}..${new Date(stored.request.endMs).toISOString()} query=${JSON.stringify(stored.request.query)}`);
  try {
    const res = await deps.aws.runQuery(stored.request);
    deps.repo.finish(stored.id, { ok: true, scannedBytes: res.bytesScanned, recordsMatched: res.recordsMatched }, deps.clock());
    log(`#${stored.id} ${res.status}: ${res.rows.length} rows, ${res.bytesScanned} bytes scanned`);
    return formatResult(stored.request, res, stored.mode, confirmedBy);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.repo.finish(stored.id, { ok: false, error: message }, deps.clock());
    log(`#${stored.id} failed: ${message}`);
    return `⚠️ CloudWatch query #${stored.id} failed: ${message}`;
  }
};

/**
 * The command body. `confirm` roles get the buttons (and an empty string back,
 * the message is the answer); the owner gets the warning and the result.
 */
export const askCloudwatch = async (deps: CloudwatchDeps, ask: AskContext, args: readonly string[]): Promise<string> => {
  const { actor, channelId, threadTs } = ask;
  const mode = cloudwatchMode(actor.role);
  if (mode === "refuse") return refusal(actor.role);

  const prepared = await prepare(deps, args, ask.usage);
  if (typeof prepared === "string") return prepared;
  const { request, estimate } = prepared;

  const base = {
    requestedBy: actor.slackId,
    requesterRole: actor.role,
    channelId,
    threadTs: threadTs ?? "",
    request,
    estimateBytes: estimate.bytes,
    costly: estimate.costly,
  };

  if (mode === "run") {
    const stored = deps.repo.open({ ...base, mode: "run" }, deps.clock());
    const warning = `${requestSummary(request)}\n${costWarning(estimate)}`;
    if (ask.reply) await ask.reply(warning).catch(logAndIgnore("cloudwatch owner warning"));
    const result = await execute(deps, stored, actor.slackId);
    return ask.reply ? result : `${warning}\n${result}`;
  }

  // executer / admin: park it, post the buttons, run nothing.
  if (!deps.slack?.postInteractive) {
    return "I cannot post the Confirm / Cancel message from here, so nothing ran. Ask again in a channel or thread.";
  }
  const stored = deps.repo.open({ ...base, mode: "confirm" }, deps.clock());
  const notice = await deps.slack
    .postInteractive(
      channelId,
      confirmText(actor.slackId, request, estimate, ttlOf(deps)),
      [
        { actionId: CONFIRM_ACTION, label: "Confirm and run", value: String(stored.id), style: "danger" },
        { actionId: CANCEL_ACTION, label: "Cancel", value: String(stored.id) },
      ],
      threadTs,
      SIGNATURES.command,
    )
    .catch(logAndIgnore("cloudwatch confirm post"));
  if (!notice) {
    deps.repo.cancel(stored.id, "system", deps.clock());
    return "I could not post the Confirm / Cancel message, so nothing ran.";
  }
  deps.repo.setNotice(stored.id, notice.channel, notice.ts);
  // Settle the message when nobody answers. Best effort: a restart loses the
  // timer, and the press check below still refuses an expired request.
  (deps.timer ?? ((fn, ms) => void setTimeout(fn, ms).unref?.()))(() => {
    if (deps.repo.expire(stored.id, deps.clock(), ttlOf(deps))) {
      void deps.slack?.settleInteractive(notice.channel, notice.ts, settledText("expired"), SIGNATURES.command).catch(logAndIgnore("cloudwatch expiry settle"));
    }
  }, ttlOf(deps) + 1_000);
  return "";
};

export type PressOutcome =
  | { kind: "ran"; id: number }
  | { kind: "cancelled"; id: number }
  | { kind: "refused"; requester: string }
  | { kind: "expired" | "decided" | "unknown" };

/**
 * A Confirm or Cancel press. Only the requester or the owner counts, and a
 * requester who has since lost the right to ask (removed, demoted to pal) is
 * not run on behalf of: the stored request is a claim on their role at the
 * time, not a standing grant.
 */
export const decideCloudwatch = async (
  deps: CloudwatchDeps,
  press: { slackUserId: string; actionId: string; value: string },
): Promise<PressOutcome> => {
  if (press.actionId !== CONFIRM_ACTION && press.actionId !== CANCEL_ACTION) return { kind: "unknown" };
  const stored = deps.repo.get(Number(press.value));
  if (!stored || stored.mode !== "confirm") return { kind: "unknown" };
  const owner = press.slackUserId === deps.ownerSlackId;
  if (!owner && press.slackUserId !== stored.requestedBy) return { kind: "refused", requester: stored.requestedBy };

  const now = deps.clock();
  const settle = (text: string) =>
    stored.noticeChannel && stored.noticeTs
      ? deps.slack?.settleInteractive(stored.noticeChannel, stored.noticeTs, text, SIGNATURES.command).catch(logAndIgnore("cloudwatch settle"))
      : undefined;
  const say = (text: string) =>
    deps.slack?.post(stored.channelId, text, stored.threadTs || undefined, SIGNATURES.command).catch(logAndIgnore("cloudwatch result post"));

  if (press.actionId === CANCEL_ACTION) {
    if (!deps.repo.cancel(stored.id, press.slackUserId, now)) return { kind: "decided" };
    await settle(settledText("cancelled", press.slackUserId));
    logOf(deps)(`#${stored.id} cancelled by ${press.slackUserId}`);
    return { kind: "cancelled", id: stored.id };
  }

  if (!deps.repo.claim(stored.id, press.slackUserId, now, ttlOf(deps))) {
    // Not pending, or too old. Tell the two apart so an expiry is recorded as one.
    if (deps.repo.expire(stored.id, now, ttlOf(deps))) {
      await settle(settledText("expired"));
      return { kind: "expired" };
    }
    return { kind: "decided" };
  }
  const requester = deps.users.get(stored.requestedBy);
  if (!requester || cloudwatchMode(requester.role) === "refuse") {
    deps.repo.finish(stored.id, { ok: false, error: "requester no longer allowed" }, now);
    await settle("⚠️ not run - the requester is no longer allowed to run CloudWatch queries");
    return { kind: "decided" };
  }
  await settle(settledText("confirmed", press.slackUserId));
  const result = await execute(deps, stored, press.slackUserId);
  await say(result);
  return { kind: "ran", id: stored.id };
};
