/**
 * `help` as a menu you click, not a list you retype.
 *
 * The old help was forty lines of `- \`name <args>\` - summary`, and every one
 * of them ended the same way: read it, scroll back, retype the command with the
 * prefix, get the argument shape slightly wrong. On a phone that is genuinely
 * unpleasant. The commands were always discoverable and never convenient.
 *
 * So the same registry renders as a picker. Choosing a command that needs no
 * arguments runs it; choosing one that does opens a box with its usage on the
 * label, which is also the only place the argument shape is ever shown at the
 * moment it is needed rather than a screen earlier.
 *
 * Pure: this decides WHAT the menu contains. The Slack block JSON that carries
 * it is `infrastructure/slack/adminClient.ts`, like every other block the bot
 * posts.
 */
import type { UserRole } from "./types.ts";

export const MENU_SELECT_ACTION = "command_menu_select";
export const MENU_RUN_ACTION = "command_menu_run";

/**
 * Every button in one Slack block must carry a DISTINCT `action_id` - a row of
 * buttons sharing one is rejected outright with `invalid_blocks`, which is the
 * sort of thing that only shows up the first time somebody presses the menu.
 * So the command name goes in the id as well as the value, and the handler
 * matches on the prefix.
 */
export const menuRunActionId = (command: string): string => `${MENU_RUN_ACTION}:${command}`;
export const MENU_RUN_PATTERN = /^command_menu_run:/;
export const MENU_VIEW = "command_menu_view";
export const MENU_BLOCK = "command_menu_args";
export const MENU_INPUT = "command_menu_input";

/** Slack truncates these itself, and badly; do it here where it can be tidy. */
const OPTION_TEXT_MAX = 75;
/** Slack's own ceiling on a select. The registry is nowhere near it, but a
 *  menu that silently drops its tail would be worse than one that says so. */
export const MENU_OPTION_MAX = 100;
/** Buttons worth having at a glance; more than this is a wall again. */
export const QUICK_MAX = 5;

/** What the menu needs to know about a command. */
export type MenuCommand = {
  readonly name: string;
  readonly minRole: UserRole;
  readonly usage: string;
  readonly summary: string;
  /** Destroys something: never a one-tap button, and confirmed before it runs. */
  readonly destructive?: boolean;
};

export type MenuOption = {
  readonly label: string;
  readonly value: string;
  readonly description?: string;
};

export type MenuGroup = {
  readonly label: string;
  readonly options: readonly MenuOption[];
};

export type CommandMenu = {
  readonly groups: readonly MenuGroup[];
  /** Zero-argument commands worth a single click. */
  readonly quick: readonly MenuCommand[];
  /** Commands left out because the select was full. */
  readonly omitted: number;
};

const RANK: Record<UserRole, number> = { pal: 0, executer: 1, admin: 2, owner: 3 };
const GROUP_LABEL: Record<UserRole, string> = {
  pal: "Anyone",
  executer: "Executers",
  admin: "Admins",
  owner: "Owner",
};

export const clip = (text: string, max = OPTION_TEXT_MAX): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/**
 * Does this command need arguments before it can run?
 *
 * `usage` is the contract: `<x>` is required, `[x]` is optional. So a usage of
 * `[role|here] [name]` runs fine with none, and `<fact>` does not. Getting this
 * wrong in the permissive direction means a click that posts a usage error; in
 * the strict direction it means an pointless empty box. The former is cheaper,
 * so anything ambiguous asks.
 */
export const needsArguments = (usage: string): boolean => {
  // Innermost-first, repeatedly: optional groups nest, and a single pass on
  // `[a|b [c]|d <e>]` leaves the tail behind and makes a command that runs
  // perfectly well with no arguments demand some.
  let required = usage;
  for (let prev = ""; required !== prev; ) {
    prev = required;
    required = required.replace(/\[[^[\]]*\]/g, "");
  }
  return /<[^>]+>/.test(required) || /\S/.test(required.replace(/[|\s]/g, ""));
};

/** The menu one role sees, newest-first by nothing - registry order is meaningful. */
export const buildCommandMenu = (
  commands: readonly MenuCommand[],
  role: UserRole,
  /** Never offered as a menu entry: it is the thing that opened the menu. */
  exclude: readonly string[] = ["help"],
): CommandMenu => {
  const available = commands.filter((c) => RANK[role] >= RANK[c.minRole] && !exclude.includes(c.name));

  const groups: MenuGroup[] = [];
  let used = 0;
  let omitted = 0;
  for (const tier of ["pal", "executer", "admin", "owner"] as const) {
    const inTier = available.filter((c) => c.minRole === tier);
    if (inTier.length === 0) continue;
    const room = Math.max(0, MENU_OPTION_MAX - used);
    const taken = inTier.slice(0, room);
    omitted += inTier.length - taken.length;
    if (taken.length === 0) continue;
    used += taken.length;
    groups.push({
      label: GROUP_LABEL[tier],
      options: taken.map((c) => ({
        label: clip(c.usage ? `${c.name} ${c.usage}` : c.name),
        value: c.name,
        description: clip(c.summary),
      })),
    });
  }

  return {
    groups,
    // A button is one stray tap. `forget` wipes a channel's stored turns, and
    // the difference between meaning to and brushing the screen is nothing at
    // all - so destructive commands stay in the picker, where they are
    // confirmed, and never become buttons.
    quick: available.filter((c) => !needsArguments(c.usage) && !c.destructive).slice(0, QUICK_MAX),
    omitted,
  };
};

/** Where a menu press should send its answer, carried on the button/modal. */
export type MenuRequest = {
  readonly channelId: string;
  readonly threadTs?: string;
  /** The command a modal is collecting arguments for. */
  readonly command?: string;
};

export const encodeMenuRequest = (req: MenuRequest): string => JSON.stringify(req);

export const decodeMenuRequest = (raw: string | undefined): MenuRequest | undefined => {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    const { channelId, threadTs, command } = parsed as Record<string, unknown>;
    if (typeof channelId !== "string" || !channelId) return undefined;
    return {
      channelId,
      threadTs: typeof threadTs === "string" && threadTs ? threadTs : undefined,
      command: typeof command === "string" && command ? command : undefined,
    };
  } catch {
    return undefined;
  }
};

/** The line that introduces the menu. */
export const menuIntro = (prefix: string, slash: string, menu: CommandMenu): string =>
  [
    "*What would you like me to do?*",
    `Pick one below, or type it: \`${prefix} <command>\` / \`${slash} <command>\`.`,
    menu.omitted > 0 ? `_${menu.omitted} more are available by typing._` : "",
  ]
    .filter(Boolean)
    .join("\n");
