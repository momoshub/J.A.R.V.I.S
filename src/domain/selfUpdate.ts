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
 * Every change to the bot's own source is read by a second agent before it is
 * merged (owner's rule). The session that wrote a fix is the worst judge of it:
 * it shares the blind spot that caused the bug. A fresh agent reading the diff
 * cold is the only review a self-merged repo gets.
 */
export const STANDALONE_REVIEW_RULE =
  "before you merge, a standalone reviewer agent reviews the PR - every fix, no exceptions. Spawn a separate agent with the Agent tool in the FOREGROUND (`run_in_background: false`), never a fork and never the session that wrote the code, give it the PR url and what the change is for, and wait for its report before doing anything else. It reads the diff cold and reports correctness bugs, regressions, missing tests and stale docs. Fix every real finding on the branch, re-run `bun run typecheck` and `bun test`, push, and run a fresh reviewer again. Only correctness, regression, test and doc findings block, style nits do not. At most 3 review rounds: if it is still not clean after the third, do not merge - leave the PR open, link it and say what is still open. Say in your reply what the reviewer found. Never merge before a clean review";

export const selfUpdateRules = (repoPath?: string, restartScript?: string): string => {
  if (!repoPath || !restartScript) return "";
  // The full procedure lives in a memory skill, so it costs a line here rather
  // than a screen in every turn (owner's call). What stays is what must hold
  // even when the skill is not read: the ways to break the bot or skip review.
  return `

Working on your own source (${repoPath}):
- before changing it, read the skill in your memory about changing your own source: it holds the full procedure. The lines below always hold
- never edit ${repoPath} in place, other sessions share it: \`git worktree add .claude/worktrees/<name> -b <branch> origin/main\`, docs and tests in the same PR, then a standalone reviewer agent (foreground, fresh context, never you) before you merge it yourself, then \`git -C ${repoPath} pull --no-rebase\` and \`${restartScript}\`, which only restarts you if typecheck and tests pass
- PR descriptions and commits carry no attribution at all
- while I am running, never \`git stash\`, \`checkout\`, \`reset\` or \`rebase\` over \`data/*.db\`: it swaps the live database out and I crash mid-turn
- never restart to "see if that fixed it". Run the checks, read them, decide`;
};
