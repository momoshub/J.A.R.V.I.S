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
 * A fourth thing rides on the triage: voice drift. A reply that broke the
 * persona's mechanical voice rules (capital paragraph starts, dashes,
 * semicolons, arrows, headings, bold - checked in code; a different language
 * from the thread - one more question in the same model run) is never filed
 * as a defect. The session that wrote it is steered instead: a nudge run as a
 * turn in that thread, never posted there, asks it to re-check the content of
 * that reply and correct anything wrong in a new reply. The drifted message is
 * never touched. Each event is a `drift_events` row, a line in the activity
 * log and a message in the drift log channel, with the session's answer in
 * that message's thread.
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
import {
  detectDrift,
  driftFollowUp,
  driftKey,
  driftLogMessage,
  driftNudge,
  isDriftNudge,
  messageLink,
  parseLanguageDrift,
  pickReplyTs,
  rulesLine,
  type DriftHit,
  type DriftOutcome,
} from "../domain/voiceDrift.ts";
import { isSilenceNote } from "../domain/silence.ts";
import type { DriftEvent, DriftRepo } from "../infrastructure/db/driftRepo.ts";
import type { MessageRepo } from "../infrastructure/db/messageRepo.ts";
import type { SelfIssue, SelfIssueRepo } from "../infrastructure/db/selfIssueRepo.ts";
import type { TurnLogRepo } from "../infrastructure/db/turnLogRepo.ts";
import type { Clock, LlmPort } from "./ports.ts";
import { EMPTY_REPLY_FALLBACK } from "./handleMessage.ts";

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
  /** Voice drift: steer the session that drifted. Absent = drift off. */
  drift?: DriftDeps;
  triageEveryMs?: number;
  maxFixesPerDay?: number;
  /** A fix older than this is written off as failed. */
  fixTimeoutMs?: number;
  log?: (msg: string) => void;
};

export type DriftDeps = {
  events: DriftRepo;
  /** Where each drift event is logged. Empty = drift off. Read every tick. */
  logChannel: () => string;
  /** Messages in a thread, to find the Slack ts of the drifted reply. */
  replies: (channel: string, threadTs: string) => Promise<readonly { ts: string; own: boolean; text: string }[]>;
  /**
   * Run the nudge as a turn in that thread, as that person, on its own
   * session. The nudge itself is never posted there; the turn's reply is,
   * unless it is a silence note. Resolves with the reply and where it landed.
   */
  steer: (req: { channelId: string; threadTs: string; slackUserId: string; text: string }) => Promise<{
    text: string;
    ts?: string;
  }>;
  /** A thread driving a workflow is never steered: a nudge there would reach the worker. */
  workflowActive?: (channel: string, threadTs: string) => boolean;
  /** The activity log. */
  activity?: (event: string, data: Record<string, unknown>) => void;
  maxPerDay?: number;
};

type SteerRequest = { channelId: string; threadTs: string; slackUserId: string; text: string };

/**
 * The real `steer`: the nudge as an ordinary turn through `respond` (same
 * queue, same session, the person's role), posting only a real answer. A
 * refusal, an empty turn, a silence note or the empty-reply placeholder posts
 * nothing - the drifted thread must never get a line nobody asked for. A
 * workflow thread, or a person no longer allowed in, is not run at all: the
 * first would hand the nudge to the worker, the second would raise an access
 * request in their name.
 */
export const steerViaRespond =
  (d: {
    run: (req: SteerRequest) => Promise<{ kind: string; text?: string }>;
    post: (channel: string, text: string, threadTs: string) => Promise<{ ts: string } | void | undefined>;
    workflowActive: (channel: string, threadTs: string) => boolean;
    allowed: (slackUserId: string) => boolean;
  }) =>
  async (req: SteerRequest): Promise<{ text: string; ts?: string }> => {
    if (d.workflowActive(req.channelId, req.threadTs) || !d.allowed(req.slackUserId)) return { text: "" };
    const result = await d.run(req);
    const text = result.kind === "reply" ? (result.text ?? "").trim() : "";
    if (!text) return { text: "" };
    if (isSilenceNote(text) || text === EMPTY_REPLY_FALLBACK) return { text: "nothing to add" };
    const posted = await d.post(req.channelId, text, req.threadTs);
    return { text, ...(posted ? { ts: posted.ts } : {}) };
  };

export type InnerChild = {
  tick: () => Promise<void>;
};

