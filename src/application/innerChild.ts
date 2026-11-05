/**
 * The inner child: always on, it watches the bot's own conversations and
 * fixes the bot when it finds something broken.
 *
 * It rides the watcher's timer, outside every turn. Each tick does two cheap
 * things and, at most every `triageEveryMs`, one expensive one:
 * - a fix that has run far too long is written off, so the queue cannot jam
 * - the next queued issue is started, when nothing else is being fixed and the
 *   daily cap allows - announced in the channel BEFORE it runs, and its result
 *   posted in that thread AFTER
 * - the turns that ended since the last look are triaged by the model, and
 *   every new defect is filed as queued
 *
 * Nobody approves a fix, by request. What keeps that safe is everything
 * around it: one fix at a time, a daily cap, a fingerprint per defect so the
 * same one is never filed twice, its own fix threads excluded from triage so
 * it never chases itself, and the restart script refusing a red build.
 */
import {
  afterNotice,
  beforeNotice,
  byUrgency,
  fixPrompt,
  parseFindings,
  readOutcome,
  triageMessage,
  triageSystem,
  type IssueBrief,
  type ObservedTurn,
} from "../domain/innerChild.ts";
import type { MessageRepo } from "../infrastructure/db/messageRepo.ts";
import type { SelfIssue, SelfIssueRepo } from "../infrastructure/db/selfIssueRepo.ts";
import type { TurnLogRepo } from "../infrastructure/db/turnLogRepo.ts";
import type { Clock, LlmPort } from "./ports.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export type InnerChildDeps = {
  turns: Pick<TurnLogRepo, "since">;
  messages: Pick<MessageRepo, "recentForThread">;
  issues: SelfIssueRepo;
  llm: LlmPort;
  clock: Clock;
  /** Where fixes are announced and run. */
  channelId: string;
  /** Whose turn a fix runs as - it needs full access to edit the source. */
  ownerSlackId: string;
  botName: () => string;
  sourceDir: string;
  restartScript: string;
  /** Tools denied to the triage run: it reads text, it never acts. */
  noTools: readonly string[];
  /** Off switch, read every tick. */
  enabled: () => boolean;
  /** Where the last triage stopped, so a restart does not re-read or skip. */
  cursor: { get: () => number | undefined; set: (at: number) => void };
  post: (channel: string, text: string, threadTs?: string) => Promise<{ ts: string } | void>;
  /** Run the fix as a turn in that thread and resolve with its reply. */
  runFix: (req: { channelId: string; threadTs: string; slackUserId: string; text: string }) => Promise<string>;
  triageEveryMs?: number;
  maxFixesPerDay?: number;
  /** A fix older than this is written off as failed. */
  fixTimeoutMs?: number;
  log?: (msg: string) => void;
};

export type InnerChild = {
  tick: () => Promise<void>;
};

/** Most a single triage reads, and most it may file. */
const TRIAGE_BATCH = 60;
const MAX_FILED_PER_TRIAGE = 5;

export const brief = (i: SelfIssue): IssueBrief => ({
  id: i.id,
  title: i.title,
  severity: i.severity,
  evidence: i.evidence,
  sourceChannel: i.sourceChannel,
  sourceThread: i.sourceThread,
});

