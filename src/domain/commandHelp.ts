/**
 * `<command> help` - what one command is, without running it.
 *
 * Someone wanting to know what `ticket` does types `ticket help`, which is the
 * obvious thing to type and, until now, the expensive thing to type: `help` was
 * just an argument, so the command spawned a full host-login ticket run with
 * "help" as the bug report. It ran for the better part of an hour and died at
 * the timeout having posted nothing - the single worst entry in the command log.
 *
 * `review` had already been given this exact guard after `review help` reviewed
 * a PR named "help" on the caller's own credential. A fix written for one
 * command is a fix nobody else gets, so it lives here now and every command has
 * it. The ones that answer `help` better themselves opt out.
 */

/** The words people actually type when they want to know what something does. */
const HELP_WORDS = new Set(["help", "?", "--help", "-h", "usage", "how"]);

/** Is this argument list a request to EXPLAIN the command rather than run it? */
export const asksForHelp = (args: readonly string[]): boolean =>
  args.length === 1 && HELP_WORDS.has((args[0] ?? "").toLowerCase());

export type HelpSubject = {
  readonly name: string;
  readonly usage: string;
  readonly summary: string;
  readonly minRole: string;
  readonly aliases?: readonly string[];
};

/** The card: how to type it, what it does, who may, and what else it is called. */
export const commandHelp = (c: HelpSubject, prefix: string): string => {
  const lines = [
    `\`${prefix} ${c.name}${c.usage ? ` ${c.usage}` : ""}\``,
    c.summary,
    `needs *${c.minRole}* access`,
  ];
  if (c.aliases && c.aliases.length > 0) {
    lines.push(`also: ${c.aliases.map((a) => `\`${a}\``).join(", ")}`);
  }
  lines.push(`\`${prefix} help\` for everything else`);
  return lines.join("\n");
};
