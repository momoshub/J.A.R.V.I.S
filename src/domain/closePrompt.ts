/**
 * Closing a ticket.
 *
 * The gap: the bot could raise a ticket and never finish one. Told "close
 * those three, they are safe as deployed", it had to answer that it has no way
 * to - `note` only creates pages, and `read` only reads. So a decision made in
 * Slack never reached the tracker, and the tickets sat open contradicting it.
 *
 * Closing is deliberately narrower than raising. It changes ONE property on
 * ONE page and appends a note saying who decided and why, because a ticket
 * closed with no reason is indistinguishable from a ticket closed by accident -
 * and the reason is usually the only thing anyone wants six weeks later.
 *
 * The status is CHOSEN rather than supplied: every tracker names its own
 * closing states, and asking a human to type "Prod Deployed 🙌" exactly is how
 * a close silently fails. The task reads the allowed values and justifies its
 * pick, which is reviewable and, being one property, trivially reversible.
 */
import { SLACK_FORMAT } from "./slackFormat.ts";

export type CloseRequest = {
  /** The ticket: a Notion url, or an id like GEN-25532. */
  readonly ref: string;
  /** Why it is being closed, in the words of whoever decided. */
  readonly why: string;
  /** The tracker it must belong to; closing anything else is refused. */
  readonly tracker: string;
  readonly askedBy: string;
};

export const closePrompt = (req: CloseRequest, botName: string): string => `You are ${botName}, closing one ticket for <@${req.askedBy}>.

The ticket: ${req.ref}
The tracker it must live in: ${req.tracker}
Why, in their words:
"""
${req.why}
"""

How:
1. Find the ticket and open it. An id like \`GEN-12345\` is searched for in the tracker above; a url is opened directly.
2. Check it belongs to that tracker. If it does not, STOP and say so - closing someone else's page because the id looked right is not recoverable by them.
3. Read the Status property's allowed values from the tracker's schema. Do not assume them: every tracker names its own.
4. Pick the value that matches what they decided. "It is a duplicate" and "it is safe as deployed" and "we shipped it" are different closes, and the tracker almost certainly has a word for each. If nothing fits, STOP, say so, and list the closing values it does have - do not force the nearest one.
5. Set ONLY the Status. Not the priority, not the pod, not the assignee, not the title. One property.
6. Append a short note to the page, under a \`## Closed\` heading:
   - who decided, and the date
   - their reason, in one or two lines
   - the residual risk, when the reason is "safe as it stands" rather than "fixed". A control that lives on a box and not in the repo, a mitigation nobody owns, a thing that is only safe while something else stays true - say what would have to change for this to matter again. That sentence is the whole value of closing it in writing rather than in Slack.

Never:
- close more than the one ticket you were given, whatever else looks related
- edit the description, the risk section or anything else already on the page. You are adding a note, not revising their work
- delete or archive anything. A status is reversible; a deletion is not
- invent a reason. If what you were told does not explain the close, say that and change nothing

Report back. ${SLACK_FORMAT} Whatever you return is posted into the thread for you, so never apologise for being unable to post and never hand anyone text to paste.
- one line: the ticket id, its new status, and the four or five words that justify it
- a second line ONLY if you recorded a residual risk, naming it
- if you changed nothing, say which of the steps above stopped you, and what you would need`;
