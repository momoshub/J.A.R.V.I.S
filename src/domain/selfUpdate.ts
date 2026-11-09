/**
 * Letting the bot work on its own source.
 *
 * It already can: a full-access turn runs with the shell in the workspace that
 * holds this repository. What it could not do safely was finish the job -
 * restarting to pick up a change kills the very turn that asked for it, so the
 * reply never lands and nobody learns whether it worked.
 *
 * Two rules make this safe rather than merely possible:
 *
 * - the checks are not optional. A bot that restarts into code which does not
 *   compile is a bot that crash-loops, and `KeepAlive` will restart it into the
 *   same broken build every fifteen seconds forever. There is no way back from
 *   inside Slack; somebody has to walk to the machine.
 * - the restart is DEFERRED, never immediate. The request returns first, the
 *   reply posts, and the process exits a few seconds later - so the thread
 *   learns what happened instead of going silent mid-sentence.
 */

/** How long the bot waits before exiting, so a reply can land first. */
export const RESTART_DELAY_MS = 6_000;

/** How often a pending restart looks again while turns are still running. */
export const RESTART_POLL_MS = 5_000;

/**
 * The longest a restart waits for running turns. Waiting for "idle" with no
 * bound meant a bot with several busy threads might never restart, and every
 * thread paid for the slowest one. Past this the turns still running are cut,
 * and the inbox hands each one back to the new process to pick up again.
 */
/**
 * How long a restart waits for running turns before cutting them.
 *
 * Left at fifteen minutes on purpose. The incident that made this painful was
 * a BACKGROUND worker holding it open, and those no longer count towards
 * idleness at all - so what remains is a foreground turn somebody is waiting
 * on, and cutting one of those early is a worse trade than waiting. The
 * silence is handled where it belongs, by telling the thread.
 */
export const RESTART_MAX_WAIT_MS = 15 * 60_000;

/**
 * How long a turn that STARTED while a restart waits may run before it is cut.
 *
 * Holding every new message until the slowest running turn ended left people
 * unanswered for up to the full wait. So new messages still run while a
 * restart waits, but on this budget: most answers fit in it, and one that
 * does not is told to hold on, cut, and picked up again by the next process
 * on the same session. Elapsed time is the signal - nothing is classified up
 * front. Overridable with `RESTART_TURN_BUDGET_MS`.
 */
export const RESTART_TURN_BUDGET_MS = 2 * 60_000;

/** What a thread is told when its turn ran past the budget and is cut for the restart. */
export const RESTART_HOLD_NOTICE = "⏳ đợi em xíu, vài phút em quay lại _(restarting - I will pick this up again in a few minutes)_";

export type IdleRestartDeps = {
  /** True when no turn is running or queued, in any thread. */
  readonly isIdle: () => boolean;
  readonly exit: () => void;
  readonly schedule: (fn: () => void, ms: number) => void;
  readonly log?: (line: string) => void;
  readonly delayMs?: number;
  readonly pollMs?: number;
  /**
   * Called once, as soon as the restart is asked for. New work still runs
   * from here on, but each new turn on a budget (`RESTART_TURN_BUDGET_MS`),
   * so it cannot hold the restart open for long.
   */
  readonly onDrain?: () => void;
  /**
   * True once nothing that started BEFORE the restart was asked for is still
   * running. Without it the intake stays open until the cap.
   */
  readonly settled?: () => boolean;
  /**
   * Called once, the first time `settled` holds while something still runs:
   * stop taking new work, so the budgeted turns left are the last ones and
   * the wait ends within one budget. The gateway keeps queueing meanwhile.
   */
  readonly onSettled?: () => void;
  /** Called right before an exit that cuts turns still running, to mark them. */
  readonly onForce?: () => void;
  readonly maxWaitMs?: number;
};

/**
 * Restart when nothing is in flight, or once the wait runs out. Exiting under
 * a running turn cuts it, so the exit waits the usual delay for the asker's
 * reply to land, then keeps looking until every turn has finished.
 *
 * New messages are still answered while it waits (`onDrain` puts each new
 * turn on a budget), and three things keep the wait bounded. A new turn past
 * its budget is cut and picked up again after the restart. Once the turns
 * from before the request have finished (`settled`), new work stops
 * (`onSettled`), so a steady trickle of messages cannot keep it from ever
 * being idle - what is left ends within one budget. And past `maxWaitMs` it
 * exits anyway, after `onForce` marks what it cut - the inbox redelivers those
 * rows to the new process, which picks each one up on the same session.
 */
