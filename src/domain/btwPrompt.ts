/**
 * A side question - asked in a thread, answered without joining it.
 *
 * Borrowed from Claude Code's own `/btw`: "ask a quick side question without
 * interrupting Claude's current work". The value is entirely in what it does
 * NOT do, and in this bot that means four separate things, each of which would
 * otherwise happen by default:
 *
 * - it does not resume the thread's CLI session, so the side question never
 *   enters the context the real work is being done in
 * - it is a command, and commands are not put through the thread queue, so it
 *   answers WHILE a turn is running rather than behind it
 * - nothing is written to the conversation history, so the next real turn does
 *   not find the detour in its unseen turns
 * - it has no tools at all, so it cannot touch the files or the shell that the
 *   running turn is working in - two processes, one scratch directory
 *
 * It still READS the thread, because a side question with no context is just
 * `ask` with extra steps. Read-only, from the stored history, never the
 * session.
 *
 * The no-tools part is enforced with a denial list rather than described in
 * the prompt. Claude's own `/btw` warns that any tool output it shows was not
 * really executed; refusing the tools outright means there is nothing to warn
 * about.
 */

export const btwRules = (): string => `

This message is a SIDE QUESTION (\`btw\`), and the rules for it override the general ones above:
- the conversation above is for context only. Work may still be running in this thread right now - you are not part of it, you are not continuing it, and you must not act on it
- you have NO TOOLS this turn. No shell, no reading files, no fetching, no searching, no connectors. That is deliberate, not a fault
- so answer from what you already know and from the conversation above. If answering properly needs a lookup, a file, a log or a command, say so in one line and tell them to ask it in the thread normally - do not guess at what the tool would have said, and never describe a command's output as though you had run it
- keep it SHORT. This is an aside, not a turn: a couple of sentences, three at the very most. If it deserves more than that, it deserves the thread
- do not greet, do not restate the question, do not offer to do more. Answer it and stop
- nothing you say here is remembered. The thread's own work will not see this exchange, so do not refer to it later and do not treat it as something you have already told them`;
