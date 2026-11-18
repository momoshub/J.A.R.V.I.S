/** `mcp-tools`: the owner approves the MCP tools a server started listing after its first run. See domain/mcpApproval.ts. */
import { type CommandDef } from "./shared.ts";

export const MCP_TOOLS_COMMANDS: readonly CommandDef[] = [
  {
    name: "mcp-tools",
    // What a turn may call is the owner's call, like `slack-methods`.
    minRole: "owner",
    ownHelp: true,
    usage: "pending | list <server> | approve <server> <tool> | deny <server> <tool> | help",
    summary: "approve or deny the new tools MCP servers start listing; owner only",
    run: async ({ deps, args, prefix, fromBrainRun }) => {
      const usage = `\`${prefix} mcp-tools pending | list <server> | approve <server> <tool> | deny <server> <tool>\``;
      const help = `${usage}
Discovery is not exposure: a server's first run takes the tools it lists as its baseline, and a tool it lists later stays hidden from every turn, and refused if called, until you approve it.
- \`pending\` - every tool waiting for you, by server.
- \`list <server>\` - what is approved, denied and waiting for that server.
- \`approve <server> <tool>\` - expose the tool from the next turn on. \`deny <server> <tool>\` - hide it again (also revokes an approved one) and stop listing it as pending.
- A tool a server drops just disappears; a changed description or schema needs no new approval.
- Only a line you type approves or denies: when I run commands for a turn they are refused, so a prompt-injected turn cannot expose a tool to itself.
- Servers and their tools come from the schema cache, so a tool shows up here after a turn has called its server.`;
      const first = (args[0] ?? "pending").toLowerCase();
      if (first === "help" || first === "?") return help;
      const port = deps.mcpTools;
      if (!port) return "MCP tool approvals are not available on this host.";
      const code = (names: readonly string[]): string => (names.length ? names.map((n) => `\`${n}\``).join(", ") : "none");

      if (first === "pending") {
        const lines = port
          .servers()
          .map((s) => port.status(s))
          .filter((s) => s.pending.length > 0)
          .map((s) => `- *${s.server}*: ${code(s.pending)} - \`${prefix} mcp-tools approve ${s.server} <tool>\``);
        return lines.length ? `New MCP tools waiting for you:\n${lines.join("\n")}` : "No MCP tool is waiting for approval.";
      }

      const server = args[1] ?? "";
      if (first === "list") {
        if (!server) return `Name the server: ${usage}`;
        if (!port.servers().includes(server)) return `I know no MCP server \`${server}\`. Known: ${code(port.servers())}.`;
        const s = port.status(server);
        return `*${server}*${s.baselined ? "" : " (not run yet: its tools become the baseline on the first run)"}\nApproved: ${code(s.approved)}\nWaiting: ${code(s.pending)}\nDenied: ${code(s.denied)}`;
      }

      if (first === "approve" || first === "deny") {
        // A turn reads untrusted text and runs commands as whoever it serves, owner included: let it approve and the gate is advisory.
        if (fromBrainRun) {
          return `I do not ${first} MCP tools myself: a turn that reads untrusted text must not decide what it may call. Type the \`${prefix} mcp-tools ${first}\` line yourself.`;
        }
        const tool = args[2] ?? "";
        if (!server || !tool) return `Name the server and the tool: ${usage}`;
        const refused = first === "approve" ? port.approve(server, tool) : port.deny(server, tool);
        if (refused) return `Not changed: ${refused}.`;
        return first === "approve"
          ? `Approved \`${tool}\` of \`${server}\`: turns see it from their next start.`
          : `Denied \`${tool}\` of \`${server}\`: hidden and refused, and no longer listed as pending.`;
      }
      return `I do not know \`${first}\`. ${usage}`;
    },
  },
];