export const restartWhenIdle = (deps: IdleRestartDeps): void => {
  const poll = deps.pollMs ?? RESTART_POLL_MS;
  const delay = deps.delayMs ?? RESTART_DELAY_MS;
  const maxWait = deps.maxWaitMs ?? RESTART_MAX_WAIT_MS;
  let waited = 0;
  let logged = false;
  let closed = false;
  deps.onDrain?.();
  const attempt = (): void => {
    if (deps.isIdle()) {
      deps.exit();
      return;
    }
    if (!closed && deps.settled?.()) {
      closed = true;
      deps.log?.("restart: the turns from before it have finished, taking no new work until the last ones end");
      deps.onSettled?.();
    }
    if (waited >= maxWait) {
      deps.log?.(`restart forced: turns still running after ${Math.round(maxWait / 60_000)} min, cutting them to pick up again`);
      deps.onForce?.();
      deps.exit();
      return;
    }
    if (!logged) {
      deps.log?.("restart deferred: turns still running; new messages still run, each on a short budget");
      logged = true;
    }
    waited += poll;
    deps.schedule(attempt, poll);
  };
  deps.schedule(attempt, delay);
};

/**
 * Every change to the bot's own source passes CI before it is merged, and a
 * change to runtime code is read by a second agent first (owner's rule, review
 * by risk since 2026-11-08: docs, prompt text, adapter skills, prompt guides
 * and dashboard UI need no reviewer; logic, commands, adapters and `bin/`
 * scripts get one, for at most two rounds). The session that wrote a fix is the
 * worst judge of it: it shares the blind spot that caused the bug. The reviewer is an
 * Orca worker (owner's call, so it shows on Orca like every other background
 * agent) and the two talk only on the PR: the reviewer posts each round as a
 * PR comment, the writer answers with a push and a comment saying what changed,
 * and the reviewer re-reads. Orca cannot wake the writer, so the writer polls
 * the PR for the next review comment. Each comment opens with a marker that
 * says who wrote it - they may share one GitHub account (see
 * `selfPrAccountsRule` for when they do not). GitHub cannot require
 * the check on this plan, so `bin/merge-when-green.sh` is the CI gate.
 */
/** Runs the reviewer as an Orca worker (owner) or as an Agent tool agent in the writer's own process (admin: `orca` is denied below owner). */
export const standaloneReviewRule = (orca = true): string =>
  "review by risk. A PR that only touches docs, prompt text, adapter skills, prompt guides or dashboard UI gets no reviewer: `bun run typecheck` and `bun test` green, CI green through `bin/merge-when-green.sh <pr>` (below), merge. A PR that touches runtime code - logic, commands, adapters, `bin/` scripts - gets a standalone reviewer agent before you merge, and a mixed PR counts as runtime code. " +
  (orca
    ? "The reviewer is an Orca worker, never the Agent tool, never a fork and never the session that wrote the code: open a fresh Run with `orca orchestration run-create --objective <short> --json` and start it with `orca orchestration worker-start --run <runId> --spec-file <brief> --task-title <short> --worktree path:<a folder or repo Orca knows, see `orca repo list`> --agent claude --model \"$BOT_WORKER_MODEL\" --json` (only if `orca status` says the runtime is not reachable, `ORCA_TERMINAL_HANDLE` is unset, `run-create` refuses it as `terminal_handle_stale` or your tools refuse `orca`, use a background Agent tool reviewer on the same PR-comment protocol, and say so). "
    : "The reviewer is a background Agent tool agent (`run_in_background: true`, a self-contained brief) in your own process - never a fork and never the session that wrote the code - and you never run `orca` (it is the owner's: your tools refuse it). ") +
  "Its brief gives the PR url and what the change is for, and tells it the whole review happens on the PR. It reads the diff only through `gh pr diff` / `gh pr view` and never checks out, edits or runs anything in the folder it starts in - that may be a live checkout other sessions share - and if it needs to run the checks it cuts its own `git worktree add` from `origin/<branch>` and removes it after. It reports correctness bugs, regressions, missing tests and stale docs as one PR comment that starts with `[review round N]` (N from 1) and ends with `VERDICT: clean` or `VERDICT: changes` (changes only for a real blocker), then polls the PR every 30s for a `[fix round N]` comment answering that round and re-reviews the head as `[review round 2]` - round 2 happens only when round 1 is `VERDICT: changes` with a real blocker, and there is never a round 3 - even when that fix comment only pushes back or asks and the head did not move - it still counts as a round. It exits when it posts `VERDICT: clean`, after round 2, when the PR is merged or closed, or after 40 minutes with no new `[fix round N]` comment. You never use SendMessage or TaskStop for it. Never end your turn while it is open: wait for its next `[review round N]` comment in a Bash loop (background, or foreground chunks of up to 10 minutes re-run until the deadline) " +
  (orca
    ? "that also stops when `orca orchestration task-list --run <runId> --json` shows the reviewer task completed, failed or blocked (blocked: it stopped without reporting)"
    : "that also stops when the reviewer agent has finished (its completion notice reaches you) with no new review comment") +
  " with no new review comment, and gives up after 30 minutes - a reviewer that died or never answered is a review that is not clean. Fix every real finding on the branch, re-run `bun run typecheck` and `bun test`, push, then post a PR comment that starts with `[fix round N]` (the round you are answering) and says what you changed, finding by finding - push back or ask it the same way. After `[review round 2]` with `VERDICT: changes` the reviewer is gone: post no fix comment and wait for nothing. The markers are how each side tells the other apart, even when both post from the same GitHub account: no attribution, no names. Only correctness, regression, test and doc findings block, style nits do not. At most 2 review rounds: if it is still not clean after the second, or the reviewer died or went silent, do not merge - leave the PR open, link it and say what is still open. Merge only with `bin/merge-when-green.sh <pr>` from the worktree, after the last push, with a Bash timeout of 600000: it waits for CI on that exact commit and refuses on red, then approves the PR as the merging account when that account did not open it (a failed approval is no merge), exit 3 means CI has not finished so run it again, exit 4 means the PR conflicts with its base and GitHub never runs CI on it - merge the base in, resolve, push and run it again, never just rerun it - and red CI is a finding to fix like any other. Never fall back to a bare `gh pr merge`. Say in your reply what the reviewer found, or that the PR needed none. Never merge runtime code before a clean review, and never merge anything before green CI";

