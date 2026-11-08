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

export type IdleRestartDeps = {
  /** True when no turn is running or queued, in any thread. */
  readonly isIdle: () => boolean;
  readonly exit: () => void;
  readonly schedule: (fn: () => void, ms: number) => void;
  readonly log?: (line: string) => void;
  readonly delayMs?: number;
  readonly pollMs?: number;
  /**
   * Called once, as soon as the restart is asked for: stop taking new work, so
   * the wait is for the turns already running and nothing that arrives later.
   * The gateway keeps queueing meanwhile, so nothing is lost.
   */
  readonly onDrain?: () => void;
  /** Called right before an exit that cuts turns still running, to mark them. */
  readonly onForce?: () => void;
  readonly maxWaitMs?: number;
};

/**
 * Restart when nothing is in flight, or once the wait runs out. Exiting under
 * a running turn cuts it, so the exit waits the usual delay for the asker's
 * reply to land, then keeps looking until every turn has finished.
 *
 * Two things keep that wait short and bounded. New work stops at once
 * (`onDrain`): the bot takes no new message while it waits, so a busy thread
 * cannot keep it from ever being idle. And past `maxWaitMs` it exits anyway,
 * after `onForce` marks what it cut - the inbox redelivers those rows to the
 * new process, which picks each one up on the same session.
 */
export const restartWhenIdle = (deps: IdleRestartDeps): void => {
  const poll = deps.pollMs ?? RESTART_POLL_MS;
  const delay = deps.delayMs ?? RESTART_DELAY_MS;
  const maxWait = deps.maxWaitMs ?? RESTART_MAX_WAIT_MS;
  let waited = 0;
  let logged = false;
  deps.onDrain?.();
  const attempt = (): void => {
    if (deps.isIdle()) {
      deps.exit();
      return;
    }
    if (waited >= maxWait) {
      deps.log?.(`restart forced: turns still running after ${Math.round(maxWait / 60_000)} min, cutting them to pick up again`);
      deps.onForce?.();
      deps.exit();
      return;
    }
    if (!logged) {
      deps.log?.("restart deferred: turns still running, taking no new work until they finish");
      logged = true;
    }
    waited += poll;
    deps.schedule(attempt, poll);
  };
  deps.schedule(attempt, delay);
};

/**
 * Every change to the bot's own source is read by a second agent and passes CI
 * before it is merged (owner's rule). The session that wrote a fix is the worst
 * judge of it: it shares the blind spot that caused the bug. The reviewer runs
 * in the background and stays alive until the merge, so finding -> fix ->
 * re-review is a conversation with one reviewer over SendMessage instead of a
 * fresh cold read every round. It must not outlive the turn unwatched: the
 * writer waits for it and stops it once the PR is settled. GitHub cannot
 * require the check on this plan, so `bin/merge-when-green.sh` is the CI gate.
 */
export const STANDALONE_REVIEW_RULE =
  "before you merge, a standalone reviewer agent reviews the PR and CI is green - every fix, no exceptions. Spawn a separate agent with the Agent tool in the BACKGROUND (`run_in_background: true`), never a fork and never the session that wrote the code, give it the PR url and what the change is for, and tell it to report its findings and stay ready to re-review. It reads the diff cold and reports correctness bugs, regressions, missing tests and stale docs. Never end your turn while it is open: wait for its report. Fix every real finding on the branch, re-run `bun run typecheck` and `bun test`, push, then tell the same reviewer what you changed with SendMessage so it re-reads the new diff - push back or ask it the same way. Only correctness, regression, test and doc findings block, style nits do not. At most 3 review rounds: if it is still not clean after the third, do not merge - leave the PR open, link it and say what is still open. Merge only with `bin/merge-when-green.sh <pr>` from the worktree, after the last push, with a Bash timeout of 600000: it waits for CI on that exact commit and refuses on red, exit 3 means CI has not finished so run it again, and red CI is a finding to fix like any other. Never fall back to a bare `gh pr merge`. Once the PR is merged or left open, stop the reviewer with TaskStop. Say in your reply what the reviewer found. Never merge before a clean review and green CI";

const fullRules = (repoPath: string, restartScript: string): string => `

Working on your own source (${repoPath}):
- you may read it like any other repository, but never edit it in place: other sessions share that folder, and two of them editing it at once is how changes get lost or tangled. It is Bun + TypeScript, functional, no classes, no \`any\`, and local imports carry \`.ts\`
- every change goes this way: \`git fetch\`, \`git worktree add .claude/worktrees/<name> -b <branch> origin/main\`, edit and test there, push the branch, open a PR, get it reviewed by a standalone reviewer agent and green CI (next line), merge it yourself, then \`git -C ${repoPath} pull --no-rebase\` to bring it into the main folder, and only then restart
- ${STANDALONE_REVIEW_RULE}
- a PR description and commits carry no attribution at all: no "Generated with ..." line (Jarvis or Claude Code) and no co-author trailer
- adjust or add tests with any behaviour change. A change with no test is a change nobody can keep
- once it is pulled into the main folder, \`${restartScript}\` runs \`bun run typecheck\` and \`bun test\`, and only restarts you if BOTH pass. It will refuse on a red build, which is the point: you would come back into code that does not compile, and \`KeepAlive\` would restart you into it every fifteen seconds until a human walked to the machine
- the restart waits a few seconds so your reply lands first, then holds until no turn is running in any thread, taking no new message meanwhile (they queue in the inbox, nothing is lost). If turns are still running after ${Math.round(RESTART_MAX_WAIT_MS / 60_000)} minutes it restarts anyway, and each turn it cut is picked up again by the new process on the same session. Say what you changed and that I restart once idle, then expect to be a new process - anything you were part-way through is gone
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
export const selfUpdateRules = (repoPath?: string, restartScript?: string, hasSkills = false): string => {
  if (!repoPath || !restartScript) return "";
  if (!hasSkills) return fullRules(repoPath, restartScript);
  return `

Working on your own source (${repoPath}):
- before changing it, read the skill in your memory about changing your own source: it holds the full procedure. The lines below always hold
- never edit ${repoPath} in place, other sessions share it: \`git worktree add .claude/worktrees/<name> -b <branch> origin/main\`, docs and tests in the same PR, then a standalone reviewer agent (background, fresh context, never you, stopped after the merge) and green CI before you merge it yourself with \`bin/merge-when-green.sh\`, then \`git -C ${repoPath} pull --no-rebase\` and, for a code change, \`${restartScript}\`, which only restarts you if typecheck and tests pass
- after the restart helper, say what you changed and that I restart once idle (up to ${Math.round(RESTART_MAX_WAIT_MS / 60_000)} minutes). Expect to be a new process: anything you were part-way through is gone
- PR descriptions and commits carry no attribution at all
- while I am running, never \`git stash\`, \`checkout\`, \`reset\` or \`rebase\` over \`data/*.db\`: it swaps the live database out and I crash mid-turn
- never restart to "see if that fixed it". Run the checks, read them, decide`;
};