export const createInnerChild = (deps: InnerChildDeps): InnerChild => {
  const log = deps.log ?? (() => {});
  const triageEvery = deps.triageEveryMs ?? 10 * 60 * 1000;
  const maxPerDay = deps.maxFixesPerDay ?? 4;
  const fixTimeout = deps.fixTimeoutMs ?? 2 * 60 * 60 * 1000;
  let running = false;
  let lastTriage = 0;
  let booted = false;

  const replyTo = (channelId: string, threadTs: string, startedAt: number): string => {
    const after = deps.messages
      .recentForThread(channelId, threadTs, 10)
      .filter((m) => m.role === "assistant" && m.createdAt >= startedAt);
    return after[after.length - 1]?.content ?? "";
  };

  /**
   * A fix runs inside this process, so on the first tick after a boot any
   * issue still marked fixing lost its run with the old process. Later on,
   * one that has run past `fixTimeout` is written off the same way - either
   * would otherwise hold the one-at-a-time slot for ever.
   */
  const writeOffStale = async (now: number): Promise<void> => {
    const firstLook = !booted;
    booted = true;
    for (const i of deps.issues.fixing()) {
      if (!firstLook && now - i.startedAt < fixTimeout) continue;
      deps.issues.settle(i.id, "failed", now);
      const why = firstLook ? "a restart cut it off" : "it never reported back";
      await deps.post(i.fixChannel, afterNotice(i.id, "failed", why), i.fixThread).catch(() => {});
    }
  };

  const fix = async (issue: SelfIssue, threadTs: string): Promise<void> => {
    try {
      const reply = await deps.runFix({
        channelId: deps.channelId,
        threadTs,
        slackUserId: deps.ownerSlackId,
        text: fixPrompt(brief(issue), deps.sourceDir, deps.restartScript),
      });
      const outcome = readOutcome(reply);
      deps.issues.settle(issue.id, outcome, deps.clock());
      await deps.post(deps.channelId, afterNotice(issue.id, outcome), threadTs);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`issue ${issue.id} fix failed: ${msg}`);
      deps.issues.settle(issue.id, "failed", deps.clock());
      await deps.post(deps.channelId, afterNotice(issue.id, "failed", msg), threadTs).catch(() => {});
    }
  };

  const startNext = async (now: number): Promise<void> => {
    if (deps.issues.fixing().length > 0) return;
    if (deps.issues.startedSince(now - DAY_MS) >= maxPerDay) return;
    const issue = deps.issues.nextQueued();
    if (!issue) return;
    // Announce first. If the announcement cannot land the fix does not start:
    // a self-fix nobody was told about is exactly what was ruled out.
    const posted = await deps.post(deps.channelId, beforeNotice(brief(issue)));
    if (!posted) {
      log(`issue ${issue.id}: the announcement did not post, leaving it queued`);
      return;
    }
    deps.issues.startFix(issue.id, deps.channelId, posted.ts, now);
    // Not awaited: a fix runs for many minutes and the timer must keep ticking.
    void fix(issue, posted.ts);
  };

  const triage = async (now: number): Promise<void> => {
    const cursor = deps.cursor.get();
    // The first look starts from now. Triaging all of history on the first
    // boot would file every old complaint as new.
    if (cursor === undefined) {
      deps.cursor.set(now);
      return;
    }
    const entries = deps.turns
      .since(cursor + 1, TRIAGE_BATCH)
      .filter((t) => t.endedAt > cursor && !deps.issues.isFixThread(t.channelId, t.threadTs));
    const newest = entries.reduce((max, t) => Math.max(max, t.endedAt), cursor);
    // Moved on before the model runs: a triage that keeps failing must not
    // pay for the same batch every ten minutes.
    deps.cursor.set(newest);
    if (entries.length === 0) return;

    const observed: ObservedTurn[] = [...entries].reverse().map((t) => ({
      channelId: t.channelId,
      threadTs: t.threadTs,
      slackUserId: t.slackUserId,
      kind: t.kind,
      outcome: t.outcome,
      error: t.error,
      request: t.request,
      reply: replyTo(t.channelId, t.threadTs, t.startedAt),
    }));
    const raw = await deps.llm.complete({
      system: triageSystem(deps.botName()),
      messages: [
        { role: "user", content: triageMessage(observed, deps.issues.recentTitles(30)), speakerId: deps.ownerSlackId },
      ],
      policy: { skipPermissions: false, disallowedTools: deps.noTools },
      bill: { actor: deps.ownerSlackId, kind: "inner-child", channel: deps.channelId },
    });
    const filed = byUrgency(parseFindings(raw))
      .slice(0, MAX_FILED_PER_TRIAGE)
      .map((f) => deps.issues.file(f, now))
      .filter((i): i is SelfIssue => i !== undefined);
    if (filed.length) log(`filed ${filed.map((i) => `#${i.id}`).join(", ")}`);
  };

  return {
    tick: async () => {
      if (running || !deps.enabled()) return;
      running = true;
      try {
        const now = deps.clock();
        await writeOffStale(now);
        if (now - lastTriage >= triageEvery) {
          lastTriage = now;
          await triage(now).catch((e) => log(`triage failed: ${e instanceof Error ? e.message : String(e)}`));
        }
        await startNext(deps.clock());
      } catch (e) {
        log(`tick failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        running = false;
      }
    },
  };
};
