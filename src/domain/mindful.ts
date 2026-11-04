/**
 * Mindfulness: everything the bot is doing, in one place.
 *
 * Each piece of this already existed somewhere and nowhere together. The run
 * registry knows what is in flight but only to stop it. `llm_usage` knows what
 * things cost. `turn_log` now knows how turns ended. Workflows know what is
 * still open. Spread over four places, the one question an owner actually asks
 * - "what is going on right now, and is anything stuck" - could not be asked
 * at all, and the answer that mattered most (a thread that failed and is just
 * sitting there) reached nobody: a failed turn posts an apology into its own
 * thread and is never mentioned again.
 *
 * So the report leads with what is WRONG, not with what is busy. A list of
 * healthy running turns is reassuring and useless; a thread that died twenty
 * minutes ago and is still dead is the thing worth a person's attention.
 *
 * Owner and admin only: it names people, quotes what they asked, and spans
 * every channel the bot can see, including DMs and private channels the reader
 * may not be in.
 */
import { money, tokens, type SpendTotals } from "./spendReport.ts";

export type LiveRun = {
  readonly id: string;
  readonly channelId: string;
  readonly threadTs?: string;
  readonly actor: string;
  readonly what: string;
  readonly startedAt: number;
  readonly state: "running" | "queued" | "stopping";
};

export type StuckTurn = {
  readonly channelId: string;
  readonly threadTs: string;
  readonly slackUserId: string;
  readonly request: string;
  readonly error: string;
  readonly outcome: "failed" | "stopped" | "ok";
  readonly endedAt: number;
};

export type OpenWorkflow = {
  readonly channelId: string;
  readonly threadTs: string;
  readonly task: string;
  readonly lastTurnAt: number;
};

export type Watching = {
  readonly id: number;
  readonly channelId: string;
  readonly threadTs: string;
  readonly check: string;
  readonly note: string;
  readonly deadlineAt: number;
  readonly attempts: number;
};

export type MindfulView = {
  readonly now: number;
  readonly live: readonly LiveRun[];
  readonly watching?: readonly Watching[];
  readonly stuck: readonly StuckTurn[];
  readonly workflows: readonly OpenWorkflow[];
  /** Turns that ended in the window, for the success/failure count. */
  readonly done: { readonly ok: number; readonly failed: number; readonly stopped: number };
  readonly spend: SpendTotals;
  readonly windowMs: number;
};

/** "4m", "2h10m" - how long something has been going, or sitting. */
export const ago = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
};

/** A thread link anyone can click, built from the ids. */
export const threadRef = (channelId: string, threadTs: string, team?: string): string => {
  if (!threadTs) return `<#${channelId}>`;
  const p = `p${threadTs.replace(".", "")}`;
  return team
    ? `<https://${team}.slack.com/archives/${channelId}/${p}|thread>`
    : `<#${channelId}> \`${threadTs}\``;
};

/**
 * The workspace domain out of any permalink, so every other link can be built
 * locally from ids. One API call instead of one per row.
 */
export const teamFromPermalink = (url?: string): string | undefined =>
  url?.match(/https?:\/\/([\w-]+)\.slack\.com\//i)?.[1];

const clip = (text: string, max = 70): string => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
};

/**
 * The report. Order is deliberate: what is broken, what is open, what is
 * running, then the numbers. Anyone reading this is looking for a problem.
 */
export const mindfulReport = (view: MindfulView, team?: string): string => {
  const lines: string[] = [];
  const { done } = view;

  const watching = view.watching ?? [];
  if (view.stuck.length === 0 && view.live.length === 0 && view.workflows.length === 0 && watching.length === 0) {
    lines.push("nothing running, nothing stuck");
  }

  if (view.stuck.length > 0) {
    lines.push(`*stuck* - ${view.stuck.length} thread${view.stuck.length === 1 ? "" : "s"} whose last turn did not finish`);
    for (const s of view.stuck) {
      lines.push(
        `- ${threadRef(s.channelId, s.threadTs, team)} <@${s.slackUserId}> ${ago(view.now - s.endedAt)} ago - "${clip(s.request)}"`,
      );
      lines.push(`  ${s.outcome === "stopped" ? "stopped" : `failed: ${clip(s.error, 90)}`}`);
    }
    lines.push("");
  }

  if (view.live.length > 0) {
    lines.push(`*running now* - ${view.live.length}`);
    for (const r of view.live) {
      const where = r.threadTs ? threadRef(r.channelId, r.threadTs, team) : `<#${r.channelId}>`;
      lines.push(
        `- ${r.state === "running" ? "▶︎" : r.state === "queued" ? "⏸" : "◼︎"} ${where} <@${r.actor}> ${ago(view.now - r.startedAt)} - "${clip(r.what, 50)}"`,
      );
    }
    lines.push("");
  }

  if (watching.length > 0) {
    lines.push(`*waiting on* - ${watching.length}`);
    for (const w of watching) {
      lines.push(
        `- ${threadRef(w.channelId, w.threadTs, team)} ${w.check ? `\`${clip(w.check, 45)}\`` : "timer"} - ${w.attempts} checks, gives up in ${ago(Math.max(0, w.deadlineAt - view.now))}`,
      );
    }
    lines.push("");
  }

  if (view.workflows.length > 0) {
    lines.push(`*open workflows* - ${view.workflows.length}`);
    for (const w of view.workflows) {
      lines.push(
        `- ${threadRef(w.channelId, w.threadTs, team)} "${clip(w.task, 60)}" - last turn ${ago(view.now - w.lastTurnAt)} ago`,
      );
    }
    lines.push("");
  }

  const total = done.ok + done.failed + done.stopped;
  lines.push(
    `*${total} turn${total === 1 ? "" : "s"}* finished: ${done.ok} ok, ${done.failed} failed, ${done.stopped} stopped`,
  );
  lines.push(
    `*${money(view.spend.costUsd)}* list price over the same window - ${view.spend.runs} model runs, ${tokens(view.spend.inputTokens + view.spend.outputTokens)} tokens`,
  );
  return lines.join("\n").trim();
};
