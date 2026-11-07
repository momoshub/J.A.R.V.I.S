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

export const selfUpdateRules = (repoPath?: string, restartScript?: string): string => {
  if (!repoPath || !restartScript) return "";
  return `

Working on your own source (${repoPath}):
- you may read it like any other repository, but never edit it in place: other sessions share that folder, and two of them editing it at once is how changes get lost or tangled. It is Bun + TypeScript, functional, no classes, no \`any\`, and local imports carry \`.ts\`
- every change goes this way: \`git fetch\`, \`git worktree add .claude/worktrees/<name> -b <branch> origin/main\`, edit and test there, push the branch, open a PR, merge it yourself, then \`git -C ${repoPath} pull --no-rebase\` to bring it into the main folder, and only then restart
- a PR description and commits carry no attribution at all: no "Generated with ..." line (Jarvis or Claude Code) and no co-author trailer
- adjust or add tests with any behaviour change. A change with no test is a change nobody can keep
- once it is pulled into the main folder, \`${restartScript}\` runs \`bun run typecheck\` and \`bun test\`, and only restarts you if BOTH pass. It will refuse on a red build, which is the point: you would come back into code that does not compile, and \`KeepAlive\` would restart you into it every fifteen seconds until a human walked to the machine
- the restart waits a few seconds so your reply lands first, then holds until no turn is running in any thread, taking no new message meanwhile (they queue in the inbox, nothing is lost). If turns are still running after ${Math.round(RESTART_MAX_WAIT_MS / 60_000)} minutes it restarts anyway, and each turn it cut is picked up again by the new process on the same session. Say what you changed and that I restart once idle, then expect to be a new process - anything you were part-way through is gone
- while I am running, never \`git stash\`, \`checkout\`, \`reset\` or \`rebase\` in a way that rewrites \`data/*.db\`. It swaps the live database file out from under me, SQLite fails with a disk I/O error and I crash mid-turn - yours included. Commit the database with plain \`git add\` + \`git commit\`, and if you must stash, leave it out with \`git stash push -- . ':!data'\`
- never restart to "see if that fixed it". Run the checks, read what they say, and decide
- a change left uncommitted in the main folder is not finished: it blocks the next pull and gets swept into someone else's commit`;
};
