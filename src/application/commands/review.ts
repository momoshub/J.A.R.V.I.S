/** PR review and its settings: quick-review, logsource, review-inbox, github-app, review-policy. */

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
import { failedList } from "../../domain/ciGate.ts";
import { tokenFor } from "../claudeTokens.ts";
import { authorReviewPolicyKey, reviewPolicyKey, SETTING_KEYS } from "../../infrastructure/db/settingsRepo.ts";
import { isClaudeAuthError } from "../../domain/threadSession.ts";
import { parsePrUrl, type ReviewIdentity } from "../../domain/reviewIdentity.ts";
import { type CommandDeps, type Context, PR_URL, type CommandDef, askForToken, reviewAgentsOf, botNameOf } from "./shared.ts";
import { logAndIgnore } from "../ignoredError.ts";
import { PERM } from "../../domain/permissions.ts";

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

/** A credential for the app on the PR's repository, or undefined when it cannot be had. */
const mintFor = async (
  deps: CommandDeps,
  prUrl: string,
): Promise<{ token: string; revoke: () => Promise<void> } | undefined> => {
  const repo = parsePrUrl(prUrl)?.repo;
  if (!repo || !deps.reviewApp) return undefined;
  return deps.reviewApp.mintToken(repo).catch(logAndIgnore("review token mint") as () => undefined);
};

/** What a quick review needs of whoever asked: the command's own context, or the one a review that starts by itself builds. */
export type ReviewCtx = Pick<Context, "deps" | "actor" | "args" | "prefix" | "slash" | "reply" | "channelId" | "threadTs" | "can">;

export type ReviewRunOptions = {
  /**
   * Who the review's comments and change requests are posted as: the host's
   * own GitHub account (default) or the GitHub App. The approval is the host's
   * account either way.
   */
  identity?: ReviewIdentity;
  /**
   * Run on the asker's own Claude token when there is one and the bot's own
   * credential when there is not, instead of asking for a token. Only set once
   * the owner has said yes to exactly that.
   */
  botCredentialOk?: boolean;
};

/**
 * The quick review itself, shared by `quick-review` (a person asked for it in
 * Slack) and the reviews that start by themselves (a request on GitHub, see
 * application/autoReview.ts). The only difference between them is `opts`.
 */