export const STANDALONE_REVIEW_RULE = standaloneReviewRule(true);

/** The two GitHub logins a self-fix PR is split across. */
export type SelfPrAccounts = { readonly author: string; readonly reviewer: string };

/**
 * Both logins or nothing: half a split would leave one step on the wrong
 * account, and one login twice is no second pair of eyes.
 */
export const parseSelfPrAccounts = (author?: string, reviewer?: string): SelfPrAccounts | undefined => {
  const a = author?.trim();
  const r = reviewer?.trim();
  return a && r && a.toLowerCase() !== r.toLowerCase() ? { author: a, reviewer: r } : undefined;
};

/**
 * Owner's rule: the PR is opened by one account and reviewed and merged by
 * another, so GitHub shows a real second pair of eyes. Each command picks its
 * account with `GH_TOKEN=$(gh auth token -u <login>)` rather than `gh auth
 * switch`, which would flip the active account under every other session.
 * A login gh does not hold prints no token, and an empty GH_TOKEN is read as
 * unset, so gh would quietly fall back to the active account: the rule makes
 * that a stop, not a silent post under the wrong name.
 */
export const selfPrAccountsRule = (accounts?: SelfPrAccounts): string => {
  if (!accounts) return "";
  const as = (login: string) => `\`GH_TOKEN=$(gh auth token -u ${login})\``;
  return `GitHub accounts: open the PR and post every \`[fix round N]\` comment as \`${accounts.author}\` (${as(accounts.author)} in front of \`gh pr create\` and \`gh pr comment\`); the reviewer posts every \`[review round N]\` comment as \`${accounts.reviewer}\` (say so in its brief, with ${as(accounts.reviewer)} in front of \`gh pr comment\`); merge as \`${accounts.reviewer}\`: ${as(accounts.reviewer)} in front of \`bin/merge-when-green.sh <pr>\`, which approves the PR as \`${accounts.reviewer}\` right before it merges, so the PR shows a real approval. Check each login first: if \`gh auth token -u <login>\` fails or prints nothing, stop and say so - an empty GH_TOKEN falls back to the active account without a word, and neither side may post or merge under the wrong one (say the same in the reviewer's brief). Never \`gh auth switch\`: it flips the account under every other session`;
};

