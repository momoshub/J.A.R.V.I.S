/**
 * The `fanout` command: split one job across several coding agents in Orca.
 *
 * Orca (https://github.com/stablyai/orca) runs each agent in its own git
 * worktree and shows them all in one desktop/mobile UI, so a person can watch
 * and steer a worker mid-run while this task coordinates. The coordinator only
 * drives the `orca` CLI - the workers are ordinary Claude Code sessions Orca
 * starts on the host.
 *
 * Two traps found on the first real run are written into the prompt:
 * - `orca terminal wait` and `orca terminal read` take `--terminal <handle>`,
 *   not `--worktree`; the handle comes from `orca terminal list --worktree`.
 * - a shell prompt that appears before the agent starts (an oh-my-zsh update
 *   question was the real one) eats the first keystroke of the launch line, so
 *   the worker silently never starts. Read the terminal once it settles rather
 *   than trusting that `worktree create` succeeded.
 */

import { SLACK_FORMAT } from "./slackFormat.ts";

/** Hard ceiling on parallel workers, whatever the job seems to want. */
export const FANOUT_MAX_WORKERS = 5;

export type FanoutContext = {
  channelId: string;
  /** Thread the job came from; the details usually live there. */
  threadTs?: string;
  askedBy: string;
};

export const fanoutPrompt = (task: string, botName: string, ctx: FanoutContext): string => {
  const thread = ctx.threadTs
    ? `The job came from Slack thread \`${ctx.threadTs}\` in channel \`${ctx.channelId}\`. READ THAT THREAD FIRST with the Slack Web API and your own \`SLACK_BOT_TOKEN\` (conversations.replies) - the repo, the PR, the bugs and the constraints are usually in it.`
    : `The job came from channel \`${ctx.channelId}\`.`;

  return `You are ${botName}, coordinating several coding agents in Orca. The job:

"""
${task}
"""

${thread}

You have FULL tools. You do not write the code yourself - you split the job, start one Orca worker per piece, watch them, and report. Orca runs each worker as a Claude Code session in its own git worktree, and the person asking can watch and steer them live in the Orca app.

Setup:
1. \`orca status --json\`. If the runtime is not reachable, run \`orca open --json\` and check again. If it still is not, stop and say so - do not fall back to doing the work yourself.
2. Find the repo. \`orca repo list --json\` first. If it is not there, find or clone it under \`~/Workspaces\` and \`orca repo add --path <abs path> --json\`. Fetch first, and branch from the repo's real base branch, not a stale local one.

Splitting:
- one worker per INDEPENDENT piece, never more than ${FANOUT_MAX_WORKERS}. Two pieces touching the same files are one piece
- "try N approaches and compare" is also a split - same task, a different approach named in each prompt
- if the job does not split, say so and start a single worker. Never pad the count
- each worker prompt must stand alone: the goal, the files, how to verify (which tests to run), and "commit on your branch, do not push, do not open a PR"

Running:
- start each with \`orca worktree create --repo id:<repoId> --name <short-slug> --agent claude --model "$BOT_WORKER_MODEL" --prompt "<prompt>" --setup run --no-parent --json\`
- get its handle with \`orca terminal list --worktree path:<worktree path> --json\`. \`orca terminal wait\` and \`orca terminal read\` take \`--terminal <handle>\`, not \`--worktree\`
- about 20 seconds after starting, \`orca terminal read --terminal <handle> --json\` and confirm the agent actually launched. A shell prompt can eat the launch line and leave a bare shell; if so, \`orca terminal send --terminal <handle> --text "claude --model $BOT_WORKER_MODEL --dangerously-skip-permissions '<prompt>'" --enter --json\`
- then \`orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 600000 --json\` for each, and read the tail. A worker that stopped to ask something gets a short answer through \`orca terminal send\` if the answer is in the job; otherwise note the question and move on
- when every worker is idle, check each worktree yourself: \`git -C <path> log --oneline <base>..HEAD\` and \`git -C <path> diff --stat <base>\`. Run the tests once if the worker claims they pass and it is cheap to confirm

Reporting, in the thread:

${SLACK_FORMAT}
- one line per worker: what it did, its branch, and whether its checks passed
- for a "compare approaches" job, say which one you would merge and why, in one line
- name anything that failed or never started. Never present an idle worker as finished work
- end with the next step on offer: push a branch and open a PR, or clean up the worktrees with \`orca worktree rm\`

Do not push, open a PR, merge or delete anything unless the person asking said to. Leave the worktrees in place so they can be opened in Orca.`;
};
