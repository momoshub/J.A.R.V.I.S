/**
 * Command layer.
 *
 * A single registry of predefined commands, each invokable two ways:
 *   - Slack slash command:  `<slash> <name> <args...>`   (one registration, sub-routed)
 *   - Template message:      `<prefix> <name> <args...>`  (or the legacy `!<name>`)
 *
 * Both the message prefix and the slash name are configured at the edge (env);
 * nothing here hardcodes them beyond neutral fallbacks. Both interfaces resolve
 * to the same line via `commandLineOf` and run through `dispatchCommand`, which
 * enforces per-command role gates before touching repos or the brain.
 */
import {
  buildCommandMenu,
  MENU_SELECT_ACTION,
  menuPrompt,
  menuRunActionId,
} from "../domain/commandMenu.ts";
import { SIGNATURES } from "../domain/messageFooter.ts";
import { redactSecrets } from "../domain/toolVisibility.ts";
import { allowanceFor, holdForApproval, type CommandLimitDeps } from "./commandLimits.ts";
import { isTimeout } from "../domain/threadSession.ts";
import { asksForHelp, commandHelp } from "../domain/commandHelp.ts";
import { nearestCommand } from "../domain/commandSuggest.ts";
import type { AllowedUser, UserRole } from "../domain/types.ts";
import {
  type CommandDef,
  type CommandDeps,
  type CommandInfo,
  DEFAULT_COMMAND_PREFIX,
  DEFAULT_SLASH_COMMAND,
  LEADING_MENTION,
  PR_URL,
} from "./commands/shared.ts";
import { commandPerm, permissionCatalogue } from "../domain/permissions.ts";
import { can, roleNamesWith, type RoleBook } from "../domain/roles.ts";
import { seededBook } from "../domain/roleSeed.ts";
import { CHAT_COMMANDS } from "./commands/chat.ts";
import { SCHEDULE_COMMANDS } from "./commands/schedule.ts";
import { PEOPLE_COMMANDS } from "./commands/people.ts";
import { ADAPTER_COMMANDS } from "./commands/adapter.ts";
import { LEARNINGS_COMMANDS } from "./commands/learnings.ts";
import { ERRANDS_COMMANDS } from "./commands/errands.ts";
import { REVIEW_COMMANDS } from "./commands/review.ts";
import { RUNTIME_COMMANDS } from "./commands/runtime.ts";
import { SLACK_COMMANDS } from "./commands/slack.ts";
import { CLOUDWATCH_COMMANDS } from "./commands/cloudwatch.ts";
import { ROLE_COMMANDS } from "./commands/roles.ts";
export {
  DEFAULT_COMMAND_PREFIX,
  DEFAULT_SLASH_COMMAND,
  parseWindow,
  type CommandDeps,
  type CommandInfo,
} from "./commands/shared.ts";
import { logAndIgnore } from "./ignoredError.ts";

export const COMMANDS: readonly CommandDef[] = [
  {
    name: "help",
    trivial: true,
    // The brain runs this for ITSELF - it is told never to read its own source
    // to find out what it can do, so `help` is the answer. Nobody else wants
    // the whole command list dropped into their thread when it does. Quiet
    // sends the list back to the brain; a person typing it still gets the menu,
    // because `respond` wires a reply for a message command.
    quiet: true,
    // `menu` because that is the word people reach for once it IS one.
    aliases: ["commands", "menu", "?"],
    minRole: "pal",
    usage: "",
    summary: "list the commands you can run",
    run: async ({ deps, actor, channelId, threadTs, prefix, slash, reply }) => {
      // A menu where there is a Slack to put one in, the plain list everywhere
      // else - the dashboard, a test, a transport with no interactivity. The
      // list is still the fallback rather than an error, because help that
      // fails is worse than help that is merely old-fashioned.
      const book = bookOf(deps);
      const menu = buildCommandMenu(listCommandInfo(), (name) => mayRun(book, actor.role, name));
      const listed = renderHelp(book, actor.role, prefix, slash);
      // Only a person gets a menu. Without a reply wired this is the brain
      // asking itself what it can run, and a picker posted into the thread
      // would be the noise this command is quiet to avoid.
      if (reply && deps.slack && channelId && menu.groups.length > 0) {
        const posted = await deps.slack
          .postMenu(
            channelId,
            `${listed}\n\n${menuPrompt(menu)}`,
            {
              select: {
                actionId: MENU_SELECT_ACTION,
                placeholder: "Pick a command",
                groups: menu.groups,
              },
              actions: menu.quick.map((c) => ({
                actionId: menuRunActionId(c.name),
                label: c.name,
                value: c.name,
              })),
            },
            threadTs,
            SIGNATURES.command,
          )
          .catch(logAndIgnore("command reply post"));
        if (posted) return "";
      }
      return listed;
    },
  },
  ...CHAT_COMMANDS,
  ...SCHEDULE_COMMANDS,
  ...PEOPLE_COMMANDS,
  ...ROLE_COMMANDS,
  ...ADAPTER_COMMANDS,
  ...LEARNINGS_COMMANDS,
  ...ERRANDS_COMMANDS,
  ...REVIEW_COMMANDS,
  ...RUNTIME_COMMANDS,
  ...SLACK_COMMANDS,
  ...CLOUDWATCH_COMMANDS,
];

