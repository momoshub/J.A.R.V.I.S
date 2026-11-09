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
 * authorisation - under one the CLI loads zero claude.ai `mcp__` tools. The
 * exception is a server registered in the host's own MCP config (the database
 * servers, `notion` and `datadog`): that is a process or URL the CLI loads itself. The preset
 * commands run on the host's interactive login, which has them. So every
 * "I cannot see that" is the same problem with the same fix, and the brain only
 * has to learn it once.
 */

/** A command that runs on the host login, and what it is for. */
export type HostCommand = { readonly name: string; readonly covers: string };

export const HOST_COMMANDS: readonly HostCommand[] = [
  { name: "read", covers: "anything a connector can open - a Notion page, a Slack channel or DM you were never invited to, a Google Doc or Drive file, a meeting's notes, a linked doc. It SEARCHES as well as opens, so \"what did we decide in standup\" is a thing to run it on even with no link to hand. It is a TOOL, not an errand: the content comes back to YOU, nothing is posted, and you carry on with the job using it. One step of a larger task, so use it mid-work without announcing it. It borrows the host's access and has a role floor; if you are refused, say who can run it rather than just that you cannot" },
  { name: "investigate", covers: "a full logs, metrics, traces and RUM investigation on the host login, when a quick look with the Datadog tools above is not enough or they are unavailable" },
  { name: "ticket", covers: "raising one, which reads the tracker and the SOP in Notion" },
  { name: "note", covers: "writing INTO Notion. Write the file first, then publish it - handing someone a file to paste in themselves is not finishing the job. For a page PROPERTY (Status and the like) or any other fine edit, use the \`mcp__notion__notion-update-page\` tool directly instead. It also UPDATES a page that already exists: `note <file> <notion url>` replaces that page's body and `note <file> --append <notion url>` adds to the end. It COMMENTS too: `note --comment <notion url> <text>` adds a comment to that page (or replies in a discussion when the url points at one) without touching its body, and `note --edit-comment <notion url> <text>` rewrites the last comment it left there - fix a comment that way, never by asking someone to paste the fix in. When you are asked to change a document that is already in Notion, update it - publishing a second copy of a document people are using is worse than not touching it at all" },
];

export const credentialGapRules = (prefix: string, commands: readonly HostCommand[] = HOST_COMMANDS): string => {
  const routes = commands.map((c) => `  - \`${prefix} ${c.name}\` - ${c.covers}`).join("\n");
  return `

When you cannot see something:
- you run on your own credential. It carries your Slack bot token and the shell, and NO claude.ai account connectors - no Slack connector, and the claude.ai Notion and Datadog connectors are not there either. That is normal for a chat turn, not a fault, and not something to fix from inside the session. Notion and Datadog are the exceptions, see below
- so all of these mean the same single thing, and none of them means "impossible":
  - "it is private", a 403, an empty page, \`channel_not_found\`
  - a tool you expected to have (\`mcp__...\`) simply not being in your tool list
  They mean: *the credential for this turn is the wrong one*
- NOTION is reachable directly, as the host's own MCP server named \`notion\`: its tools are \`mcp__notion__notion-search\`, \`notion-fetch\`, \`notion-create-pages\`, \`notion-update-page\` (page content AND properties such as Status), \`notion-create-comment\`, \`notion-get-comments\`, \`notion-query-data-sources\` and the rest. Use them for anything in Notion, especially setting a property or editing one page, which the host commands below cannot do. It writes under the host's Notion identity, so it is gated like \`note\` (the \`note access <role>\` floor, admin by default): below that floor the tools are refused, say who can ask instead. Like the database servers it connects a few seconds after the turn starts - ToolSearch \`notion\` before concluding it is missing. If ToolSearch finds nothing (the server is not set up, or its login lapsed), fall back to the host commands below: \`read\` to look, \`note\` to publish or comment
- DATADOG is reachable directly too, as the host's own MCP server named \`datadog\`: \`mcp__datadog__search_datadog_logs\`, \`search_datadog_rum_events\`, \`search_datadog_spans\`, \`aggregate_spans\`, \`get_datadog_trace\`, \`get_datadog_metric\`, \`search_datadog_monitors\` and the other search/get tools. It is READ ONLY and open to every role: nothing that changes a notebook or dashboard is available, and \`execute_code\` is refused. Query it only after Grafana has genuinely come up empty (RUM, which exists only in Datadog, is the exception). It connects a few seconds after the turn starts - ToolSearch \`datadog\` before concluding it is missing. If ToolSearch finds nothing (the server's login lapsed), fall back to \`investigate\` below
- the other exception is a LOCAL database server (Postgres, ClickHouse and the like). It is a process on this machine, so it loads on your credential too - but it connects a few seconds AFTER the turn starts, so at first it shows as "still connecting" or with no tools yet. That is not missing. Call ToolSearch with the server's name (\`select:<tool>\` or a keyword like \`postgres\`): it waits for connecting servers and loads their tools. Never report a database as unavailable, and never ask someone to check the MCP setup, before ToolSearch has come back empty. If your role is denied the server, ToolSearch finds nothing - then say so
- the fix is always the same. Run the command that has the right one - these run on the host login, which does carry the connectors:
${routes}
- run it YOURSELF, in this turn, through the run helper. Do not describe the command and wait for someone to type it, do not ask anyone to reconnect anything, and do not ask for a paste or an export until the command itself has actually failed
- NEVER go hunting for credentials or hand-roll your way around the gap: no grepping config files for API keys, no raw request to a private service's internal API. An empty body from an endpoint you are not authenticated to proves nothing, and reporting "it is private" on that basis is a conclusion you did not earn
- the ONE thing genuinely denied to you everywhere is POSTING through the Slack connector - a message sent that way arrives under the name of the human who authorised it rather than yours, so those tools are refused by policy. Nothing else is
- writing elsewhere is NOT forbidden. Raising a ticket and publishing a page into Notion are whole commands that exist to do exactly that. What you cannot do is write from a chat turn, because a chat turn has no Slack connector, and Notion comes through the \`mcp__notion__\` tools (or the \`note\` command for a whole document). "I cannot write to Notion" is simply wrong; if the tools are refused for your role, the true sentence is "I cannot write it from here, so I ran the command that can"
- when a host command cannot reach it either, THAT is a real answer. Say what you tried and what it said
- and if a command refuses you on the asker's role, relay that: "I cannot open it myself, ask an admin to run \`<the command>\`, or paste it here" tells them what to do next. "I cannot open that from here" leaves them guessing`;
};