export const runReview = async (ctx: ReviewCtx, opts: ReviewRunOptions = {}): Promise<string> => {
  const identity: ReviewIdentity = opts.identity ?? "human";
  const asApp = identity === "app";
    const { deps, actor, args, prefix, reply, channelId } = ctx;
    if (args.length === 0) return `Which PR? \`${prefix} quick-review <pr-url>\``;
    if (!deps.llm) return "My brain is not wired up right now.";
    // A review runs on the caller's own Claude Code credential, never the
    // bot's: it is the long, expensive job, and the usage belongs to whoever
    // asked for it. No token, no review - but the ask carries the box to put
    // one in, and the command resumes itself once it lands.
    const oauthToken = tokenFor(deps, actor);
    if (!oauthToken && !opts.botCredentialOk) {
      return deps.claudeTokens
        ? askForToken(ctx, `quick-review ${args.join(" ")}`.trim())
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
      const text = reviewHelp(prefix, wantPrompt, reviewAgentsOf(deps), botNameOf(deps), undefined, deps.reviewExtendedOwners);
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
      return `Which PR? \`${prefix} quick-review <pr-url>\` - or \`${prefix} quick-review help\` for how I do it.`;
    }
    // A review as the app writes through ONE repo-scoped credential, so it is one PR's review.
    if (asApp && (!deps.reviewApp || urls.length !== 1)) {
      return deps.reviewApp
        ? "A review as the GitHub App takes exactly one PR url."
        : "The GitHub App is not wired up here, so there is nobody to write the review as.";
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
    const account = asApp ? deps.reviewApp?.github.whoami() : deps.github?.whoami();
    // The gate's own word for it: the app's change requests go out through the app's port.
    const gateAs = asApp ? ("app" as const) : undefined;

    // Only a repo or run on `approve-first` approves here, in code, before the
    // brain is even spawned (a fixed step that must not wait ~30s for the model).
    // The default holds the approval until the review is clean. `seen` carries
    // the lines forward so the brain cannot repeat them.
    const seen = new Set<string>();
    const announcements: string[] = [];
    const approvedUpFront: string[] = [];
    // What each PR is on for this run: the flag if one was given, otherwise
    // whatever the repository is configured for.
    // A pal's review never approves up front: that would hand out an
    // approval nobody asked for. Nor is the policy, so
    // they get no say in it for a run either.
    const palOnly = !ctx.can(PERM.reviewPolicy);
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
    if (loosened && !ctx.can(PERM.manageSettings)) {
      return "That repo or author is set to approve only after a clean review, and only someone who manages settings can override that for a run.";
    }
    const policyFor = (url: string): ReviewPolicy =>
      palOnly ? "approve-after" : (override ?? configured.get(url) ?? DEFAULT_REVIEW_POLICY);
    // One review per PR. Two asks for the same PR
    // both land in this command, and two runs mean two approvals and two
    // comments on the same PR. A PR already in hand is pointed at, not redone.
    const busy: string[] = [];
    const mine: string[] = [];
    // PRs whose approval the CI watcher took over when the review ended.
    const releasedUrls = new Set<string>();
    for (const url of urls) {
      const holder = deps.reviewGuard?.claim(url, { channelId, threadTs: ctx.threadTs });
      if (!holder) {
        mine.push(url);
        continue;
      }
      const link =
        holder.threadTs && deps.slack?.permalink
          ? await deps.slack.permalink(holder.channelId, holder.threadTs).catch(logAndIgnore("review permalink"))
          : undefined;
      const where = link ? `<${link}|in this thread>` : `in <#${holder.channelId}>`;
      busy.push(`👯 ${url} ${holder.doneAt === undefined ? "is already being reviewed" : "was just reviewed"} ${where}`);
    }
    if (urls.length > 0 && mine.length === 0) return busy.join("\n");
    // Only urls can be guarded; a shorthand like `#12` has no repo to key on.
    const targets = urls.length > 0 ? mine : wanted;
    let scoped: { token: string; revoke: () => Promise<void> } | undefined;
    try {
      if (reply) for (const line of busy) await reply(line);
      // Repositories on `approve-after` are left alone until the review is in.
      const afterReview = mine.filter((u) => policyFor(u) === "approve-after");
      // CI is looked at before anything else (`deps.ciGate`; none wired, none
      // looked at). Red is a change request on the spot and never an approval;
      // a running CI gets a watcher on the watcher's timer, started before any
      // approval goes out. Merged, closed or unreadable PRs take the old path.
      const gate = deps.ciGate;
      const where = { channelId: channelId ?? "", threadTs: ctx.threadTs ?? "", slackUserId: actor.slackId };
      const redUrls: string[] = [];
      const ciLines: string[] = [];
      for (const url of mine) {
        const snap = gate ? await gate.inspect(url, gateAs) : undefined;
        if (gate && snap?.state === "OPEN") {
          if (snap.ci.verdict === "red") {
            const res = await gate.requestChanges(url, snap, "before", gateAs);
            ciLines.push(
              typeof res === "object"
                ? `⚠️ CI is red on ${url} (${failedList(snap.ci.failed)}) but I could not request changes - ${res.error}`
                : `🔴 CI is red on ${url} (${failedList(snap.ci.failed)}) - ${res === "already" ? "changes already requested" : "requested changes"}`,
            );
            // Red CI is not approved whatever the policy; the review still runs.
            if (typeof res !== "object") redUrls.push(url);
            continue;
          }
          if (snap.ci.verdict === "running") {
            const watching = gate.start({ url, policy: policyFor(url), ...(gateAs ? { identity: gateAs } : {}) }, where);
            ciLines.push(
              watching
                ? `🟡 CI is still running on ${url} - watching it`
                : `⚠️ CI is still running on ${url} and I have nowhere to keep a watcher`,
            );
          }
        }
        if (afterReview.includes(url) || redUrls.includes(url)) continue;
        const res = await deps.github?.approve(url);
        if (!res) break; // no gh wired up - leave it to the brain
        const line = res.ok ? `✅ approved ${url}` : `⚠️ could not approve ${url} - ${res.error}`;
        if (res.ok) {
          seen.add(line);
          approvedUpFront.push(url);
        }
        announcements.push(line);
      }
      // Red went in before the approvals; the order in the thread follows it.
      announcements.unshift(...ciLines);
      // A red PR also skips the up-front approval above (it `continue`s), so
      // there is nothing to undo; and a PR whose watcher is already alive
      // for the same url is kept, never doubled (`start`).

      // The model's `gh` writes as the app only through a token minted for this
      // one repo and revoked when the review ends - never the installation's own.
      scoped = asApp && urls[0] ? await mintFor(deps, urls[0]) : undefined;
      if (asApp && !scoped) return "I could not get a credential for the GitHub App on that repository (is the app installed there?), so nothing ran.";
      const params = {
        system: reviewPrompt(targets, name, await account, approvedUpFront, reviewAgentsOf(deps), note, deps.reviewExtendedOwners, redUrls, identity),
        messages: [{ role: "user" as const, content: `review ${targets.join(" ")}${note ? `\n\n${note}` : ""}` }],
        assistantName: name,
        policy,
        oauthToken,
        ...(scoped ? { env: { GH_TOKEN: scoped.token } } : {}),
        bill: { actor: actor.slackId, kind: "review", channel: channelId, threadTs: ctx.threadTs },
      };

      // No live destination (tests / slack off): one-shot, return the text.
      if (!reply) {
        let out: string;
        try {
          out = await deps.llm.complete(params);
        } catch (err) {
          if (!isClaudeAuthError(err)) throw err;
          return askForToken(ctx, `quick-review ${args.join(" ")}`.trim(), true, true);
        }
        return [...busy, ...ciLines, out.trim() || "I could not put a review together for that one."].join("\n");
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
      try {
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
          });
        } else {
          out = await deps.llm.complete(params);
        }
      } catch (err) {
        // Their token was refused mid-run: say so in one line and offer the box,
        // never the CLI's own error text. Nothing is deleted; the modal overwrites.
        if (!isClaudeAuthError(err)) throw err;
        return askForToken(ctx, `quick-review ${args.join(" ")}`.trim(), true, true);
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
      // With a CI gate a red CI is a change request instead, and a CI that is
      // still running leaves the approval to the watcher already on it.
      for (const url of afterReview) {
        if (redUrls.includes(url)) continue; // changes already requested for CI
        const decision = (await deps.github?.reviewDecision(url))?.toUpperCase();
        if (decision === "CHANGES_REQUESTED") {
          await reply(`🚫 not approving ${url} - changes are requested`);
          continue;
        }
        const snap = gate ? await gate.inspect(url, gateAs) : undefined;
        if (gate && snap?.state === "OPEN" && snap.ci.verdict === "red") {
          const res = await gate.requestChanges(url, snap, "after", gateAs);
          await reply(
            typeof res === "object"
              ? `⚠️ CI is red on ${url} (${failedList(snap.ci.failed)}) but I could not request changes - ${res.error}`
              : `🚫 not approving ${url} - CI is red (${failedList(snap.ci.failed)}), changes requested`,
          );
          continue;
        }
        if (gate && snap?.state === "OPEN" && snap.ci.verdict === "running") {
          releasedUrls.add(url);
          await reply(
            gate.release(url)
              ? `⏳ CI is still running on ${url} - I approve once it is green, and request changes if it goes red`
              : `⚠️ not approving ${url} - CI is still running and I have no watcher to wait for it`,
          );
          continue;
        }
        const res = await deps.github?.approve(url);
        if (!res) continue;
        await reply(res.ok ? `✅ approved ${url} - the review came back clean` : `⚠️ could not approve ${url} - ${res.error}`);
      }
      return ""; // already delivered to the thread / DM
    } finally {
      // A review that ended any other way than handing the approval over (cut
      // off, failed, approved here) leaves the watcher only the red to watch.
      for (const url of mine) if (!releasedUrls.has(url)) deps.ciGate?.handled(url);
      for (const url of mine) deps.reviewGuard?.release(url);
      await scoped?.revoke().catch(logAndIgnore("review token revoke"));
    }
};

