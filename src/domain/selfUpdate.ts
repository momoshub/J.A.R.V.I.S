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

export const selfUpdateRules = (repoPath?: string, restartScript?: string): string => {
  if (!repoPath || !restartScript) return "";
  return `

Working on your own source (${repoPath}):
- you may read and edit it like any other repository. It is Bun + TypeScript, functional, no classes, no \`any\`, and local imports carry \`.ts\`
- adjust or add tests with any behaviour change. A change with no test is a change nobody can keep
- when you are done, \`${restartScript}\` runs \`bun run typecheck\` and \`bun test\`, and only restarts you if BOTH pass. It will refuse on a red build, which is the point: you would come back into code that does not compile, and \`KeepAlive\` would restart you into it every fifteen seconds until a human walked to the machine
- the restart is deferred by a few seconds so your reply lands first. Say what you changed and that you are restarting, then expect to be a new process - anything you were part-way through is gone
- never restart to "see if that fixed it". Run the checks, read what they say, and decide
- do not commit or push unless you were asked to. Leaving the change in the working tree is a complete answer`;
};
