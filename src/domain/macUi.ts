/**
 * Driving the desktop, for apps that have no API.
 *
 * The gap: asked to test something in a browser that held a live login, it
 * tried AppleScript, got AppleEvent `-1712`, and told the person to click an
 * "allow" dialog that was not on the screen. That diagnosis was wrong in a way
 * worth encoding - macOS has TWO separate permissions here and the bot holds
 * exactly one of them:
 *
 * - **Accessibility** - granted. The raw `AXUIElement` C API needs only this.
 * - **Automation / AppleEvents** - NOT granted. AppleScript and System Events
 *   need it, which is the entire source of `-1712`.
 *
 * So the helper reaches the AX API directly through JXA and never sends an
 * Apple Event. Measured on this host: `launchd -> bun -> osascript` reports
 * `AXIsProcessTrusted() = true`, because TCC attributes a child process to the
 * responsible parent and the parent holds the grant.
 *
 * It also sees MORE than AppleScript. Arc's "Little Arc" windows are invisible
 * to it - `count windows` said 1 where AX said 4 - so anything tab-based
 * silently misses them and reports success.
 *
 * `agent-desktop` (vercel-labs) sits beside it, not in place of it: same AX
 * grant, ref-based JSON snapshots, and it reads the other apps well - but it
 * refuses Arc outright ("Renderer did not enable accessibility activation",
 * vercel-labs/agent-desktop#465), and Arc is what this host mostly drives.
 */

const agentDesktopRules = (bin?: string): string =>
  bin
    ? `
- \`${bin}\` (agent-desktop) is the second driver, for every app EXCEPT Arc. It returns JSON with a ref per element: \`${bin} snapshot --app <app> -i --compact\`, then \`${bin} click @<ref>\` / \`type @<ref> <text>\` / \`press cmd+c\`, then snapshot again to check. Refs belong to their snapshot - on \`STALE_REF\` take a new one. For a dense app map it first with \`--skeleton\` and drill in with \`--root @<ref>\`. \`${bin} skills get desktop\` has its full rules
- Arc refuses agent-desktop ("Renderer did not enable accessibility activation", an open upstream bug). For Arc use the first helper, and do not retry agent-desktop there`
    : "";

export const macUiRules = (script?: string, agentDesktop?: string): string => {
  if (!script) return "";
  return `

Driving a desktop app (any Mac app, not just a browser):
- \`${script} apps\` - what is running
- \`${script} tree <app> [--depth N]\` - the live accessibility tree. START HERE: it tells you what is actually on screen and what the things are called
- \`${script} find <app> <text> [--role AXButton]\` / \`click\` / \`read\` / \`windows\` / \`close <app> <title>\` / \`type <app> <text>\` / \`key <app> return [--cmd]\` / \`menu <app> <item>\`
- it speaks the Accessibility API directly, which you HAVE. Do not reach for AppleScript or \`osascript -e 'tell application ...'\`: those need the Automation permission, which you do NOT have, and they fail with AppleEvent \`-1712\` after a long timeout. If you see -1712, you used the wrong tool - it is not a dialog waiting to be clicked
- Electron apps (Slack, VS Code, Arc, Discord, Postman) look like empty nested groups to every other tool. This one flips \`AXManualAccessibility\` first, so the real tree appears. The tree fills in asynchronously, so if it looks bare, ask again a second later
- a click on web content sometimes reports success and does nothing, because the page wants a real pointer event. \`--real\` forces one
- always \`tree\` or \`find\` before you \`click\`. Clicking by guessed name on somebody's actual desktop is how you press the wrong thing
- it drives the REAL screen the person is sitting at. Windows will move and things will be typed where they can see it. Use it for what was asked and nothing else, and say what you did${agentDesktopRules(agentDesktop)}`;
};
