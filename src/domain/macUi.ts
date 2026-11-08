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
 * `agent-desktop` (vercel-labs) sits beside it: same AX grant, ref-based JSON
 * snapshots. It refused Arc outright (vercel-labs/agent-desktop#465), so the
 * host browser moved to Brave, which it reads fine. mac-ui.js stays as the
 * fallback for whatever agent-desktop cannot open.
 *
 * Both run through `bin/desktop.ts` when it is wired: one screen, one session
 * at a time (see `desktopLock.ts`).
 */

const agentDesktopRules = (bin?: string, desktop?: string): string => {
  if (!bin) return "";
  const ad = desktop ? `${desktop} agent-desktop` : bin;
  return `
- \`${ad}\` (agent-desktop) is the FIRST driver to reach for, the browser included. The browser on this Mac is *Brave Browser* - not Arc, do not open Arc. It returns JSON with a ref per element: \`${ad} snapshot --app <app> -i --compact\`, then \`${ad} click @<ref>\` / \`type @<ref> <text>\` / \`press cmd+c\`, then snapshot again to check. Refs belong to their snapshot - on \`STALE_REF\` take a new one. For a dense app map it first with \`--skeleton\` and drill in with \`--root @<ref>\`. \`${ad} skills get desktop\` has its full rules
- fall back to \`mac-ui.js\` above only when agent-desktop refuses an app. A web field that ignores \`type\`, or a control with no ref, is not a refusal: retry with \`--headed\` (real keystrokes and clicks) or \`--interval-ms\` first, and never mix in the \`keys.js\` helper`;
};

/**
 * One screen, one driver: every session's clicks go through the lock wrapper
 * (`domain/desktopLock.ts`), and a refused one waits instead of opening
 * another window - which is exactly what made two sessions collide.
 */
const desktopLockRules = (desktop?: string): string =>
  desktop
    ? `
- ONE session drives the screen at a time. Run both drivers only through \`${desktop}\` as shown, never by their own paths: it holds a desktop-wide lock for your session while you click and type. Reading (tree, find, snapshot, screenshot) needs no lock
- if it exits 75 with "desktop busy", another thread is on the screen. Do NOT open another window, a new Brave window steals focus and its clicks land in yours. Tell the person it is busy, and set a watch on \`${desktop} free\` to carry on when it is yours
- when you are done with the screen, run \`${desktop} release\`. An idle lock lapses by itself after 5 minutes`
    : "";

export const macUiRules = (script?: string, agentDesktop?: string, desktop?: string): string => {
  if (!script) return "";
  const ui = desktop ? `${desktop} mac-ui` : script;
  return `

Driving a desktop app (any Mac app, not just a browser):
- \`${ui} apps\` - what is running
- \`${ui} tree <app> [--depth N]\` - the live accessibility tree. START HERE: it tells you what is actually on screen and what the things are called
- \`${ui} find <app> <text> [--role AXButton]\` / \`click\` / \`read\` / \`windows\` / \`close <app> <title>\` / \`type <app> <text>\` / \`key <app> return [--cmd]\` / \`menu <app> <item>\` / \`release-keys\` (lets go of a stuck modifier; every action through the wrapper ends with it)
- it speaks the Accessibility API directly, which you HAVE. Do not reach for AppleScript or \`osascript -e 'tell application ...'\`: those need the Automation permission, which you do NOT have, and they fail with AppleEvent \`-1712\` after a long timeout. If you see -1712, you used the wrong tool - it is not a dialog waiting to be clicked
- Electron apps (Slack, VS Code, Brave, Discord, Postman) look like empty nested groups to every other tool. This one flips \`AXManualAccessibility\` first, so the real tree appears. The tree fills in asynchronously, so if it looks bare, ask again a second later
- a click on web content sometimes reports success and does nothing, because the page wants a real pointer event. \`--real\` forces one
- always \`tree\` or \`find\` before you \`click\`. Clicking by guessed name on somebody's actual desktop is how you press the wrong thing
- it drives the REAL screen the person is sitting at. Windows will move and things will be typed where they can see it. Use it for what was asked and nothing else, and say what you did${agentDesktopRules(agentDesktop, desktop)}${desktopLockRules(desktop)}`;
};
