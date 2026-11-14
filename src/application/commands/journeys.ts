/** `journey`: the bot's own record of work done, under way and planned. See domain/journey.ts. */

import {
  MAX_AREA,
  MAX_LINE,
  MAX_NOTE,
  MAX_TITLE,
  OPEN_STATUSES,
  PR_URL_RE,
  ago,
  cleanLine,
  helpText,
  isStatus,
  journeyLine,
  parseFlags,
  parseId,
  parseProgress,
  sinceCutoff,
  statusEmoji,
  tokenize,
  type JourneyFlags,
  type JourneyStatus,
} from "../../domain/journey.ts";
import { PERM } from "../../domain/permissions.ts";
import type { JourneyPatch } from "../../infrastructure/db/journeyRepo.ts";
import { logAndIgnore } from "../ignoredError.ts";
import { type CommandDef } from "./shared.ts";

const WRITES = new Set(["add", "new", "update", "set", "done", "finish", "drop", "cancel"]);

/** The patch a flag set asks for, or why it cannot be read. */
const patchOf = (f: JourneyFlags): { ok: true; patch: JourneyPatch } | { ok: false; error: string } => {
  if (f.error) return { ok: false, error: f.error };
  let status: JourneyStatus | undefined;
  if (f.status !== undefined) {
    const s = f.status.toLowerCase();
    if (!isStatus(s)) return { ok: false, error: `\`${f.status}\` is not a status (planned, doing, blocked, done, dropped)` };
    status = s;
  }
  let progress: number | undefined;
  if (f.progress !== undefined) {
    progress = parseProgress(f.progress);
    if (progress === undefined) return { ok: false, error: "progress is a number from 0 to 100" };
  }
  if (f.prs.length > 1) return { ok: false, error: "one `--pr` at a time" };
  const pr = f.prs[0];
  if (pr !== undefined && !PR_URL_RE.test(pr)) return { ok: false, error: `\`${pr}\` is not a GitHub pull request url` };
  const title = f.title === undefined ? undefined : cleanLine(f.title, MAX_TITLE);
  if (title === "") return { ok: false, error: "the title cannot be empty" };
  return {
    ok: true,
    patch: {
      ...(title === undefined ? {} : { title }),
      ...(status === undefined ? {} : { status }),
      ...(progress === undefined ? {} : { progress }),
      ...(f.now === undefined ? {} : { now: cleanLine(f.now, MAX_LINE) }),
      ...(f.next === undefined ? {} : { next: cleanLine(f.next, MAX_LINE) }),
      ...(f.area === undefined ? {} : { area: cleanLine(f.area, MAX_AREA) }),
      ...(pr === undefined ? {} : { pr }),
      ...(f.note === undefined ? {} : { note: cleanLine(f.note, MAX_NOTE) }),
    },
  };
};