const byName = new Map<string, CommandDef>();
for (const c of COMMANDS) {
  byName.set(c.name, c);
  for (const a of c.aliases ?? []) byName.set(a, c);
}

/** The roles as stored, or the seeded defaults where nothing is wired. A command's `minRole` is only that seed. */
const DEFAULT_BOOK: RoleBook = seededBook({ commands: COMMANDS.map((c) => ({ name: c.name, minRole: c.minRole })) });
export const bookOf = (deps: { roles?: RoleBook }): RoleBook => deps.roles ?? DEFAULT_BOOK;

/** May this role run the command? Its grant decides; `help` is how anyone finds out what else they can do, so it is always open. */
export const mayRun = (book: RoleBook, role: UserRole, command: string): boolean =>
  command === "help" || can(book, role, commandPerm(command));

/** What this role may run: the commands it holds a grant for. */
const runnable = (book: RoleBook, role: UserRole) => (c: CommandDef): boolean => mayRun(book, role, c.name);

const renderHelp = (book: RoleBook, role: UserRole, prefix: string, slash: string): string => {
  const lines = COMMANDS.filter(runnable(book, role)).map(
    (c) => `- \`${c.name}${c.usage ? ` ${c.usage}` : ""}\` - ${c.summary}`,
  );
  return [
    "Commands - run either way:",
    `  slash: \`${slash} <command> <args>\`   message: \`${prefix} <command> <args>\``,
    "",
    ...lines,
  ].join("\n");
};

/**
 * Extract the command line from an inbound message, or undefined for plain chat.
 * Accepts the configured `prefix`, the legacy `!`, and tolerates a leading mention.
 */
export const commandLineOf = (text: string, prefix: string = DEFAULT_COMMAND_PREFIX): string | undefined => {
  const t = text.trim().replace(LEADING_MENTION, "").trim();
  const p = prefix.trim();
  const lower = t.toLowerCase();
  if (t === p || lower.startsWith(`${p.toLowerCase()} `)) return t.slice(p.length).trim();
  if (t.startsWith("!")) return t.slice(1).trim();
  return undefined;
};

/**
 * Whether a slash invocation of this line is worth copying to the owner.
 * Unknown commands count: a failed guess is still something worth seeing.
 */
/** Commands that cost nothing and so do not count against an allowance. */
export const TRIVIAL_COMMANDS: readonly string[] = COMMANDS.filter((c) => c.trivial).map((c) => c.name);

/** Whether this line runs a tool-like command: result to the caller, not the thread. */
export const isQuietCommand = (line: string): boolean => {
  const [first = "", ...args] = line.trim().split(/\s+/);
  const command = byName.get(first.toLowerCase());
  // A help card is a guide for whoever asked. When the brain asks, it reads it
  // for itself: a menu dropped into a conversation is noise nobody wanted.
  if (command && asksForHelp(args)) return true;
  const quiet = command?.quiet;
  return typeof quiet === "function" ? quiet(args) : quiet === true;
};

export const notifiesOwner = (line: string): boolean => {
  const name = (line.trim().split(/\s+/)[0] || "help").toLowerCase();
  return byName.get(name)?.trivial !== true;
};

/** Metadata for every command, ordered as declared - for the dashboard. */
export const listCommandInfo = (): CommandInfo[] =>
  COMMANDS.map((c) => ({
    name: c.name,
    aliases: [...(c.aliases ?? [])],
    minRole: c.minRole,
    usage: c.usage,
    summary: c.summary,
    destructive: c.destructive === true,
  }));

/** Who may run a command, as words for a refusal: the roles holding its grant. */
const holders = (book: RoleBook, command: string): string => roleNamesWith(book, commandPerm(command));

export type DispatchOptions = {
  prefix?: string;
  slash?: string;
  /** Thread the command came from; workflows are bound to one. */
  threadTs?: string;
  /** Already approved by someone with authority - skip the allowance check. */
  preApproved?: boolean;
  /** Destination sink for progress + direct results (thread or DM). */
  reply?: (text: string) => Promise<void>;
  /**
   * Set ONLY by the brain's run bridge (`/api/commands/run`, after it redeemed a
   * turn ticket). Commands that hand a credential to the brain (`worker-ticket`)
   * refuse without it, so a schedule, an errand, the command menu or a typed line
   * can never be the caller.
   */
  fromBrainRun?: boolean;
};