export const REVIEW_COMMANDS: readonly CommandDef[] = [
  {
    name: "quick-review",
    aliases: ["rv"],
    ownHelp: true,
    minRole: "pal",
    usage: "<pr-url> [pr-url...] [--policy first|after] [what to look at]",
    summary: "quick review of a PR when asked (tag me `review <pr>` or type this; a review requested on GitHub starts the same review by itself): blockers-only comment on GitHub and here (owners set in REVIEW_EXTENDED_OWNERS: non-blocking findings too)",
    run: (ctx) => runReview(ctx),
  },
  {
    name: "logsource",
    aliases: ["logsources"],
    minRole: "pal",
    usage: "[grafana,datadog|default]",
    summary: "where I look for logs, in order",
    run: (ctx) => {
      const { deps, rest, prefix } = ctx;
      const describe = (order: readonly string[]) =>
        `I look for logs in this order: ${order.map((s) => `*${s}*`).join(" → ")}.\nNever by hand: ${DENIED_LOG_SOURCES.map((s) => `*${s}*`).join(", ")} - it bills per GB scanned. \`${prefix} cloudwatch help\` is the one allowed path.`;

      const wanted = rest.trim().toLowerCase();
      if (!wanted) return describe(logSourceOrder(deps.settings?.get(SETTING_KEYS.logSources)));

      if (!ctx.can(PERM.manageSettings)) return "You are not allowed to change where I look.";
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
    usage: "| channel <#channel>|off | auto on|off | link <github-login> [@someone] | unlink <github-login>",
    summary: "where review requests of my GitHub account and of the GitHub App get one thread per PR, reviewed by themselves on the requester's token, and who is who",
    run: ({ can, deps, actor, args, prefix }) => {
      const settings = deps.settings;
      if (!settings) return "I have nowhere to keep settings right now.";
      const sub = (args[0] ?? "").toLowerCase();
      const admin = can(PERM.manageSettings);

      if (sub === "channel") {
        if (!admin) return "You are not allowed to move the review inbox.";
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
        return `review requests of my GitHub account and of the GitHub App now get one thread per PR in <#${id}>, and the review runs in it by itself on the requester's own Claude token (\`${prefix} review-inbox auto off\` stops that)`;
      }

      if (sub === "auto") {
        if (!admin) return "You are not allowed to change whether reviews start by themselves.";
        const want = (args[1] ?? "").toLowerCase();
        if (want !== "on" && want !== "off") return `On or off? \`${prefix} review-inbox auto on|off\``;
        settings.set(SETTING_KEYS.reviewAuto, want);
        return want === "on"
          ? "reviews start by themselves now when a review is requested from my GitHub account or the GitHub App"
          : "reviews no longer start by themselves - a request on my GitHub account is only announced, a person asks with `review <pr-url>`";
      }

      if (sub === "link" || sub === "unlink") {
        const login = (args[1] ?? "").replace(/^@/, "");
        if (!/^[A-Za-z0-9-]+$/.test(login)) return `Which GitHub login? \`${prefix} review-inbox ${sub} <github-login>\``;
        const target = args[2]?.match(/^<@([UW][A-Z0-9]+)(?:\|[^>]*)?>$/)?.[1];
        const current = settings.get(githubLinkKey(login));
        // Yourself is anyone's call; somebody else's is an admin's, since it
        // decides whose token a review runs on.
        if ((target && target !== actor.slackId) || (current && current !== actor.slackId)) {
          if (!admin) return "That links someone else - only someone who manages settings can do that.";
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
          ? `review requests of my GitHub account and of the GitHub App get one thread per PR in <#${channel}>; ${
              settings.get(SETTING_KEYS.reviewAuto)?.trim().toLowerCase() === "off"
                ? "reviews do not start by themselves (`review-inbox auto on` changes that)"
                : "the review runs in the thread by itself, on the requester's own Claude token"
            }`
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
    run: ({ can, deps, args, prefix }) => {
      const settings = deps.settings;
      if (!settings) return "I have nowhere to keep settings right now.";
      const sub = (args[0] ?? "").toLowerCase();
      if (sub === "channel") {
        if (!can(PERM.manageSettings)) return "You are not allowed to move where GitHub calls land.";
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
      const { deps, args, prefix } = ctx;
      const describe = (p: ReviewPolicy) =>
        p === "approve-after"
          ? "approved *only after* the review, and only if nothing is blocking and CI is green"
          : "approved *up front* unless CI is red, reversed if the review finds a blocker or CI goes red";

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

      if (!ctx.can(PERM.manageSettings)) return "You are not allowed to change a review policy.";
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
