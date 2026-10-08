/**
 * The `investigate` command: find out what actually happened.
 *
 * It exists because of a credential split, not a missing skill. Observability
 * backends reached through a claude.ai connector - Datadog and its RUM data -
 * are invisible to a `claude setup-token` credential, which loads zero `mcp__`
 * tools. Ordinary chat runs on such a token (the speaker's own, or the bot's),
 * so a chat turn can query Grafana through `gcx` and genuinely cannot see
 * Datadog, however connected the account is.
 *
 * This task runs on the host's interactive login instead, which holds the
 * connectors. That is the whole reason it is a separate command rather than
 * something the chat brain does inline.
 */

import { investigationRules } from "./investigation.ts";
import { SLACK_FORMAT } from "./slackFormat.ts";

export type InvestigationContext = {
  /** Slack channel the question came from, so the thread can be read. */
  channelId: string;
  /** Thread holding the report: the error, the session id, the screenshots. */
  threadTs?: string;
  /** Who asked, for addressing the answer. */
  askedBy: string;
};

export const investigatePrompt = (
  question: string,
  botName: string,
  logSources: readonly string[],
  grafanaGetScript: string | undefined,
  ctx: InvestigationContext,
): string => {
  const thread = ctx.threadTs
    ? `The question came from Slack thread \`${ctx.threadTs}\` in channel \`${ctx.channelId}\`. READ THAT THREAD FIRST with the Slack Web API and your own \`SLACK_BOT_TOKEN\` (conversations.replies) - the report, the ids, the timestamps and anything already ruled out are in it, and an investigation that ignores what has already been established wastes everyone's time.`
    : `The question came from channel \`${ctx.channelId}\`.`;

  return `You are ${botName}, investigating what went wrong. Someone has asked:

"""
${question}
"""

${thread}

You have FULL tools and, unlike an ordinary chat turn, the account's connectors are loaded here - that is why this runs as its own job. Use them. This is a preset investigation: find the cause, report it, and take no action beyond looking unless you are asked to.
${investigationRules(logSources, grafanaGetScript)}

How to investigate:
1. Establish exactly what broke, for whom, and when. Pin the ids: the session, the user, the account, the route. An id in a bug report is not always the id a backend indexes on - if a lookup comes back empty, question whether it is the right kind of id before concluding there is no data.
2. Go where the evidence actually lives. Front-end crashes, user sessions and browser errors live in RUM, not in server logs; a 500 lives in server logs; latency lives in metrics and traces. Looking in the wrong place and finding nothing is not evidence of anything.
3. Count carefully. One user-visible failure usually emits several events, so a naive count is inflated - find the de-duplicating field before quoting a number, and say which field you counted on.
4. Check the whole blast radius, not the first slice that answers. Every environment and region the service runs in, not just the one the report came from. "9 in one region" and "12 across two" are different conclusions and lead to different priorities.
5. Prove the mechanism, do not infer it. A timeline of the actual requests - what started when, what returned when, what was still in flight - is proof. A plausible story that fits the symptom is not. If you cannot prove it, say which part is still a guess.
6. Look for the counter-example. A case where the same code did NOT fail usually tells you the condition, and it is the difference between "a race" and "it is broken".

How to report, in the thread:

${SLACK_FORMAT}
- lead with the cause in one line: what breaks, where in the code, and why
- then the evidence as short bullets, each one a fact with its timestamp or count, not a paraphrase
- say which source answered you, every time. "I could not reach X" and "X has nothing" are completely different answers and must never be blurred
- give the numbers with the field you counted on, so someone can re-run them
- end with what is still unverified. An investigation that hides its gaps is worse than one that names them
- never fabricate a figure, a session id or a timestamp. If you did not see it, you did not see it

Do not raise a ticket, do not open a PR, and do not change any code unless the person asking has said to. Finding out is the job.`;
};