export const JOURNEY_COMMANDS: readonly CommandDef[] = [
  {
    name: "journey",
    aliases: ["journeys"],
    // Reading is open; writing is the `journeys:write` permission below.
    minRole: "pal",
    ownHelp: true,
    usage: "add <title> [--area X] [--now ...] | update <id> [--status S] [--progress N] [--now ...] [--next ...] [--pr url] [--note ...] | done <id> | drop <id> | list [status] [--since 7d] | show <id> | help",
    summary: "my own record of work I did, am doing, or will do: add, update, done, drop, list, show",
    run: async ({ can, deps, actor, rest, prefix, threadTs, channelId }) => {
      if (!deps.journeys) return "I have nowhere to keep journeys right now.";
      const repo = deps.journeys;
      const now = deps.clock();
      const tokens = tokenize(rest);
      const sub = (tokens[0] ?? "list").toLowerCase();
      const flags = parseFlags(tokens.slice(1));

      if (sub === "help" || sub === "?") return helpText(prefix);

      if (WRITES.has(sub) && !can(PERM.writeJourneys)) {
        return `Writing journeys needs the *${PERM.writeJourneys}* permission. \`${prefix} journey list\` and \`${prefix} journey show <id>\` are open to you.`;
      }

      if (sub === "list" || sub === "ls") {
        if (flags.error) return `${flags.error}. \`${prefix} journey help\``;
        const word = (flags.words[0] ?? "open").toLowerCase();
        const statuses = word === "open" ? OPEN_STATUSES : word === "all" ? [] : isStatus(word) ? [word] : undefined;
        if (!statuses) return `\`${word}\` is not a status. \`${prefix} journey list [planned|doing|blocked|done|dropped|open|all]\``;
        let since: number | undefined;
        if (flags.since !== undefined) {
          since = sinceCutoff(flags.since, now);
          if (since === undefined) return "`--since` is a span like `7d`, `12h` or `2w`.";
        }
        const rows = repo.list({ statuses, since, area: flags.area, limit: 30 });
        if (rows.length === 0) return word === "open" ? "No open journeys." : `No ${word === "all" ? "" : `${word} `}journeys${since === undefined ? "" : " in that window"}.`;
        return rows.map((j) => journeyLine(j, now)).join("\n");
      }

      if (sub === "show" || sub === "get") {
        const id = parseId(flags.words[0]);
        const j = id === undefined ? undefined : repo.get(id);
        if (!j) return `There is no journey ${flags.words[0] ? `#${String(flags.words[0]).replace(/^#/, "")}` : "with that id"}. \`${prefix} journey list\``;
        const events = repo.events(j.id, 10);
        const where = j.permalink ? `<${j.permalink}|thread>` : j.channelId ? `<#${j.channelId}>` : "";
        return [
          `${statusEmoji(j.status)} *#${j.id} ${j.title}* - ${j.status}${j.status === "done" || j.status === "dropped" ? "" : ` ${j.progress}%`}${j.area ? ` [${j.area}]` : ""}`,
          j.now ? `*now:* ${j.now}` : "",
          j.next ? `*next:* ${j.next}` : "",
          j.prs.length > 0 ? `*PRs:* ${j.prs.join(" ")}` : "",
          `_opened ${ago(j.createdAt, now)} by <@${j.createdBy}>${where ? ` in ${where}` : ""}${j.doneAt ? `, done ${ago(j.doneAt, now)}` : `, updated ${ago(j.updatedAt, now)}`}_`,
          events.length > 0 ? `*events:*\n${events.map((e) => `- ${ago(e.at, now)} ${e.kind}: ${e.text}`).join("\n")}` : "",
        ]
          .filter(Boolean)
          .join("\n");
      }

      if (sub === "add" || sub === "new") {
        const title = cleanLine(flags.words.join(" "), MAX_TITLE);
        if (!title) return `What is it? \`${prefix} journey add <title> [--area X] [--now "..."]\``;
        const read = patchOf(flags);
        if (!read.ok) return `${read.error}. \`${prefix} journey help\``;
        const p = read.patch;
        const status = p.status ?? "doing";
        const j = repo.add(
          {
            title,
            status,
            area: p.area ?? "",
            channelId,
            threadTs: threadTs ?? "",
            permalink: "",
            prs: p.pr ? [p.pr] : [],
            progress: status === "done" ? 100 : (p.progress ?? 0),
            now: p.now ?? "",
            next: p.next ?? "",
            createdBy: actor.slackId,
          },
          now,
        );
        if (p.note) repo.update(j.id, { note: p.note }, now, actor.slackId);
        // A thread it was opened in is the place to read the story, so keep the link.
        // Best effort: the row is already saved, and a missing permalink only costs the link.
        if (threadTs && deps.slack?.permalink) {
          const link = await deps.slack.permalink(channelId, threadTs).catch(logAndIgnore("journey permalink"));
          if (link) repo.link(j.id, link);
        }
        return `${statusEmoji(status)} journey #${j.id}: *${j.title}* (${status}). \`${prefix} journey update ${j.id} --progress 40 --now "..."\``;
      }

      if (sub === "update" || sub === "set" || sub === "done" || sub === "finish" || sub === "drop" || sub === "cancel") {
        const id = parseId(flags.words[0]);
        if (id === undefined) return `Which one? \`${prefix} journey ${sub} <id>\` (see \`${prefix} journey list\`)`;
        const read = patchOf(flags);
        if (!read.ok) return `${read.error}. \`${prefix} journey help\``;
        const closing = sub === "done" || sub === "finish" ? "done" : sub === "drop" || sub === "cancel" ? "dropped" : undefined;
        // `done 3 shipped it` - the words after the id are the closing note.
        const closingNote = cleanLine(flags.words.slice(1).join(" "), MAX_NOTE);
        const patch: JourneyPatch = closing
          ? { ...read.patch, status: closing, ...(closingNote && !read.patch.note ? { note: closingNote } : {}) }
          : read.patch;
        if (Object.keys(patch).length === 0) return `Change what? \`${prefix} journey update ${id} --progress 40 --now "..."\` (see \`${prefix} journey help\`)`;
        const j = repo.update(id, patch, now, actor.slackId);
        if (!j) return `There is no journey #${id}. \`${prefix} journey list\``;
        return `${statusEmoji(j.status)} #${j.id} *${j.title}* - ${j.status}${j.status === "done" || j.status === "dropped" ? "" : ` ${j.progress}%`}`;
      }

      return `I do not know \`${sub}\`. \`${prefix} journey help\``;
    },
  },
];
