/**
 * GitHub App - people call the bot from an issue or PR, and the answer comes
 * back there.
 *
 * A verified webhook delivery is reduced to a trigger (a mention of the app,
 * or the trigger label), checked against the owner allowlist, and recorded on
 * its delivery id - that row is both the dedupe and the queue, so a redelivery
 * is never run twice and a call that arrives during a restart's drain waits
 * for the next process. Handling it mirrors the review inbox: eyes on the
 * comment, GitHub login -> Slack person (explicit link, else exactly one name
 * match), a post in the channel, and a turn in that post's thread AS that
 * person, so their role and their own token apply. Nobody known means one
 * comment on GitHub saying how to link, and nothing runs.
 *
 * The turn posts its answer itself through the comment helper, which can only
 * reach the issue its thread is bound to. If it ends without having posted,
 * its reply is posted for it, so a call from GitHub is always answered there.
 */
import {
  announceTrigger,
  detectTrigger,
  failedRunComment,
  type GithubTrigger,
  githubTurnPrompt,
  isAllowedOwner,
  toGithubComment,
  unknownSenderComment,
} from "../domain/githubApp.ts";
import { isSilenceNote } from "../domain/silence.ts";
import type { AllowedUser } from "../domain/types.ts";
import type { Clock } from "./ports.ts";
import { slackIdOfGithub } from "./reviewInbox.ts";

/** Delivery ids are remembered this long, which covers any manual redelivery. */
export const DELIVERY_RETENTION_MS = 30 * 24 * 60 * 60_000;

export type GithubAppDeps = {
  clock: Clock;
  repo: {
    record: (id: string, trigger: string, at: number) => boolean;
    claim: (at: number, limit?: number) => { id: string; trigger: string }[];
    markPosted: (id: string, channel: string, ts: string, at: number) => void;
    finish: (id: string, state: "done" | "failed", at: number) => void;
    recover: (at: number) => { retried: number; settled: number };
    prune: (before: number) => void;
    bind: (
      t: { channelId: string; threadTs: string; repo: string; number: number; installationId: number },
      at: number,
    ) => void;
    thread: (channelId: string, threadTs: string) => { repo: string; number: number; installationId: number; comments: number } | undefined;
    noteComment: (channelId: string, threadTs: string) => void;
  };
  github: {
    react: (installationId: number, path: string, content: string) => Promise<void>;
    comment: (installationId: number, repo: string, number: number, body: string) => Promise<string | undefined>;
    userName: (installationId: number, login: string) => Promise<string | undefined>;
  };
  slug: string;
  label: string;
  allowedOwners: readonly string[];
  /** Channel calls are posted into; empty means nowhere, and nothing runs. */
  channel: () => string;
  settings: { get: (key: string) => string | undefined };
  users: { get: (slackId: string) => AllowedUser | undefined; list: () => AllowedUser[] };
  /** Post; returns the ts so the turn can run in its thread. */
  post: (channel: string, text: string, threadTs?: string) => Promise<string | undefined>;
  /** Run a turn as `actor` in a thread; resolves with its final reply. */
  runTurn: (req: { actor: AllowedUser; channelId: string; threadTs: string; text: string }) => Promise<string>;
  /** Absolute path of `bin/github-app-comment.sh`, named in the prompt. */
  helperPath: string;
  prefix: string;
  /** While a restart drains, calls stay on their rows for the next process. */
  draining: () => boolean;
  log?: (msg: string) => void;
};

export type GithubApp = {
  /** A verified delivery. Throws only if it could not be stored. */
  receive: (d: { id: string; event: string; payload: unknown }) => void;
  /** Handle whatever is pending. Held while draining. */
  tick: () => Promise<void>;
  /** Boot: hand back calls a dead process never posted. */
  recover: () => void;
  /** A turn's answer, posted as the app to the issue its thread is bound to. */
  commentFromTurn: (req: {
    channelId: string;
    threadTs?: string;
    repo: string;
    number: number;
    body: string;
  }) => Promise<string | undefined>;
};