/** Most a single triage reads, and most it may file. */
const TRIAGE_BATCH = 60;
const MAX_FILED_PER_TRIAGE = 5;
/** Nudges a day, across every thread. A bad model day must not become a flood. */
const DRIFT_PER_DAY = 12;
/** A steered turn older than this is written off as unanswered. */
const DRIFT_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/** A finished turn whose reply drifted. */
type DriftCandidate = {
  readonly channelId: string;
  readonly threadTs: string;
  readonly slackUserId: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly messageId: number;
  readonly reply: string;
  readonly hits: DriftHit[];
};

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

  // Bounded by the turn's end as well as its start: a thread's turns run one
  // at a time and the reply is stored before the turn is logged, so anything
  // later belongs to the NEXT turn. Without the upper bound two turns triaged
  // together both got the newer reply, and one looked like it went unanswered.
  const replyTo = (
    channelId: string,
    threadTs: string,
    startedAt: number,
    endedAt: number,
  ): { id: number; content: string } | undefined => {
    const during = deps.messages
      .recentForThread(channelId, threadTs, 10)
      .filter((m) => m.role === "assistant" && m.createdAt >= startedAt && m.createdAt <= endedAt);
    return during[during.length - 1];
  };

  const driftOn = (): string => (deps.drift ? deps.drift.logChannel().trim() : "");

  const settleDrift = async (
    e: DriftEvent,
    outcome: DriftOutcome,
    text: string,
    ts: string,
  ): Promise<void> => {
    const drift = deps.drift;
    if (!drift) return;
    // Settled once: a turn that answers after it was written off says nothing more.
    if (!drift.events.settle(e.id, outcome, text, ts, deps.clock())) return;
    drift.activity?.("inner_child_drift_followup", {
      id: e.id,
      channel: e.channelId,
      thread: e.threadTs,
      outcome,
      followUpTs: ts,
      followUp: text,
    });
    if (!e.logChannel || !e.logTs) return;
    const link = ts ? messageLink(e.channelId, ts, e.threadTs, "correction") : "";
    await deps.post(e.logChannel, driftFollowUp(outcome, text, link), e.logTs).catch(() => {});
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
    // A steered turn runs in this process too: same rule, so the log thread
    // says what happened instead of waiting for ever.
    for (const e of deps.drift?.events.steering() ?? []) {
      if (!firstLook && now - e.steeredAt < DRIFT_TIMEOUT_MS) continue;
      await settleDrift(e, "no_reply", firstLook ? "a restart cut the steered turn off" : "", "");
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

  const steerOne = async (e: DriftEvent, c: DriftCandidate): Promise<void> => {
    const drift = deps.drift;
    if (!drift) return;
    try {
      const res = await drift.steer({
        channelId: c.channelId,
        threadTs: c.threadTs,
        slackUserId: c.slackUserId,
        text: e.nudge,
      });
      const text = res.text.trim();
      const outcome: DriftOutcome = !text ? "no_reply" : isSilenceNote(text) ? "no_change" : "corrected";
      await settleDrift(e, outcome, outcome === "corrected" ? text : "", outcome === "corrected" ? res.ts ?? "" : "");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`drift #${e.id} steer failed: ${msg}`);
      await settleDrift(e, "failed", msg, "");
    }
  };

  /**
   * Steer each drifted reply once: record it (the UNIQUE key is the dedupe),
   * log it in the drift channel, then run the nudge in its thread. Never the
   * inner child's own channel, its fix threads or the log channel, and never a
   * reply to a nudge, so it cannot steer itself into a loop. One open nudge per
   * thread, and a daily cap.
   */
  const steerDrift = async (candidates: readonly DriftCandidate[], now: number): Promise<void> => {
    const drift = deps.drift;
    const logChannel = driftOn();
    if (!drift || !logChannel) return;
    const cap = drift.maxPerDay ?? DRIFT_PER_DAY;
    for (const c of candidates) {
      if (drift.events.steeredSince(now - DAY_MS) >= cap) {
        log("drift: daily cap reached, the rest are not steered");
        return;
      }
      if (drift.events.steering().some((e) => e.channelId === c.channelId && e.threadTs === c.threadTs)) continue;
      const all = await drift.replies(c.channelId, c.threadTs).catch(() => []);
      const replyTs = pickReplyTs(all, c.startedAt, c.endedAt, c.reply) ?? "";
      const nudge = driftNudge(c.hits);
      const e = drift.events.record(
        {
          channelId: c.channelId,
          threadTs: c.threadTs,
          replyKey: driftKey(c.channelId, replyTs, c.messageId),
          replyTs,
          rules: c.hits.map((h) => h.rule).join(","),
          excerpt: c.hits[0]?.excerpt ?? "",
          nudge,
        },
        now,
      );
      if (!e) continue;
      drift.activity?.("inner_child_drift", {
        id: e.id,
        channel: c.channelId,
        thread: c.threadTs,
        replyTs,
        rules: rulesLine(c.hits),
        excerpt: e.excerpt,
        nudge,
      });
      // Logged before it is sent, like a fix is announced before it runs: a
      // nudge nobody can review afterwards is what was ruled out.
      const posted = await deps
        .post(logChannel, driftLogMessage({ id: e.id, channelId: c.channelId, threadTs: c.threadTs, replyTs, hits: c.hits, nudge }))
        .catch(() => undefined);
      if (!posted) {
        log(`drift #${e.id}: the log message did not post, not steering`);
        drift.events.settle(e.id, "failed", "the log message did not post", "", deps.clock());
        continue;
      }
      drift.events.setLog(e.id, logChannel, posted.ts);
      // Not awaited: the steered turn waits its turn in that thread's queue.
      void steerOne({ ...e, logChannel, logTs: posted.ts }, c);
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

    const ordered = [...entries].reverse();
    const stored = ordered.map((t) => replyTo(t.channelId, t.threadTs, t.startedAt, t.endedAt));
    const observed: ObservedTurn[] = ordered.map((t, i) => ({
      channelId: t.channelId,
      threadTs: t.threadTs,
      slackUserId: t.slackUserId,
      kind: t.kind,
      outcome: t.outcome,
      error: t.error,
      request: t.request,
      reply: stored[i]?.content ?? "",
    }));

    // Drift is judged on what people saw: the stored final reply of a chat
    // turn that finished. Never the inner child's own channel or the log
    // channel, and never a reply to one of its own nudges.
    const logChannel = driftOn();
    const hitsByTurn = new Map<number, DriftHit[]>();
    const driftable = (i: number): boolean => {
      const t = ordered[i];
      if (!logChannel || !t || !stored[i]?.content.trim()) return false;
      return (
        t.kind === "chat" &&
        t.outcome === "ok" &&
        !!t.threadTs &&
        !isDriftNudge(t.request) &&
        t.channelId !== deps.channelId &&
        t.channelId !== logChannel &&
        !deps.drift?.workflowActive?.(t.channelId, t.threadTs)
      );
    };
    ordered.forEach((_, i) => {
      if (!driftable(i)) return;
      const hits = detectDrift(stored[i]?.content ?? "");
      if (hits.length) hitsByTurn.set(i, hits);
    });

    let raw = "";
    try {
      raw = await deps.llm.complete({
        system: triageSystem(deps.botName()),
        messages: [
          { role: "user", content: triageMessage(observed, deps.issues.recentTitles(30)), speakerId: deps.ownerSlackId },
        ],
        policy: { skipPermissions: false, disallowedTools: deps.noTools },
        bill: { actor: deps.ownerSlackId, kind: "inner-child", channel: deps.channelId },
      });
    } catch (e) {
      // The cheap checks already ran; their drift is still steered below.
      log(`triage failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const filed = byUrgency(parseFindings(raw))
      .slice(0, MAX_FILED_PER_TRIAGE)
      .map((f) => deps.issues.file(f, now))
      .filter((i): i is SelfIssue => i !== undefined);
    if (filed.length) log(`filed ${filed.map((i) => `#${i.id}`).join(", ")}`);

    for (const { turn, excerpt } of parseLanguageDrift(raw)) {
      const i = turn - 1;
      if (!driftable(i)) continue;
      hitsByTurn.set(i, [...(hitsByTurn.get(i) ?? []), { rule: "language", excerpt }]);
    }
    // The newest drifted reply per thread: one nudge per thread at a time.
    const newestPerThread = new Map<string, number>();
    for (const i of hitsByTurn.keys()) {
      const t = ordered[i];
      if (!t) continue;
      const key = `${t.channelId}:${t.threadTs}`;
      newestPerThread.set(key, Math.max(newestPerThread.get(key) ?? -1, i));
    }
    const candidates: DriftCandidate[] = [...newestPerThread.values()]
      .sort((a, b) => a - b)
      .map((i): [number, DriftHit[]] => [i, hitsByTurn.get(i) ?? []])
      .flatMap(([i, hits]) => {
        const t = ordered[i];
        const m = stored[i];
        return t && m
          ? [
              {
                channelId: t.channelId,
                threadTs: t.threadTs,
                slackUserId: t.slackUserId,
                startedAt: t.startedAt,
                endedAt: t.endedAt,
                messageId: m.id,
                reply: m.content,
                hits,
              },
            ]
          : [];
      });
    await steerDrift(candidates, now);
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