const fullRules = (repoPath: string, restartScript: string, accounts?: SelfPrAccounts, orca = true): string => `

Working on your own source (${repoPath}):
- you may read it like any other repository, but never edit it in place: other sessions share that folder, and two of them editing it at once is how changes get lost or tangled. It is Bun + TypeScript, functional, no classes, no \`any\`, and local imports carry \`.ts\`
- every change goes this way: \`git fetch\`, \`git worktree add .claude/worktrees/<name> -b <branch> origin/main\`, edit and test there, push the branch, open a PR, get runtime code reviewed by a standalone reviewer agent (docs, prompt text, skills and dashboard UI need none) and green CI (next line), merge it yourself, then \`git -C ${repoPath} pull --no-rebase\` to bring it into the main folder, and only then restart
- ${standaloneReviewRule(orca)}${accounts ? `\n- ${selfPrAccountsRule(accounts)}` : ""}
- a PR description and commits carry no attribution at all: no "Generated with ..." line (Jarvis or Claude Code) and no co-author trailer
- adjust or add tests with any behaviour change. A change with no test is a change nobody can keep
- once it is pulled into the main folder, \`${restartScript}\` runs \`bun run typecheck\` and \`bun test\`, and only restarts you if BOTH pass. It will refuse on a red build, which is the point: you would come back into code that does not compile, and \`KeepAlive\` would restart you into it every fifteen seconds until a human walked to the machine
- the restart waits a few seconds so your reply lands first, then holds until no turn is running in any thread. New messages are still answered meanwhile, each on a short budget (\`RESTART_TURN_BUDGET_MS\`, ${Math.round(RESTART_TURN_BUDGET_MS / 60_000)} minutes unless set otherwise): one that runs past it tells its thread to hold on and is cut, then picked up again after the restart on the same session. Once the turns from before the restart finish it takes no new message (they queue in the inbox, nothing is lost). If turns are still running after ${Math.round(RESTART_MAX_WAIT_MS / 60_000)} minutes it restarts anyway, and each turn it cut is picked up again by the new process on the same session. Say what you changed and that I restart once idle, then expect to be a new process - anything you were part-way through is gone
- while I am running, never \`git stash\`, \`checkout\`, \`reset\` or \`rebase\` in a way that rewrites \`data/*.db\`. It swaps the live database file out from under me, SQLite fails with a disk I/O error and I crash mid-turn - yours included. Commit the database with plain \`git add\` + \`git commit\`, and if you must stash, leave it out with \`git stash push -- . ':!data'\`
- never restart to "see if that fixed it". Run the checks, read what they say, and decide
- a change left uncommitted in the main folder is not finished: it blocks the next pull and gets swept into someone else's commit`;


/**
 * The self-update block of the chat prompt. With a memory skill to read, the
 * full procedure lives there (owner's call: it cost ~2.5KB in every full-access
 * turn about every topic) and the prompt keeps a pointer plus what must hold
 * even when the skill is not read. With no skill to point at - no adapter, no
 * skills, or skills hidden from this turn - the full block stays, so an
 * instance without the skill loses nothing. The instance skill repeats the
 * restart wait in prose; keep it in step with RESTART_MAX_WAIT_MS.
 */
export const selfUpdateRules = (
  repoPath?: string,
  restartScript?: string,
  hasSkills = false,
  accounts?: SelfPrAccounts,
  /** False below owner: the reviewer is then an Agent tool agent, `orca` is denied. */
  orca = true,
): string => {
  if (!repoPath || !restartScript) return "";
  if (!hasSkills) return fullRules(repoPath, restartScript, accounts, orca);
  return `

Working on your own source (${repoPath}):
- before changing it, read the skill in your memory about changing your own source: it holds the full procedure. The lines below always hold
- never edit ${repoPath} in place, other sessions share it: \`git worktree add .claude/worktrees/<name> -b <branch> origin/main\`, docs and tests in the same PR; for runtime code (logic, commands, adapters, \`bin/\`, or mixed) a standalone reviewer agent (${orca ? "Orca worker" : "background Agent tool agent, never orca"}, fresh context, PR comments only, max 2 rounds) - docs, prompt text, skills, dashboard UI need none - and green CI before you merge it yourself with \`bin/merge-when-green.sh\`, then \`git -C ${repoPath} pull --no-rebase\` and, for a code change, \`${restartScript}\`, which only restarts you if typecheck and tests pass${accounts ? `\n- ${selfPrAccountsRule(accounts)}` : ""}
- after the restart helper, say what you changed and that I restart once idle (up to ${Math.round(RESTART_MAX_WAIT_MS / 60_000)} minutes). Expect to be a new process: anything you were part-way through is gone
- PR descriptions and commits carry no attribution at all
- while I am running, never \`git stash\`, \`checkout\`, \`reset\` or \`rebase\` over \`data/*.db\`: it swaps the live database out and I crash mid-turn
- never restart to "see if that fixed it". Run the checks, read them, decide`;
};