const isTrigger = (v: unknown): v is GithubTrigger => {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  return !!o && typeof o.repo === "string" && typeof o.number === "number" && typeof o.installationId === "number";
};

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const createGithubApp = (deps: GithubAppDeps): GithubApp => {
  const log = deps.log ?? (() => {});
  let running = false;

  const handle = async (id: string, t: GithubTrigger): Promise<void> => {
    if (t.reactionPath) {
      await deps.github.react(t.installationId, t.reactionPath, "eyes").catch((e) => log(`eyes on ${id}: ${errText(e)}`));
    }
    const slackId = await slackIdOfGithub(
      {
        settings: deps.settings,
        users: deps.users,
        githubName: (login) => deps.github.userName(t.installationId, login),
      },
      t.sender,
    );
    const actor = slackId ? deps.users.get(slackId) : undefined;
    if (!actor) {
      log(`${t.repo}#${t.number}: cannot place ${t.sender} on Slack`);
      await deps.github.comment(t.installationId, t.repo, t.number, unknownSenderComment(t.sender, deps.prefix));
      deps.repo.finish(id, "done", deps.clock());
      return;
    }
    const channel = deps.channel().trim();
    if (!channel) {
      log(`${t.repo}#${t.number}: no channel set, so nothing runs`);
      deps.repo.finish(id, "failed", deps.clock());
      return;
    }
    const ts = await deps.post(channel, announceTrigger(t, actor.slackId, deps.label));
    if (!ts) {
      log(`${t.repo}#${t.number}: could not post into ${channel}`);
      deps.repo.finish(id, "failed", deps.clock());
      return;
    }
    // Posted: from here a crash must settle the row, never post it again.
    deps.repo.markPosted(id, channel, ts, deps.clock());
    deps.repo.bind(
      { channelId: channel, threadTs: ts, repo: t.repo, number: t.number, installationId: t.installationId },
      deps.clock(),
    );
    deps.repo.finish(id, "done", deps.clock());

    // Not awaited: a turn takes minutes and the next call should not wait on it.
    const before = deps.repo.thread(channel, ts)?.comments ?? 0;
    const answered = () => (deps.repo.thread(channel, ts)?.comments ?? 0) > before;
    void deps
      .runTurn({ actor, channelId: channel, threadTs: ts, text: githubTurnPrompt(t, deps.helperPath) })
      .then(async (reply) => {
        if (answered()) return;
        const body = toGithubComment(reply);
        if (!body || isSilenceNote(reply)) return;
        await deps.github.comment(t.installationId, t.repo, t.number, body);
      })
      .catch(async (e) => {
        log(`turn for ${t.repo}#${t.number} failed: ${errText(e)}`);
        if (!answered()) await deps.github.comment(t.installationId, t.repo, t.number, failedRunComment()).catch(() => undefined);
      });
  };

  const tick = async (): Promise<void> => {
    if (running || deps.draining()) return;
    running = true;
    try {
      for (;;) {
        const batch = deps.repo.claim(deps.clock());
        if (batch.length === 0) return;
        for (const row of batch) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(row.trigger) as unknown;
          } catch {
            parsed = undefined;
          }
          if (!isTrigger(parsed)) {
            log(`delivery ${row.id} has no readable trigger`);
            deps.repo.finish(row.id, "failed", deps.clock());
            continue;
          }
          try {
            await handle(row.id, parsed);
          } catch (e) {
            log(`delivery ${row.id} failed: ${errText(e)}`);
            deps.repo.finish(row.id, "failed", deps.clock());
          }
        }
      }
    } finally {
      running = false;
    }
  };

  return {
    receive: ({ id, event, payload }) => {
      const decision = detectTrigger(event, id, payload, { slug: deps.slug, label: deps.label });
      if (decision.kind === "ignore") {
        log(`ignored ${id}: ${decision.reason}`);
        return;
      }
      const t = decision.trigger;
      if (!isAllowedOwner(t.owner, deps.allowedOwners)) {
        log(`ignored ${id}: ${t.owner} is not an allowed owner (${t.repo})`);
        return;
      }
      const now = deps.clock();
      deps.repo.prune(now - DELIVERY_RETENTION_MS);
      if (!deps.repo.record(id, JSON.stringify(t), now)) {
        log(`ignored ${id}: already seen`);
        return;
      }
      void tick().catch((e) => log(`tick failed: ${errText(e)}`));
    },
    tick,
    recover: () => {
      const { retried, settled } = deps.repo.recover(deps.clock());
      if (retried || settled) log(`after restart: ${retried} call(s) handed out again, ${settled} settled`);
    },
    commentFromTurn: async ({ channelId, threadTs, repo, number, body }) => {
      const bound = threadTs ? deps.repo.thread(channelId, threadTs) : undefined;
      if (!bound) throw new Error("this thread was not opened from GitHub, so there is nowhere to post");
      if (bound.repo.toLowerCase() !== repo.toLowerCase() || bound.number !== number) {
        throw new Error(`this thread belongs to ${bound.repo}#${bound.number}, not ${repo}#${number}`);
      }
      const text = toGithubComment(body);
      if (!text) throw new Error("empty comment");
      const url = await deps.github.comment(bound.installationId, bound.repo, bound.number, text);
      deps.repo.noteComment(channelId, threadTs ?? "");
      return url;
    },
  };
};
