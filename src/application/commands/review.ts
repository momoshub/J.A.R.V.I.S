/** PR review and its settings: approve, review, logsource, review-inbox, github-app, review-policy. */

import { reviewHelp, reviewPrompt } from "../../domain/reviewPrompt.ts";
import {
  DENIED_LOG_SOURCES,
  LOG_SOURCES,
  logSourceOrder,
  parseLogSources,
} from "../../domain/investigation.ts";
import {
  asReviewPolicy,
  authorRefOf,
  DEFAULT_REVIEW_POLICY,
  looksLikePrRef,
  parsePolicyArg,
  stricterPolicy,
  repoOf,
  repoRefOf,
  type ReviewPolicy,
} from "../../domain/reviewPolicy.ts";
import { GITHUB_LINK_PREFIX, githubLinkKey } from "../../domain/reviewInbox.ts";
import { postedBody } from "../../domain/ghCommand.ts";
import { tokenFor } from "../claudeTokens.ts";
import { authorReviewPolicyKey, reviewPolicyKey, SETTING_KEYS } from "../../infrastructure/db/settingsRepo.ts";
import { type CommandDeps, PR_URL, type CommandDef, RANK, askForToken, reviewAgentsOf, botNameOf } from "./shared.ts";

/** Ceiling for a relayed GitHub body in one Slack message. */
const RELAYED_BODY_CHARS = 3000;

const clip = (s: string): string =>
  s.length > RELAYED_BODY_CHARS ? `${s.slice(0, RELAYED_BODY_CHARS)}…\n(truncated - full text is on the PR)` : s;

/** review clones + spawns child agents, so allow much longer than a chat reply. */
const REVIEW_TIMEOUT_MS = 900_000;

/** The policy a PR's repository is on, defaulting when nothing is configured. */
const repoPolicyOf = (deps: CommandDeps, prUrl: string, fallback: ReviewPolicy): ReviewPolicy => {
  const repo = repoOf(prUrl);
  if (!repo) return fallback;
  return asReviewPolicy(deps.settings?.get(reviewPolicyKey(repo))) ?? fallback;
};

const AUTHOR_POLICY_PREFIX = "review_policy_author:";

/**
 * The policy a PR is on: its repository's, made stricter by its author's when
 * that author is configured. GitHub is only asked who wrote the PR when some
 * author policy exists, so the common case costs no extra `gh` call.
 */
const reviewPolicyOf = async (
  deps: CommandDeps,
  prUrl: string,
  fallback: ReviewPolicy = DEFAULT_REVIEW_POLICY,
): Promise<ReviewPolicy> => {
  const repo = repoPolicyOf(deps, prUrl, fallback);
  if (repo === "approve-after") return repo;
  const anyAuthor = deps.settings?.list?.()?.some((e) => e.key.startsWith(AUTHOR_POLICY_PREFIX) && asReviewPolicy(e.value));
  if (!anyAuthor || !deps.github?.author) return repo;
  const login = authorRefOf((await deps.github.author(prUrl)) ?? "");
  if (!login) return repo;
  return stricterPolicy(repo, asReviewPolicy(deps.settings?.get(authorReviewPolicyKey(login))));
};

/** Every url's policy, looked up once and in parallel. */
const reviewPoliciesOf = async (
  deps: CommandDeps,
  urls: readonly string[],
  fallback: ReviewPolicy = DEFAULT_REVIEW_POLICY,
): Promise<Map<string, ReviewPolicy>> =>
  new Map(await Promise.all(urls.map(async (u) => [u, await reviewPolicyOf(deps, u, fallback)] as const)));

