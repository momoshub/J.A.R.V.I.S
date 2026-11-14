/**
 * Journeys the bot keeps about its own work, and their event trail.
 *
 * `journeys` holds the current state of each; `journey_events` is append-only
 * (nothing here updates or deletes an event), so history stays queryable even
 * after a journey's fields have moved on.
 */
import type { DbClient } from "./client.ts";
import {
  EVENT_KINDS,
  JOURNEY_STATUSES,
  MAX_PRS,
  type JourneyEventKind,
  type JourneyStatus,
} from "../../domain/journey.ts";

export type Journey = {
  readonly id: number;
  readonly title: string;
  readonly status: JourneyStatus;
  readonly area: string;
  readonly channelId: string;
  /** Empty when it was opened outside a thread. */
  readonly threadTs: string;
  readonly permalink: string;
  readonly prs: readonly string[];
  readonly progress: number;
  readonly now: string;
  readonly next: string;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** 0 until it is done. */
  readonly doneAt: number;
};

export type JourneyEvent = {
  readonly id: number;
  readonly journeyId: number;
  readonly at: number;
  readonly kind: JourneyEventKind;
  readonly text: string;
  readonly actor: string;
};

export type NewJourney = {
  readonly title: string;
  readonly status: JourneyStatus;
  readonly area: string;
  readonly channelId: string;
  readonly threadTs: string;
  readonly permalink: string;
  readonly prs: readonly string[];
  readonly progress: number;
  readonly now: string;
  readonly next: string;
  readonly createdBy: string;
};

/** What `update` may change; an absent field stays as it is. */
export type JourneyPatch = {
  readonly title?: string;
  readonly status?: JourneyStatus;
  readonly area?: string;
  readonly progress?: number;
  readonly now?: string;
  readonly next?: string;
  /** Added to the list, never replacing it. */
  readonly pr?: string;
  readonly note?: string;
};

export type JourneyFilter = {
  /** Any of these; empty or absent means every status. */
  readonly statuses?: readonly JourneyStatus[];
  /** Only journeys touched at or after this time. */
  readonly since?: number;
  readonly area?: string;
  readonly limit?: number;
};

type Row = {
  id: number;
  title: string;
  status: string;
  area: string;
  channel_id: string;
  thread_ts: string;
  permalink: string;
  prs: string;
  progress: number;
  now_text: string;
  next_text: string;
  created_by: string;
  created_at: number;
  updated_at: number;
  done_at: number;
};

type EventRow = { id: number; journey_id: number; at: number; kind: string; text: string; actor: string };

const asStatus = (v: string): JourneyStatus =>
  (JOURNEY_STATUSES as readonly string[]).includes(v) ? (v as JourneyStatus) : "doing";
const asKind = (v: string): JourneyEventKind =>
  (EVENT_KINDS as readonly string[]).includes(v) ? (v as JourneyEventKind) : "note";