/** Run a command line (e.g. "add @U1 admin") on behalf of `actor`. */
export const dispatchCommand = async (
  deps: CommandDeps,
  actor: AllowedUser,
  channelId: string,
  line: string,
  opts: DispatchOptions = {},
): Promise<string> => {
  const prefix = opts.prefix ?? DEFAULT_COMMAND_PREFIX;
  const slash = opts.slash ?? DEFAULT_SLASH_COMMAND;
  const trimmed = line.trim();
  const name = (trimmed.split(/\s+/)[0] || "help").toLowerCase();
  const rest = trimmed.slice(name.length).trim();
  const args = rest.length ? rest.split(/\s+/) : [];

  const log = (command: string, ok: boolean, result: string) =>
    // A result may carry a credential the brain has to see (`worker-ticket`); the log never does.
    deps.commandLog?.add(
      { slackUserId: actor.slackId, command, args: rest, channelId, ok, result: redactSecrets(result) },
      deps.clock(),
    );

  const command = byName.get(name);
  if (!command) {
    // Name the near miss rather than sending someone to read forty lines to
    // find the word they almost typed. Only commands their role can actually
    // run, so a suggestion is never a door that turns out to be locked.
    const reachable = COMMANDS.filter(runnable(bookOf(deps), actor.role)).flatMap((c) => [
      c.name,
      ...(c.aliases ?? []),
    ]);
    const near = nearestCommand(name, reachable);
    // A quick review is somebody's direct ask, spelled out: a bare PR link or
    // the retired `review` / `approve` is not guessed into one.
    const msg = /^(review|approve)$/.test(name) || PR_URL.test(name) || /^[\w.-]+\/[\w.-]+#\d+$/.test(name)
      ? `I do not recognise \`${name}\`. For a quick review of a PR: \`${prefix} quick-review <pr-url>\`.`
      : near
      ? `I do not recognise \`${name}\`. Did you mean \`${prefix} ${near}\`? \`${prefix} help\` has the rest.`
      : `I do not recognise \`${name}\`. Try \`${prefix} help\`.`;
    log(name, false, msg);
    return msg;
  }
  // A quick review runs only when a person asks for it themselves. The brain's
  // run bridge is the one path where nobody typed the line: a turn the bot
  // started (a watch, `tell`, a workflow step, a worker's question) or a chat
  // turn deciding on its own must never start one.
  if (opts.fromBrainRun && command.name === "quick-review") {
    const msg = `\`quick-review\` runs only when a person asks for it: \`@bot review <pr-url>\` in Slack, or \`${prefix} quick-review <pr-url>\`. I do not start one myself.`;
    log(command.name, false, msg);
    return msg;
  }
  const book = bookOf(deps);
  // The grant is the gate: the roles are data, and a command's `minRole` is only where the grant started.
  if (!mayRun(book, actor.role, command.name)) {
    const msg = `That command needs *${holders(book, command.name)}* access. You are *${actor.role}*.`;
    log(command.name, false, msg);
    return msg;
  }
  // What it does, without doing it. `ticket help` used to spawn a full
  // host-login ticket run with "help" as the bug report and die at the timeout.
  if (!command.ownHelp && command.name !== "help" && asksForHelp(args)) {
    return commandHelp(
      {
        name: command.name,
        usage: command.usage,
        summary: command.summary,
        minRole: holders(book, command.name),
        aliases: command.aliases,
      },
      prefix,
    );
  }
  if (command.name !== "help" && deps.disabledCommands?.().has(command.name)) {
    const msg = `\`${command.name}\` is currently disabled.`;
    log(command.name, false, msg);
    return msg;
  }
  // A limited role that has run out is not turned away - the command is parked
  // and put to the owner. Trivial commands never count and are never held.
  if (!command.trivial && !opts.preApproved) {
    const allowance = allowanceFor(deps as CommandLimitDeps, actor, TRIVIAL_COMMANDS);
    if (allowance.limited) {
      const msg = await holdForApproval(
        deps as CommandLimitDeps,
        actor,
        trimmed,
        channelId,
        opts.threadTs,
        allowance,
      );
      log(command.name, false, msg);
      return msg;
    }
  }
  try {
    const result = await command.run({
      deps,
      actor,
      channelId,
      threadTs: opts.threadTs,
      args,
      rest,
      prefix,
      slash,
      reply: opts.reply,
      fromBrainRun: opts.fromBrainRun === true,
      trivialCommands: TRIVIAL_COMMANDS,
      roles: book,
      catalogue: deps.roleCatalogue?.() ?? permissionCatalogue({ commands: listCommandInfo(), mcpServers: ["notion", "datadog"] }),
      can: (permission) => can(book, actor.role, permission),
    });
    log(command.name, true, result);
    return result;
  } catch (e) {
    // A killed run is out of TIME, not broken. "That command failed: claude CLI
    // exited with code 143: no output" reads as a bug and invites the same
    // expensive thing again; saying it ran long invites a narrower one.
    const msg = isTimeout(e)
      ? `\`${command.name}\` ran past its time limit and I killed it, so nothing came back. Narrow it down and try again.`
      : `That command failed: ${e instanceof Error ? e.message : String(e)}`;
    log(command.name, false, msg);
    return msg;
  }
};