export const REVIEW_COMMANDS: readonly CommandDef[] = [
  {
    name: "approve",
    // An approval nobody read, under the GitHub account I act with.
    minRole: "admin",
    usage: "<pr-url> [pr-url...]",
    summary: "approve a PR without reviewing it",
    /**
     * The most-guessed command that did not exist. Five people-months of log
     * say `approve <pr-url>`, every time answered with "I do not recognise
     * `approve`", once typed as "approvel without review please".
     *
     * It is not a new power: it is the up-front approval a repo can opt in to
     * with the review left off. A repository or author EXPLICITLY set to
     * approve only AFTER a clean review is an admin's decision, so a bare
     * approval there is not on offer at any role. The built-in default (also
     * approve-after) is not such a decision, so it does not block this.
     *
     * No brain, so no Claude token and no cost. Every approval is a row in the
     * command log against the person who asked for it.
     */
    run: async ({ deps, args, prefix }) => {
      if (!deps.github) return "I have no GitHub access wired up right now.";
      const urls = [...new Set(args.flatMap((a) => a.match(PR_URL) ?? []))];
      if (urls.length === 0) return `Which PR? \`${prefix} approve <pr-url>\``;
      const policies = await reviewPoliciesOf(deps, urls, "approve-first");
      const held = urls.filter((u) => policies.get(u) === "approve-after");
      const lines: string[] = [];
      for (const url of urls) {
        if (held.includes(url)) {
          lines.push(`⚠️ ${url} - that repo or author approves only after a clean review. \`${prefix} review ${url}\``);
          continue;
        }
        const res = await deps.github.approve(url);
        lines.push(res.ok ? `✅ approved ${url}` : `⚠️ could not approve ${url} - ${res.error}`);
      }
      // Say what it did NOT do. An approval with no review behind it is worth
      // one line of honesty, not a silent green tick.
      if (lines.some((l) => l.startsWith("✅"))) {
        lines.push(`_approved as asked, nobody read it - \`${prefix} review <pr-url>\` if you want that too_`);
      }
      return lines.join("\n");
    },
  },
  {
    name: "review",
    aliases: ["rv"],
    ownHelp: true,
    minRole: "pal",
    usage: "<pr-url> [pr-url...] [--policy first|after] [what to look at]",
    summary: "review a PR: blockers-only comment on GitHub and here, an issue for what can wait",
    run: async (ctx) => {
      const { deps, actor, args, prefix, reply, channelId } = ctx;
      if (args.length === 0) return `Which PR? \`${prefix} review <pr-url>\``;
      if (!deps.llm) return "My brain is not wired up right now.";
      // A review runs on the caller's own Claude Code credential, never the
      // bot's: it is the long, expensive job, and the usage belongs to whoever
      // asked for it. No token, no review - but the ask carries the box to put
      // one in, and the command resumes itself once it lands.
      const oauthToken = tokenFor(deps, actor);
      if (!oauthToken) {
        return deps.claudeTokens
          ? askForToken(ctx, `review ${args.join(" ")}`.trim())
          : "I have nowhere to keep a Claude Code token right now, and a review only ever runs on the caller's own. Ask an admin to check the token store.";
      }
      // A policy asked for on the line itself, for this run only. Pulled out
      // first so it reaches neither the url parser nor the free-text note.
      const { asked, rest, bad } = parsePolicyArg(args);
      if (bad !== undefined) {
        return `\`${bad}\` is not a policy. \`--policy first\`, \`--policy after\`, or \`--policy default\`.`;
      }
      // What the review is actually about, before anything expensive happens.
      if (rest.length === 1 && /^(help|\?|--help|prompt|how)$/i.test(rest[0] ?? "")) {
        const wantPrompt = /^prompt$/i.test(rest[0] ?? "");
        const text = reviewHelp(prefix, wantPrompt, reviewAgentsOf(deps), botNameOf(deps));
        // The real prompt is longer than one Slack message, and a post that is
        // too long simply fails to land - which looks like being ignored.
        return wantPrompt ? clip(text) : text;
      }
      // Slack wraps links as <url|label>; hand the brain the bare urls.
      const urls = [...new Set(rest.flatMap((a) => a.match(PR_URL) ?? []))];
      // A shorthand the brain can resolve is fine; a stray word is not. Without
      // this, `review help` spawned a full review of a PR named "help" - minutes
      // of work on the asker's own credential, to answer a question.
      const shorthand = urls.length === 0 ? rest.filter(looksLikePrRef) : [];
      const wanted = urls.length > 0 ? urls : shorthand;
      if (wanted.length === 0) {
        return `Which PR? \`${prefix} review <pr-url>\` - or \`${prefix} review help\` for how I do it.`;
      }
      // Anything typed alongside the urls is guidance: "the migration is the
      // risky bit", "hotfix, correctness only". It aims the review; the prompt
      // is what keeps it from doing anything more than that.
      const note = urls.length > 0 ? rest.filter((a) => !PR_URL.test(a)).join(" ").trim() : "";
      // A preset, tightly-scoped task: always run FULL access (it comments and
      // requests changes on GitHub, clones, and spawns child agents) with a long
      // timeout, regardless of the caller's role.
      const full = deps.toolPolicy?.("owner") ?? { skipPermissions: true };
      const policy = { ...full, timeoutMs: REVIEW_TIMEOUT_MS };
      const name = botNameOf(deps);

      // Who the comment is written as. In flight while we approve - the brain
      // needs it in its prompt, and it would otherwise spend a tool call on it.
      const account = deps.github?.whoami();

      // Only a repo or run on `approve-first` approves here, in code, before the
      // brain is even spawned (a fixed step that must not wait ~30s for the model).
      // The default holds the approval until the review is clean. `seen` carries
      // the lines forward so the brain cannot repeat them.
      const seen = new Set<string>();
      const announcements: string[] = [];
      const approvedUpFront: string[] = [];
      // What each PR is on for this run: the flag if one was given, otherwise
      // whatever the repository is configured for.
      // A pal's review never approves up front: that would be `approve` with
      // extra steps, and `approve` is not theirs to run. Nor is the policy, so
      // they get no say in it for a run either.
      const palOnly = RANK[actor.role] < RANK.executer;
      if (palOnly && asked !== undefined) {
        return "Review policy is not a pal's to set. Drop `--policy` - a pal review approves only after a clean one anyway.";
      }
      const override: ReviewPolicy | undefined =
        asked === "default" ? DEFAULT_REVIEW_POLICY : asked;
      // Asking for a stricter run is anyone's call. Asking for a looser one -
      // approving up front on a repository that deliberately waits for a clean
      // review - is overruling an admin's decision, so it takes one.
      // Only an EXPLICIT approve-after is an admin's decision; the built-in default
      // (also approve-after) is not, so it is read with the opposite fallback.
      const explicit = await reviewPoliciesOf(deps, urls, "approve-first");
      const configured = await reviewPoliciesOf(deps, urls);
      const loosened = override === "approve-first" && urls.some((u) => explicit.get(u) === "approve-after");
      if (loosened && RANK[actor.role] < RANK.admin) {
        return "That repo or author is set to approve only after a clean review, and only an admin can override that for a run.";
      }
      const policyFor = (url: string): ReviewPolicy =>
        palOnly ? "approve-after" : (override ?? configured.get(url) ?? DEFAULT_REVIEW_POLICY);
      // One review per PR. A GitHub review request and a `review` typed here
      // both land in this command, and two runs mean two approvals and two
      // comments on the same PR. A PR already in hand is pointed at, not redone.
      const busy: string[] = [];
      const mine: string[] = [];
      for (const url of urls) {
        const holder = deps.reviewGuard?.claim(url, { channelId, threadTs: ctx.threadTs });
        if (!holder) {
          mine.push(url);
          continue;
        }
        const link =
          holder.threadTs && deps.slack?.permalink
            ? await deps.slack.permalink(holder.channelId, holder.threadTs).catch(() => undefined)
            : undefined;
        const where = link ? `<${link}|in this thread>` : `in <#${holder.channelId}>`;
        busy.push(`👯 ${url} ${holder.doneAt === undefined ? "is already being reviewed" : "was just reviewed"} ${where}`);
      }
      if (urls.length > 0 && mine.length === 0) return busy.join("\n");
      // Only urls can be guarded; a shorthand like `#12` has no repo to key on.
      const targets = urls.length > 0 ? mine : wanted;
      try {
        if (reply) for (const line of busy) await reply(line);
        // Repositories on `approve-after` are left alone until the review is in.
        const afterReview = mine.filter((u) => policyFor(u) === "approve-after");
        for (const url of mine) {
          if (afterReview.includes(url)) continue;
          const res = await deps.github?.approve(url);
          if (!res) break; // no gh wired up - leave it to the brain
          const line = res.ok ? `✅ approved ${url}` : `⚠️ could not approve ${url} - ${res.error}`;
          if (res.ok) {
            seen.add(line);
            approvedUpFront.push(url);
          }
          announcements.push(line);
        }

        const params = {
          system: reviewPrompt(targets, name, await account, approvedUpFront, reviewAgentsOf(deps), note),
          messages: [{ role: "user" as const, content: `review ${targets.join(" ")}${note ? `\n\n${note}` : ""}` }],
          assistantName: name,
          policy,
          oauthToken,
          bill: { actor: actor.slackId, kind: "review", channel: channelId, threadTs: ctx.threadTs },
        };

        // No live destination (tests / slack off): one-shot, return the text.
        if (!reply) {
          const out = await deps.llm.complete(params);
          return [...busy, out.trim() || "I could not put a review together for that one."].join("\n");
        }

        // Live: post progress as each PR action lands, then the review itself. The
        // destination is chosen by the transport - thread for a message command, DM
        // for a slash command - so nothing is hidden in an ephemeral reply.
        // "reviewing" always opens the run: an up-front approval (opt-in policy)
        // is announced after it, never before the thread says a review started.
        await reply(
          `🔍 reviewing ${targets.join(" ")}` +
            (override ? `\n_${override}, for this run only_` : "") +
            (note ? `\n_looking at: ${note}_` : ""),
        );
        for (const line of announcements) await reply(line);

        let out = "";
        // Set when the run was killed mid-flight. What streamed is then a fragment
        // of a review, never the review, and must not be presented as one.
        let cutOff = "";
        if (deps.llm.stream) {
          const announce = (line: string): void => {
            if (seen.has(line)) return;
            seen.add(line);
            void reply(line);
          };
          // Review comments posted so far, so a late follow-up is labelled as one.
          let comments = 0;
          // The only PR url we can attribute an action to when the command itself
          // carries none (e.g. `gh pr review 2149 --repo ...`).
          const soleUrl = targets.length === 1 ? (targets[0]?.match(PR_URL)?.[0] ?? "") : "";
          out = await deps.llm.stream(params, (ev) => {
            if (ev.type === "aborted") {
              cutOff = ev.reason;
              return;
            }
            if (ev.type !== "tool" || ev.status !== "complete") return;
            // Match the command in full, never the card title: the title is clipped
            // at 200 chars, and a `gh pr review` written after a heredoc body sits
            // well past that - which is how a request-changes went unannounced.
            const ran = ev.command ?? ev.title;
            const t = ran.toLowerCase();
            const url = ran.match(PR_URL)?.[0] ?? soleUrl;
            const at = url ? ` ${url}` : "";
            const on = url ? ` on ${url}` : "";
            // Independent, not else-if: one shell call can approve and then reverse.
            // `[^\n]*` keeps a match on the gh line itself, so prose inside a heredoc
            // body ("flipping back to request-changes") cannot trigger a false line.
            if (/gh pr review[^\n]*--approve/.test(t)) announce(`✅ approved${at}`);
            // The change request carries a fixed marker, so there is nothing to
            // relay; the comment is where the review is written, and it comes with
            // the body that went to GitHub, recovered from the command itself.
            if (/gh pr review[^\n]*--request-changes/.test(t)) announce(`⚠️ requested changes${on}`);
            if (/gh pr comment\b/.test(t)) {
              const body = postedBody(ran, "comment");
              // A second comment is the late-finding case - an agent reporting back
              // after the review went up. Say which it is rather than "the review"
              // twice, which reads as the same thing posted again.
              const what = comments++ === 0 ? "posted the review" : "posted a follow-up";
              announce(`📝 ${what}${on}${body ? `\n\n${clip(body)}` : ""}`);
            }
            // A non-blocking finding worth fixing later goes to an issue, never
            // the comment, and nothing else relays it - so say it here, by title.
            if (/gh issue create\b/.test(t)) {
              const title = ran.match(/--title[= ](?:"([^"]*)"|'([^']*)')/);
              const named = title ? `: ${title[1] ?? title[2]}` : "";
              announce(`📌 opened a follow-up issue${on}${named}`);
            }
          });
        } else {
          out = await deps.llm.complete(params);
        }

        if (cutOff) {
          // Say it plainly. Anything that did reach GitHub was announced above as
          // it landed, so the thread already shows exactly how far this got.
          const far = out.trim();
          await reply(
            `⏱️ the review did not finish - ${cutOff}${far ? `\n\nhow far it got:\n\n${clip(far)}` : ""}`,
          );
          return "";
        }

        await reply(out.trim() || "I could not put a review together for that one.");

        // Held back until now: approve only what the review left unblocked, and
        // ask GitHub rather than inferring it from what the review seemed to say.
        for (const url of afterReview) {
          const decision = (await deps.github?.reviewDecision(url))?.toUpperCase();
          if (decision === "CHANGES_REQUESTED") {
            await reply(`🚫 not approving ${url} - changes are requested`);
            continue;
          }
          const res = await deps.github?.approve(url);
          if (!res) continue;
          await reply(res.ok ? `✅ approved ${url} - the review came back clean` : `⚠️ could not approve ${url} - ${res.error}`);
        }
        return ""; // already delivered to the thread / DM
      } finally {
        for (const url of mine) deps.reviewGuard?.release(url);
      }
    },
  },
  {
    name: "logsource",
    aliases: ["logsources"],
    minRole: "pal",
    usage: "[grafana,datadog|default]",
    summary: "where I look for logs, in order",
    run: (ctx) => {
      const { deps, actor, rest, prefix } = ctx;
      const describe = (order: readonly string[]) =>
        `I look for logs in this order: ${order.map((s) => `*${s}*`).join(" → ")}.\nNever: ${DENIED_LOG_SOURCES.map((s) => `*${s}*`).join(", ")} - it bills per GB scanned.`;

      const wanted = rest.trim().toLowerCase();
      if (!wanted) return describe(logSourceOrder(deps.settings?.get(SETTING_KEYS.logSources)));

      if (RANK[actor.role] < RANK.admin) return "Only admins can change where I look.";
      if (wanted === "default" || wanted === "reset") {
        deps.settings?.set(SETTING_KEYS.logSources, "");
        return describe(logSourceOrder(undefined));
      }
      // Refuse a list that mentions something unreachable rather than silently
      // dropping it - a half-applied order is worse than none.
      const asked = wanted.split(",").map((s) => s.trim()).filter(Boolean);
      const unknown = asked.filter((s) => !(s in LOG_SOURCES));
      if (unknown.length > 0 || asked.length === 0) {
        return `I do not know ${unknown.map((u) => `*${u}*`).join(", ") || "that"}. Pick from: ${Object.keys(LOG_SOURCES).join(", ")}.\n\`${prefix} logsource grafana,datadog\``;
      }
      const order = parseLogSources(asked.join(","));
      deps.settings?.set(SETTING_KEYS.logSources, order.join(","));
      return describe(order);
    },
  },
  {
    name: "review-inbox",
    minRole: "pal",
    usage: "| channel <#channel>|off | link <github-login> [@someone] | unlink <github-login>",
    summary: "where GitHub review requests of my account are posted and reviewed, and who is who",
    run: ({ deps, actor, args, prefix }) => {
      const settings = deps.settings;
      if (!settings) return "I have nowhere to keep settings right now.";
      const sub = (args[0] ?? "").toLowerCase();
      const admin = RANK[actor.role] >= RANK.admin;

      if (sub === "channel") {
        if (!admin) return "Only admins can move the review inbox.";
        const raw = args[1] ?? "";
        if (/^(off|none|stop)$/i.test(raw)) {
          settings.remove(SETTING_KEYS.reviewInboxChannel);
          return "review inbox off - review requests stay on GitHub";
        }
        const id = raw.match(/^<#([CG][A-Z0-9]+)(?:\|[^>]*)?>$/)?.[1] ?? raw.match(/^[CG][A-Z0-9]+$/)?.[0];
        if (!id) return `Which channel? \`${prefix} review-inbox channel #channel\``;
        settings.set(SETTING_KEYS.reviewInboxChannel, id);
        // From now: a backlog of old requests is not what this was turned on for.
        settings.set(SETTING_KEYS.reviewInboxCursor, new Date(deps.clock()).toISOString());
        return `review requests of my GitHub account now land in <#${id}>, reviewed first and approved only if clean, on the requester's own token`;
      }

      if (sub === "link" || sub === "unlink") {
        const login = (args[1] ?? "").replace(/^@/, "");
        if (!/^[A-Za-z0-9-]+$/.test(login)) return `Which GitHub login? \`${prefix} review-inbox ${sub} <github-login>\``;
        const target = args[2]?.match(/^<@([UW][A-Z0-9]+)(?:\|[^>]*)?>$/)?.[1];
        const current = settings.get(githubLinkKey(login));
        // Yourself is anyone's call; somebody else's is an admin's, since it
        // decides whose token a review runs on.
        if ((target && target !== actor.slackId) || (current && current !== actor.slackId)) {
          if (!admin) return "That links someone else - only an admin can do that.";
        }
        if (sub === "unlink") {
          settings.remove(githubLinkKey(login));
          return `\`${login}\` is not linked to anyone now`;
        }
        const who = target ?? actor.slackId;
        settings.set(githubLinkKey(login), who);
        return `\`${login}\` on GitHub is <@${who}> now`;
      }

      const channel = settings.get(SETTING_KEYS.reviewInboxChannel)?.trim();
      const links = settings
        .list()
        .filter((e) => e.key.startsWith(GITHUB_LINK_PREFIX))
        .map((e) => `- \`${e.key.slice(GITHUB_LINK_PREFIX.length)}\` -> <@${e.value}>`);
      return [
        channel
          ? `review requests of my GitHub account land in <#${channel}>, reviewed then approved only if clean, on the requester's own token`
          : `review inbox is off - \`${prefix} review-inbox channel #channel\``,
        ...(links.length ? ["GitHub links:", ...links] : []),
      ].join("\n");
    },
  },
  {
    name: "github-app",
    minRole: "pal",
    usage: "| channel <#channel>|off",
    summary: "where calls from the GitHub App (an @mention or the label on an issue/PR) are posted and run",
    run: ({ deps, actor, args, prefix }) => {
      const settings = deps.settings;
      if (!settings) return "I have nowhere to keep settings right now.";
      const sub = (args[0] ?? "").toLowerCase();
      if (sub === "channel") {
        if (RANK[actor.role] < RANK.admin) return "Only admins can move where GitHub calls land.";
        const raw = args[1] ?? "";
        if (/^(off|none|default)$/i.test(raw)) {
          settings.remove(SETTING_KEYS.githubAppChannel);
          return "GitHub App calls fall back to the review inbox channel now";
        }
        const id = raw.match(/^<#([CG][A-Z0-9]+)(?:\|[^>]*)?>$/)?.[1] ?? raw.match(/^[CG][A-Z0-9]+$/)?.[0];
        if (!id) return `Which channel? \`${prefix} github-app channel #channel\``;
        settings.set(SETTING_KEYS.githubAppChannel, id);
        return `calls from GitHub now land in <#${id}> and run there as whoever called`;
      }
      const own = settings.get(SETTING_KEYS.githubAppChannel)?.trim();
      const fallback = settings.get(SETTING_KEYS.reviewInboxChannel)?.trim();
      const channel = own || fallback;
      return channel
        ? `calls from GitHub land in <#${channel}>${own ? "" : " (the review inbox channel)"}; people are matched with \`${prefix} review-inbox link <github-login>\``
        : `no channel for GitHub calls - \`${prefix} github-app channel #channel\``;
    },
  },
  {
    name: "review-policy",
    aliases: ["rvpolicy", "repo-policy"],
    minRole: "admin",
    usage: "[owner/repo | author:<login>] [first|after|default]",
    summary: "how a repo or PR author gets approved: up front, or only after a clean review",
    run: (ctx) => {
      const { deps, actor, args, prefix } = ctx;
      const describe = (p: ReviewPolicy) =>
        p === "approve-after"
          ? "approved *only after* the review, and only if nothing is blocking"
          : "approved *up front*, reversed if the review finds a blocker";

      if (args.length === 0) {
        // Configuration only says who differs; the rest are on the default.
        const configured = deps.settings
          ? deps.settings
              .list?.()
              ?.filter(
                (e) =>
                  (e.key.startsWith("review_policy:") || e.key.startsWith(AUTHOR_POLICY_PREFIX)) &&
                  asReviewPolicy(e.value),
              )
              .map((e) =>
                e.key.startsWith(AUTHOR_POLICY_PREFIX)
                  ? `- author \`${e.key.slice(AUTHOR_POLICY_PREFIX.length)}\`: ${asReviewPolicy(e.value)}`
                  : `- \`${e.key.slice("review_policy:".length)}\`: ${asReviewPolicy(e.value)}`,
              )
          : undefined;
        const list = configured && configured.length > 0 ? `\n${configured.join("\n")}` : "\nNothing configured - every repo is on the default.";
        return `Default: *${DEFAULT_REVIEW_POLICY}* - ${describe(DEFAULT_REVIEW_POLICY)}.${list}`;
      }

      // A PR author is named `author:<login>` (or `@login`); anything else is a repo.
      const first = args[0] ?? "";
      const authorArg = /^author:(.+)$/i.exec(first)?.[1] ?? (first.startsWith("@") ? first : undefined);
      const login = authorArg !== undefined ? authorRefOf(authorArg) : undefined;
      if (authorArg !== undefined && !login) {
        return `Which author? \`${prefix} review-policy author:<github-login> [first|after|default]\``;
      }
      const repo = login ? `author ${login}` : repoRefOf(first);
      if (!repo) return `Which repo? \`${prefix} review-policy owner/repo [first|after|default]\``;
      const key = login ? authorReviewPolicyKey(login) : reviewPolicyKey(repo);
      if (args.length === 1) {
        const own = asReviewPolicy(deps.settings?.get(key));
        return own
          ? `\`${repo}\` is on *${own}* - ${describe(own)}.`
          : `\`${repo}\` uses the default, *${DEFAULT_REVIEW_POLICY}* - ${describe(DEFAULT_REVIEW_POLICY)}.`;
      }

      if (RANK[actor.role] < RANK.admin) return "Only admins can change a review policy.";
      const want = (args[1] ?? "").toLowerCase();
      if (want === "default" || want === "reset") {
        deps.settings?.set(key, "");
        return `\`${repo}\` is back on the default, *${DEFAULT_REVIEW_POLICY}*.`;
      }
      const policy: ReviewPolicy | undefined =
        want === "after" || want === "approve-after"
          ? "approve-after"
          : want === "first" || want === "approve-first"
            ? "approve-first"
            : undefined;
      if (!policy || args.length > 2) {
        return `First or after? \`${prefix} review-policy ${first} <first|after|default>\``;
      }
      deps.settings?.set(key, policy);
      return `\`${repo}\` is now *${policy}* - ${describe(policy)}.`;
    },
  },
];
