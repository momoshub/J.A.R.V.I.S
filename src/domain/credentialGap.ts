/**
 * What this turn can reach, and what to do when it cannot reach something.
 *
 * One rule, because the same failure arrived three times wearing different
 * clothes: Datadog RUM ("the connector isn't loaded"), a Slack group DM
 * ("channel_not_found"), a Notion page ("none of my commands can read Notion").
 * Each time the capability existed on a host-login command, each time the chat
 * brain could not see a route, and each time the answer was a new paragraph
 * describing that one case. Three nearly-identical rules in three files is how
 * the fourth case gets missed too.
 *
 * The underlying fact is single and worth stating once: a chat turn runs on a
 * `claude setup-token` credential, which carries NO claude.ai connector
 * authorisation - under one the CLI loads zero `mcp__` tools. The preset
 * commands run on the host's interactive login, which has them. So every
 * "I cannot see that" is the same problem with the same fix, and the brain only
 * has to learn it once.
 */

/** A command that runs on the host login, and what it is for. */
export type HostCommand = { readonly name: string; readonly covers: string };

export const HOST_COMMANDS: readonly HostCommand[] = [
  { name: "read", covers: "anything a connector can open - a Notion page, a Slack channel or DM you were never invited to, a linked doc. It is a TOOL, not an errand: the content comes back to YOU, nothing is posted, and you carry on with the job using it. One step of a larger task, so use it mid-work without announcing it. It borrows the host's access and has a role floor; if you are refused, say who can run it rather than just that you cannot" },
  { name: "investigate", covers: "logs, metrics, traces, and RUM, which exists only in Datadog" },
  { name: "ticket", covers: "raising one, which reads the tracker and the SOP in Notion" },
  { name: "note", covers: "publishing a document you have written INTO Notion. Write the file first, then publish it - handing someone a file to paste in themselves is not finishing the job" },
];

export const credentialGapRules = (prefix: string, commands: readonly HostCommand[] = HOST_COMMANDS): string => {
  const routes = commands.map((c) => `  - \`${prefix} ${c.name}\` - ${c.covers}`).join("\n");
  return `

When you cannot see something:
- you run on your own credential. It carries your Slack bot token and the shell, and NO account connectors at all - no Notion, no Datadog, no Slack connector. That is normal for a chat turn, not a fault, and not something to fix from inside the session
- so all of these mean the same single thing, and none of them means "impossible":
  - "it is private", a 403, an empty page, \`channel_not_found\`
  - a tool you expected to have (\`mcp__...\`) simply not being in your tool list
  They mean: *the credential for this turn is the wrong one*
- the fix is always the same. Run the command that has the right one - these run on the host login, which does carry the connectors:
${routes}
- run it YOURSELF, in this turn, through the run helper. Do not describe the command and wait for someone to type it, do not ask anyone to reconnect anything, and do not ask for a paste or an export until the command itself has actually failed
- NEVER go hunting for credentials or hand-roll your way around the gap: no grepping config files for API keys, no raw request to a private service's internal API. An empty body from an endpoint you are not authenticated to proves nothing, and reporting "it is private" on that basis is a conclusion you did not earn
- the ONE thing genuinely denied to you everywhere is POSTING through the Slack connector - a message sent that way arrives under the name of the human who authorised it rather than yours, so those tools are refused by policy. Nothing else is
- writing elsewhere is NOT forbidden. Raising a ticket and publishing a page into Notion are whole commands that exist to do exactly that. What you cannot do is write from a chat turn, because a chat turn has no connectors at all - so run the command that has them. "I cannot write to Notion" is simply wrong; the true sentence is "I cannot write it from here, so I ran the command that can"
- when a host command cannot reach it either, THAT is a real answer. Say what you tried and what it said
- and if a command refuses you on the asker's role, relay that: "I cannot open it myself, ask an admin to run \`<the command>\`, or paste it here" tells them what to do next. "I cannot open that from here" leaves them guessing`;
};
