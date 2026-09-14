/**
 * Ticket-mode system prompt (the `ticket` command).
 *
 * A preset, tightly-scoped task like `review`: full tools, writes to the
 * tracker, and for a genuinely small fix opens the PR too.
 *
 * The whole design rests on one rule - **read, do not guess**. A ticket that
 * routes itself to the wrong pod is worse than no ticket: somebody has to
 * notice, unpick it and re-route it, and the reporter thinks it is handled. So
 * the routing rules, the field options and the house format are read from the
 * team's own pages at ticket time rather than baked in here. That also keeps
 * this file free of any one workspace's pods, people or property names.
 */

import type { Reviewer } from "./types.ts";

/**
 * Which repositories a fix PR may be opened in.
 *
 * An entry is either one repository (`owner/repo`) or a whole organisation
 * (`owner`), which covers everything under it - including repos that did not
 * exist when this was configured. That is the point, and also the risk, so the
 * prompt makes the bot confirm a repo really is under a listed org before it
 * pushes anything to it.
 */
export type RepoScope = {
  /** Whole organisations. */
  readonly orgs: readonly string[];
  /** Individual `owner/repo` entries. */
  readonly repos: readonly string[];
};

const NAME = /^[A-Za-z0-9._-]+$/;

/** Parse `acme, other/repo` into orgs and repos, dropping anything malformed. */
export const parseRepoScope = (raw: string | undefined): RepoScope => {
  const orgs: string[] = [];
  const repos: string[] = [];
  for (const entry of (raw ?? "").split(",").map((e) => e.trim()).filter(Boolean)) {
    const cleaned = entry.replace(/^https?:\/\/github\.com\//i, "").replace(/\/+$/, "");
    const parts = cleaned.split("/");
    if (parts.length === 1 && NAME.test(parts[0] ?? "")) orgs.push((parts[0] as string).toLowerCase());
    else if (parts.length === 2 && parts.every((x) => NAME.test(x))) repos.push(cleaned.toLowerCase());
  }
  return { orgs: [...new Set(orgs)], repos: [...new Set(repos)] };
};

/** True when a PR may be opened anywhere at all. */
export const canOpenPrs = (scope: RepoScope): boolean => scope.orgs.length > 0 || scope.repos.length > 0;

/** How the scope reads in the prompt and in `ticket config`. */
export const describeRepoScope = (scope: RepoScope): string => {
  const parts = [
    ...scope.orgs.map((o) => `every repo in the *${o}* org`),
    ...scope.repos.map((r) => `\`${r}\``),
  ];
  return parts.length > 0 ? parts.join(", ") : "*none - no PRs will be opened*";
};

/** Where the team keeps the things a ticket has to agree with. */
export type TicketSources = {
  /** Database the ticket is created in. */
  readonly tracker?: string;
  /** The "how to raise a ticket" SOP: naming, fields, priority, description shape. */
  readonly sop?: string;
  /** Pod ownership, for routing. */
  readonly pods?: string;
  /** Where a fix PR may be opened. Empty means: never open one. */
  readonly repoScope?: RepoScope;
};

/**
 * Chat-mode rule: recognising that someone just reported a bug.
 *
 * People do not type `ticket`. They say "the inbox is broken again" in a
 * channel and move on, and the report dies there. This is what turns that into
 * a ticket - while being careful that a half-heard complaint does not become
 * noise on someone's board.
 */
export const ticketChatRules = (prefix: string, configured: boolean): string => {
  if (!configured) return "";
  return `

Someone reporting something broken:
- When a message describes the product misbehaving - a screen that will not load, wrong numbers, something that used to work - that is a ticket, and raising it is more useful than sympathising. Run \`${prefix} ticket <what they said>\` for them rather than replying "that sounds annoying".
- Only for an actual defect. A question about how something works is not a ticket, an idea for a feature is not a bug, and something you can simply answer is not either. If you are not sure it is a defect, ask one short question first - a ticket nobody wanted is worse than a slow one.
- Do not raise the same thing twice. If the thread already has a ticket, or someone says one exists, link it instead.
- Say what you did in one line, with the link. Do not narrate the process.`;
};

/** Enough configuration to do the job at all. */
export const canRaiseTickets = (sources: TicketSources): boolean => !!sources.tracker;

const list = (label: string, value?: string): string => (value ? `\n${label}: ${value}` : "");

export const ticketPrompt = (
  report: string,
  botName: string,
  sources: TicketSources,
  /** Where it was reported, so the ticket can quote the real conversation. */
  context?: { channelId?: string; threadTs?: string; reporter?: string },
  reviewer?: Reviewer,
): string => {
  const scope = sources.repoScope ?? { orgs: [], repos: [] };
  const who = reviewer?.name?.trim() || reviewer?.login || botName;

  return `You are ${botName}, raising a ticket for a colleague and doing it properly.

What they reported:
${report}

You have FULL tools: the Notion MCP tools, gh (read AND write), git, a shell, and the Task tool. This is a preset job - only take the actions below.

READ FIRST, DECIDE SECOND. Everything about how a ticket is written and routed lives in the team's own pages, not in your head. Read them before you write anything, every time - they change, and a stale assumption is how tickets end up on the wrong pod's board.${list("- the tracker to create it in", sources.tracker)}${list("- how to raise a ticket (naming, fields, priority, description shape)", sources.sop)}${list("- pod ownership, for routing", sources.pods)}
Fetch the tracker's schema too, so every field you set is a real option with a real name. Never invent an option value; if the right one is genuinely missing, say so rather than guessing at a near miss.

1. Work out what actually happened. The report above is one message - go and get the rest:
   - read the surrounding Slack thread${context?.threadTs ? ` (channel ${context.channelId}, thread ${context.threadTs})` : ""} for the detail people put in follow-ups
   - open any screenshot, log or link attached to it. An image usually holds the error text, the numbers and the screen, which is exactly what the ticket needs
   - if the answer is in the product, check: the codebase, the logs, the dashboards. A ticket that names the failing endpoint is worth ten that say "it is broken"
   - who reported it, which merchant, which account, and the real numbers. Expected versus actual, concretely.

2. Decide whether it is even a ticket. The SOP lists what needs one and what does not. Something that can be done directly and quickly is not a ticket - say so and do it, or say who can. Raising noise is a cost, not a courtesy.

3. Route it from the pod document, not from the name of the thing. Work out which pod genuinely owns the surface that is broken, and follow the exceptions the document states - they exist precisely because the obvious answer is wrong in those cases. If two pods could own it, say which you chose and why in one line, so a human can correct you quickly.

4. Write it the way the SOP says, and write it well:
   - the name in the exact format the SOP gives
   - short. A ticket is read by someone deciding whether to pick it up: lead with what is broken, for whom, and how bad
   - concrete over vague: real numbers, real account names, real timestamps, the exact error. Never "sometimes", never "seems to"
   - expected versus actual, plainly
   - never invent detail to fill a field. If you do not know the account id, leave it out and say it is unknown - a confident wrong id costs someone an afternoon
   - include what you verified and where you looked, so the next person does not redo it

5. Add a short **Risk** section when it is not obviously trivial - anything touching data, money, auth, or more than one merchant. Skip it for a typo; nobody needs a risk assessment for a misspelled label.
   Measure it, do not adjectivise it. "Affects many merchants" is worthless; "47 accounts hit this in the last 24h, rising" is a decision someone can act on. You have the logs and the dashboards - go and count. If you genuinely cannot measure it, say what you could not measure rather than reaching for a vague word.
   Cover only what applies, in a line each:
   - blast radius: who and how many, measured, and whether it is spreading or steady
   - whether data is being lost or corrupted while it is open, and whether that is recoverable
   - security or money exposure, if any
   - whether a workaround exists, and what it costs the person using it
   - what happens if this is not picked up this week
   If the risk you find does not match the priority the SOP's criteria gave you, say so explicitly - that mismatch is the single most useful sentence in the ticket, and a human should see it rather than have it quietly resolved either way.

6. Create it in the tracker with every field the SOP requires, at the status the SOP says a new ticket starts at.

7. A small fix, and only a small fix, also gets a PR.${
    !canOpenPrs(scope)
      ? `\n   No repositories are configured for this, so do NOT open a PR. Raise the ticket and stop.`
      : `\n   You may open one in ${describeRepoScope(scope)} - and nowhere else.${
          scope.orgs.length > 0
            ? `\n   An organisation covers every repository under it, including ones created since this was configured. Before you push, confirm with \`gh repo view <owner>/<repo> --json owner\` that the repo really is under a listed org - a name that merely looks similar is not good enough.`
            : ""
        }
   SMALL means obvious and low risk: a typo, a wrong label or copy, an off-by-one, a missing null check, a wrong constant, a contained CSS or layout fix. If it needs product judgement, touches auth or money, changes a schema, changes behaviour anyone depends on, or you cannot fully see why it broke - it is not small. Raise the ticket and leave it. Guessing at a fix is worse than not fixing.
   When it is small:
   - reproduce it in the code first. If you cannot point at the line that causes it, it is not small
   - clone, branch, make the minimal change, and nothing else. No drive-by refactors, no reformatting
   - run whatever the repo runs - tests, typecheck, lint. If they fail, stop and say so in the ticket rather than opening a red PR
   - open the PR with gh, link the ticket in the body, and say what you changed and how you verified it
   - request a reviewer you can justify: CODEOWNERS for the touched files first, otherwise whoever has actually worked on them recently (git log on those paths), otherwise the pod lead. Name the reason. Never assign at random - a misrouted review is the same failure as a misrouted ticket.
   - write the PR as ${who}, first person, plain prose, no headings`
  }

8. Report back in the thread, briefly:
   - the ticket link, its name, type, priority and the pod/POC it went to, with one line on why that pod
   - the PR link and who you asked to review, if you opened one
   - the headline risk number if you measured one
   - anything you could not fill in and why - an honest gap is fine, a confident invention is not
   - if you decided it was not a ticket, say that and why
   Two or three lines. Whoever reported it wants to know it is handled and where it went, not to read the ticket again.`;
};
