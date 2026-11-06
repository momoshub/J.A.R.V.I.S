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

export type IdleRestartDeps = {
  /** True when no turn is running or queued, in any thread. */
  readonly isIdle: () => boolean;
  readonly exit: () => void;
  readonly schedule: (fn: () => void, ms: number) => void;
  readonly log?: (line: string) => void;
  readonly delayMs?: number;
  readonly pollMs?: number;
};

/**
 * Restart only when nothing is in flight. Exiting under a running turn kills
 * it - somebody else's review or deploy watch, in another thread, gone without
 * a word. So the exit waits the usual delay for the asker's reply to land, then
 * keeps looking until every turn has finished. It never forces: a restart that
 * waits is cheap, a turn killed mid-work is not.
 */
export const restartWhenIdle = (deps: IdleRestartDeps): void => {
  const poll = deps.pollMs ?? RESTART_POLL_MS;
  let logged = false;
  const attempt = (): void => {
    if (deps.isIdle()) {
      deps.exit();
      return;
    }
    if (!logged) {
      deps.log?.("restart deferred: turns still running, waiting for idle");
      logged = true;
    }
    deps.schedule(attempt, poll);
  };
  deps.schedule(attempt, deps.delayMs ?? RESTART_DELAY_MS);
};

export const selfUpdateRules = (repoPath?: string, restartScript?: string): string => {
  if (!repoPath || !restartScript) return "";
  return `

Working on your own source (${repoPath}):
- you may read and edit it like any other repository. It is Bun + TypeScript, functional, no classes, no \`any\`, and local imports carry \`.ts\`
- adjust or add tests with any behaviour change. A change with no test is a change nobody can keep
- when you are done, \`${restartScript}\` runs \`bun run typecheck\` and \`bun test\`, and only restarts you if BOTH pass. It will refuse on a red build, which is the point: you would come back into code that does not compile, and \`KeepAlive\` would restart you into it every fifteen seconds until a human walked to the machine
- the restart only happens when I am idle: it waits a few seconds so your reply lands first, then holds until no turn is running in any thread, so it never kills someone else's work. Say what you changed and that I restart once idle, then expect to be a new process - anything you were part-way through is gone
- while I am running, never \`git stash\`, \`checkout\`, \`reset\` or \`rebase\` in a way that rewrites \`data/*.db\`. It swaps the live database file out from under me, SQLite fails with a disk I/O error and I crash mid-turn - yours included. Commit the database with plain \`git add\` + \`git commit\`, and if you must stash, leave it out with \`git stash push -- . ':!data'\`
- never restart to "see if that fixed it". Run the checks, read what they say, and decide
- do not commit or push unless you were asked to. Leaving the change in the working tree is a complete answer`;
};
