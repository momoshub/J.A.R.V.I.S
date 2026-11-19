/**
 * Auto review - a review that starts because somebody asked for one on GitHub.
 *
 * Two doors lead here. A request to the GitHub App (a mention of it asking for
 * a review on a PR, its trigger label, or a review requested from the app
 * itself) is answered AS THE APP; a request to the host's own GitHub account
 * (the review inbox poll) is answered as that account. The approval, when the
 * review comes back clean, is the host's account either way - never the app's.
 * Both doors run the very command a person types (`quick-review`, see
 * `startReview`), so the review policy, the CI gate and blockers-only all hold;
 * only the identity differs.
 *
 * What this module adds around that command:
 * - one Slack thread per PR, in the review inbox channel: the first event
 *   opens it, every later one (another request, a comment, a change request,
 *   an approval) goes into it, and the review itself runs in it;
 * - one review per PR head per identity: a redelivery, a second poll or a
 *   re-request on the same head never runs twice, and a push is not reviewed
 *   until it is asked for again;
 * - the requester's own Claude token pays. Nobody known, or no token on file:
 *   nothing runs, and the thread asks the owner - in code, only the owner's
 *   press counts (application/reviewRunApproval.ts) - whether to run it on the
 *   owner's or the bot's credential.
 */
import { isAllowedOwner } from "../domain/githubApp.ts";
import {
  activityText,
  type ActivityLine,
  alreadyReviewedText,
  askText,
  type AskLine,
  failedReviewText,
  prKeyOf,
  rejectedNote,
  requestedText,
  REVIEW_RUN_APPROVE_ACTION,
  REVIEW_RUN_REJECT_ACTION,
  sameLogin,
  type ReviewIdentity,
} from "../domain/reviewIdentity.ts";
import type { AllowedUser } from "../domain/types.ts";
import type { ReviewRun, ReviewRunRepo } from "../infrastructure/db/reviewRunRepo.ts";
import { logAndIgnore } from "./ignoredError.ts";
import type { ReviewStart } from "./commands.ts";
import type { Clock } from "./ports.ts";
import { slackIdOfGithub, type GithubIdentityDeps } from "./reviewInbox.ts";
import type { InteractiveAction } from "./slackAdmin.ts";

/** Somebody asked for a review. */
export type ReviewAsk = {
  readonly identity: ReviewIdentity;
  readonly url: string;
  /** `owner/repo`. */
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  /** GitHub login of whoever asked. */
  readonly requester: string;
  /** The app's installation, when the ask came through it. */
  readonly installationId?: number;
  /** What the asker said next to the request; steers the review. */
  readonly note?: string;
};

export type AskOutcome = "started" | "asked" | "duplicate" | "off" | "no-channel" | "refused" | "unreadable" | "unposted";

export type AutoReviewDeps = {
  clock: Clock;
  runs: ReviewRunRepo;
  /** `review_auto`: the switch. Off, a request is not reviewed (the inbox only announces it). */
  enabled: () => boolean;
  /** The review inbox channel every PR thread lives in; empty means nowhere to post. */
  channel: () => string;
  /** How a GitHub login is placed on Slack, as for every call from GitHub. */
  identity: GithubIdentityDeps;
  users: { get: (slackId: string) => AllowedUser | undefined };
  /** Who has a Claude Code token on file. The token itself never passes through here. */
  hasToken: (slackId: string) => boolean;
  ownerSlackId: string;
  /** Owners the app may act for; a request to the app on any other owner's repo is ignored. */
  allowedOwners: readonly string[];
  /** The commit a PR is at; undefined when it cannot be read (then nothing runs: there is nothing to dedupe on). */
  headSha: (prUrl: string) => Promise<string | undefined>;
  /** The login each identity writes as, for the line that announces the request. */
  account: (identity: ReviewIdentity) => Promise<string | undefined>;
  /** Accounts whose own activity is not news: the app and the host's account, whose posts the review already announced. */
  ownLogins: () => Promise<readonly string[]>;
  post: (channel: string, text: string, threadTs?: string) => Promise<string | undefined>;
  /** Post a message with buttons into a thread. */
  postInteractive: (
    channel: string,
    text: string,
    actions: readonly InteractiveAction[],
    threadTs: string,
  ) => Promise<{ channel: string; ts: string } | undefined>;
  /** Run the quick review, as `startReview` does. */
  review: (start: ReviewStart) => Promise<string>;
  prefix: string;
  log?: (msg: string) => void;
};