const parsePrs = (raw: string): string[] => {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

const toJourney = (r: Row): Journey => ({
  id: r.id,
  title: r.title,
  status: asStatus(r.status),
  area: r.area,
  channelId: r.channel_id,
  threadTs: r.thread_ts,
  permalink: r.permalink,
  prs: parsePrs(r.prs),
  progress: r.progress,
  now: r.now_text,
  next: r.next_text,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  doneAt: r.done_at,
});

const toEvent = (r: EventRow): JourneyEvent => ({
  id: r.id,
  journeyId: r.journey_id,
  at: r.at,
  kind: asKind(r.kind),
  text: r.text,
  actor: r.actor,
});

export type JourneyRepo = {
  /** Opens a journey and records its `created` event. */
  add: (j: NewJourney, at: number) => Journey;
  get: (id: number) => Journey | undefined;
  /** Newest-touched first. */
  list: (filter?: JourneyFilter) => Journey[];
  /**
   * Applies the patch and appends one event per thing that changed (status,
   * progress, a new PR, a changed `now`, a note). Undefined when there is no such journey.
   */
  update: (id: number, patch: JourneyPatch, at: number, actor: string) => Journey | undefined;
  /** Records where the journey's thread lives, once the permalink is known. */
  link: (id: number, permalink: string) => void;
  /** Oldest first; with `limit`, the most recent that many, still oldest first. */
  events: (journeyId: number, limit?: number) => JourneyEvent[];
  /** Every event at or after `since`, oldest first: "what happened last week". */
  eventsSince: (since: number, limit?: number) => JourneyEvent[];
};

export const createJourneyRepo = (db: DbClient): JourneyRepo => {
  const insertStmt = db.query(
    `INSERT INTO journeys
       (title, status, area, channel_id, thread_ts, permalink, prs, progress, now_text, next_text,
        created_by, created_at, updated_at, done_at)
     VALUES ($title, $status, $area, $channelId, $threadTs, $permalink, $prs, $progress, $now, $next,
        $createdBy, $at, $at, $doneAt)
     RETURNING *`,
  );
  const getStmt = db.query<Row, [number]>("SELECT * FROM journeys WHERE id = ?");
  const eventStmt = db.query(
    "INSERT INTO journey_events (journey_id, at, kind, text, actor) VALUES ($id, $at, $kind, $text, $actor)",
  );
  const eventsStmt = db.query<EventRow, [number, number]>(
    `SELECT * FROM (SELECT * FROM journey_events WHERE journey_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC`,
  );
  const eventsSinceStmt = db.query<EventRow, [number, number]>(
    "SELECT * FROM journey_events WHERE at >= ? ORDER BY id ASC LIMIT ?",
  );
  const linkStmt = db.query("UPDATE journeys SET permalink = $permalink WHERE id = $id");
  const saveStmt = db.query(
    `UPDATE journeys SET title = $title, status = $status, area = $area, prs = $prs, progress = $progress,
       now_text = $now, next_text = $next, updated_at = $at, done_at = $doneAt
     WHERE id = $id`,
  );

  const event = (id: number, at: number, kind: JourneyEventKind, text: string, actor: string): void =>
    void eventStmt.run({ $id: id, $at: at, $kind: kind, $text: text, $actor: actor });

  const add = db.transaction((j: NewJourney, at: number): Journey => {
    const row = insertStmt.get({
      $title: j.title,
      $status: j.status,
      $area: j.area,
      $channelId: j.channelId,
      $threadTs: j.threadTs,
      $permalink: j.permalink,
      $prs: JSON.stringify(j.prs.slice(0, MAX_PRS)),
      $progress: j.progress,
      $now: j.now,
      $next: j.next,
      $createdBy: j.createdBy,
      $at: at,
      $doneAt: j.status === "done" ? at : 0,
    }) as Row;
    event(row.id, at, "created", `${j.status}: ${j.title}`, j.createdBy);
    for (const pr of j.prs.slice(0, MAX_PRS)) event(row.id, at, "pr", pr, j.createdBy);
    return toJourney(row);
  });

  const update = db.transaction((id: number, p: JourneyPatch, at: number, actor: string): Journey | undefined => {
    const row = getStmt.get(id);
    if (!row) return undefined;
    const cur = toJourney(row);
    const status = p.status ?? cur.status;
    const progress = status === "done" ? 100 : (p.progress ?? cur.progress);
    const now = p.now ?? cur.now;
    const prs = p.pr && !cur.prs.includes(p.pr) && cur.prs.length < MAX_PRS ? [...cur.prs, p.pr] : cur.prs;
    // Reopening a finished journey clears the finish time; finishing stamps it once.
    const doneAt = status === "done" ? (cur.doneAt || at) : 0;
    saveStmt.run({
      $id: id,
      $title: p.title ?? cur.title,
      $status: status,
      $area: p.area ?? cur.area,
      $prs: JSON.stringify(prs),
      $progress: progress,
      $now: now,
      $next: p.next ?? cur.next,
      $at: at,
      $doneAt: doneAt,
    });
    if (status !== cur.status) event(id, at, "status", `${cur.status} -> ${status}`, actor);
    if (progress !== cur.progress) event(id, at, "progress", `${progress}%`, actor);
    if (prs.length !== cur.prs.length) event(id, at, "pr", p.pr ?? "", actor);
    if (now !== cur.now && now) event(id, at, "note", `now: ${now}`, actor);
    if (p.note) event(id, at, "note", p.note, actor);
    return toJourney(getStmt.get(id) as Row);
  });

  return {
    add: (j, at) => add(j, at),
    get: (id) => {
      const r = getStmt.get(id);
      return r ? toJourney(r) : undefined;
    },
    list: (f = {}) => {
      const where: string[] = [];
      const binds: Record<string, string | number> = {};
      if (f.statuses && f.statuses.length > 0) {
        where.push(`status IN (${f.statuses.map((_, i) => `$s${i}`).join(", ")})`);
        f.statuses.forEach((s, i) => (binds[`$s${i}`] = s));
      }
      if (f.since !== undefined) {
        where.push("updated_at >= $since");
        binds.$since = f.since;
      }
      if (f.area) {
        where.push("area = $area COLLATE NOCASE");
        binds.$area = f.area;
      }
      binds.$limit = Math.max(1, f.limit ?? 30);
      const sql = `SELECT * FROM journeys ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC, id DESC LIMIT $limit`;
      return db.query<Row, Record<string, string | number>>(sql).all(binds).map(toJourney);
    },
    update: (id, patch, at, actor) => update(id, patch, at, actor),
    link: (id, permalink) => void linkStmt.run({ $id: id, $permalink: permalink }),
    events: (journeyId, limit = 20) => eventsStmt.all(journeyId, Math.max(1, limit)).map(toEvent),
    eventsSince: (since, limit = 200) => eventsSinceStmt.all(since, Math.max(1, limit)).map(toEvent),
  };
};