export type AutoReview = {
  /** A review was asked for. Never throws. */
  request: (ask: ReviewAsk) => Promise<AskOutcome>;
  /** Other people's activity on a PR: a line in its thread when it has one. True when it landed. */
  activity: (a: ActivityLine & { repo: string; number: number }) => Promise<boolean>;
  /** The owner decided a pending ask (the press is already checked and the row moved): run it or say no. */
  resolve: (run: ReviewRun, decision: "approved" | "rejected", by: string) => Promise<void>;
  /** Boot: reviews a dead process was in the middle of can be asked for again. */
  recover: () => number;
};

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const askLineOf = (run: ReviewRun, ownerSlackId: string): AskLine => ({
  asker: { login: run.requester, ...(run.requesterSlack ? { slackId: run.requesterSlack } : {}) },
  reason: run.askReason === "unknown" ? "unknown" : "no-token",
  ownerSlackId,
  identity: run.identity,
  url: run.url,
  repo: run.repo,
  number: run.number,
});

export const createAutoReview = (deps: AutoReviewDeps): AutoReview => {
  const log = deps.log ?? (() => {});
  // One thing at a time per PR, so two requests that arrive together open one thread, not two.
  const chains = new Map<string, Promise<unknown>>();
  const locked = <T>(key: string, job: () => Promise<T>): Promise<T> => {
    const next = (chains.get(key) ?? Promise.resolve()).then(job, job);
    chains.set(key, next);
    void next.finally(() => chains.get(key) === next && chains.delete(key));
    return next;
  };

  /** The PR's thread: the first call opens it with `opening`, later ones add `opening` into it. */
  const thread = async (channel: string, prKey: string, opening: string): Promise<{ channelId: string; threadTs: string } | undefined> => {
    const existing = deps.runs.thread(prKey);
    if (existing) {
      await deps.post(existing.channelId, opening, existing.threadTs).catch(logAndIgnore("review thread post"));
      return { channelId: existing.channelId, threadTs: existing.threadTs };
    }
    const ts = await deps.post(channel, opening).catch(logAndIgnore("review thread open") as () => undefined);
    if (!ts) return undefined;
    deps.runs.setThread(prKey, { channelId: channel, threadTs: ts }, deps.clock());
    return { channelId: channel, threadTs: ts };
  };

  /** Run the review of a row already moved to `running`, in its PR's thread. */
  const execute = async (run: ReviewRun, actor: AllowedUser, botCredentialOk: boolean): Promise<void> => {
    const where = deps.runs.thread(run.prKey);
    if (!where) {
      deps.runs.move(run.id, ["running"], "failed", deps.clock());
      log(`${run.url}: no thread to run the review in`);
      return;
    }
    const say = (text: string): Promise<void> =>
      deps.post(where.channelId, text, where.threadTs).then(() => undefined, logAndIgnore("review thread reply"));
    try {
      const out = await deps.review({
        actor,
        channelId: where.channelId,
        threadTs: where.threadTs,
        url: run.url,
        ...(run.note ? { note: run.note } : {}),
        identity: run.identity,
        botCredentialOk,
        reply: say,
        prefix: deps.prefix,
      });
      if (out.trim()) await say(out.trim());
      deps.runs.move(run.id, ["running"], "done", deps.clock());
    } catch (e) {
      log(`${run.url}: review failed: ${errText(e)}`);
      deps.runs.move(run.id, ["running"], "failed", deps.clock());
      await say(failedReviewText(run.url, errText(e)));
    }
  };

  const handle = async (ask: ReviewAsk, channel: string, sha: string): Promise<AskOutcome> => {
    const prKey = prKeyOf(ask.repo, ask.number);
    const run = deps.runs.claim(
      {
        prKey,
        headSha: sha,
        identity: ask.identity,
        url: ask.url,
        repo: ask.repo,
        number: ask.number,
        title: ask.title,
        requester: ask.requester,
        note: ask.note ?? "",
        installationId: ask.installationId ?? 0,
      },
      deps.clock(),
    );
    if (!run) {
      const existing = deps.runs.thread(prKey);
      if (existing) await deps.post(existing.channelId, alreadyReviewedText(sha), existing.threadTs).catch(logAndIgnore("review duplicate note"));
      log(`${ask.url}@${sha.slice(0, 7)} (${ask.identity}): already has a review`);
      return "duplicate";
    }

    const slackId = await slackIdOfGithub(deps.identity, ask.requester);
    if (slackId) deps.runs.setRequesterSlack(run.id, slackId, deps.clock());
    const account = (await deps.account(ask.identity).catch(logAndIgnore("review account") as () => undefined)) ?? "me";
    const opened = await thread(
      channel,
      prKey,
      requestedText({
        asker: { login: ask.requester, ...(slackId ? { slackId } : {}) },
        identity: ask.identity,
        account,
        url: ask.url,
        repo: ask.repo,
        number: ask.number,
        title: ask.title,
        headSha: sha,
      }),
    );
    if (!opened) {
      deps.runs.move(run.id, ["claimed"], "failed", deps.clock());
      log(`${ask.url}: could not post into ${channel}`);
      return "unposted";
    }

    const actor = slackId ? deps.users.get(slackId) : undefined;
    if (actor && deps.hasToken(actor.slackId)) {
      if (!deps.runs.move(run.id, ["claimed"], "running", deps.clock())) return "duplicate";
      // Not awaited: a review takes minutes and the next request should not wait on it.
      void execute({ ...run, state: "running", requesterSlack: slackId ?? "" }, actor, false);
      return "started";
    }

    // Nobody known, or nobody with a token: nothing runs until the owner says so.
    const reason = actor ? "no-token" : "unknown";
    deps.runs.move(run.id, ["claimed"], "asking", deps.clock());
    const asked = await deps
      .postInteractive(
        opened.channelId,
        askText(askLineOf({ ...run, requesterSlack: slackId ?? "", askReason: reason }, deps.ownerSlackId)),
        [
          { actionId: REVIEW_RUN_APPROVE_ACTION, label: "Approve", value: String(run.id), style: "primary" },
          { actionId: REVIEW_RUN_REJECT_ACTION, label: "Reject", value: String(run.id), style: "danger" },
        ],
        opened.threadTs,
      )
      .catch(logAndIgnore("review ask post") as () => undefined);
    if (!asked) {
      deps.runs.move(run.id, ["asking"], "failed", deps.clock());
      log(`${ask.url}: could not ask the owner`);
      return "unposted";
    }
    deps.runs.setAsk(run.id, asked.channel, asked.ts, reason, deps.clock());
    return "asked";
  };

  return {
    request: async (ask) => {
      try {
        if (!deps.enabled()) return "off";
        const channel = deps.channel().trim();
        if (!channel) {
          log(`${ask.url}: no channel set, so nothing runs`);
          return "no-channel";
        }
        // The app is public, so anybody can install it: it only works for the owners it was set up for.
        if (ask.identity === "app" && !isAllowedOwner(ask.repo.split("/")[0] ?? "", deps.allowedOwners)) {
          log(`${ask.url}: ${ask.repo.split("/")[0]} is not an allowed owner`);
          return "refused";
        }
        const sha = await deps.headSha(ask.url);
        if (!sha) {
          log(`${ask.url}: cannot read the head commit, so nothing runs`);
          return "unreadable";
        }
        return await locked(prKeyOf(ask.repo, ask.number), () => handle(ask, channel, sha));
      } catch (e) {
        log(`${ask.url}: request failed: ${errText(e)}`);
        return "unposted";
      }
    },

    activity: async (a) => {
      const existing = deps.runs.thread(prKeyOf(a.repo, a.number));
      if (!existing) return false;
      const own = await deps.ownLogins().catch(() => [] as string[]);
      if (own.some((l) => sameLogin(l, a.login))) return false;
      const ts = await deps.post(existing.channelId, activityText(a), existing.threadTs).catch(logAndIgnore("review activity post") as () => undefined);
      return !!ts;
    },

    resolve: async (run, decision, by) => {
      const where = deps.runs.thread(run.prKey);
      if (decision === "rejected") {
        if (where) await deps.post(where.channelId, rejectedNote(run.url, by), where.threadTs).catch(logAndIgnore("review reject note"));
        return;
      }
      const owner = deps.users.get(deps.ownerSlackId);
      if (!owner) {
        deps.runs.move(run.id, ["running"], "failed", deps.clock());
        if (where) await deps.post(where.channelId, failedReviewText(run.url, "the owner is not on the access list"), where.threadTs).catch(logAndIgnore("review owner note"));
        return;
      }
      await execute(run, owner, true);
    },

    recover: () => deps.runs.recover(deps.clock()),
  };
};
