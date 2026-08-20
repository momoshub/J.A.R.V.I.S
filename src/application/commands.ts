/**
 * Admin command layer.
 *
 * Parsing is pure (`parseCommand`); execution (`executeCommand`) applies the
 * access rules from the domain and touches the repos. The bot treats a message as a
 * command only when it starts with `!` so normal chat is never swallowed.
 */
import {
  canManageUsers,
  validateRemoval,
  validateRoleChange,
} from "../domain/access.ts";
import type { AllowedUser, UserRole } from "../domain/types.ts";
import type { Clock } from "./ports.ts";
import type { MessageRepo } from "../infrastructure/db/messageRepo.ts";
import type { UserRepo } from "../infrastructure/db/userRepo.ts";

export type Command =
  | { kind: "help" }
  | { kind: "whoami" }
  | { kind: "listUsers" }
  | { kind: "addUser"; slackId: string; role: UserRole }
  | { kind: "removeUser"; slackId: string }
  | { kind: "setRole"; slackId: string; role: UserRole }
  | { kind: "forget" }
  | { kind: "unknown"; input: string };

const MENTION = /<@([A-Z0-9]+)(?:\|[^>]+)?>/;

const extractSlackId = (token?: string): string | undefined => {
  if (!token) return undefined;
  const m = token.match(MENTION);
  if (m?.[1]) return m[1];
  return /^[UW][A-Z0-9]+$/.test(token) ? token : undefined;
};

const asRole = (token?: string): UserRole | undefined =>
  token === "owner" || token === "admin" || token === "member" ? token : undefined;

/** Returns a Command when `text` is a `!command`, otherwise undefined (plain chat). */
export const parseCommand = (text: string): Command | undefined => {
  const trimmed = text.trim();
  if (!trimmed.startsWith("!")) return undefined;

  const parts = trimmed.slice(1).trim().split(/\s+/);
  const [verb, ...rest] = parts;
  const lower = (verb ?? "").toLowerCase();

  switch (lower) {
    case "help":
    case "":
      return { kind: "help" };
    case "whoami":
      return { kind: "whoami" };
    case "users":
    case "list":
      return { kind: "listUsers" };
    case "forget":
      return { kind: "forget" };
    case "add": {
      const slackId = extractSlackId(rest[0]);
      if (!slackId) return { kind: "unknown", input: trimmed };
      const role = asRole(rest[1]?.toLowerCase()) ?? "member";
      return { kind: "addUser", slackId, role };
    }
    case "remove":
    case "kick": {
      const slackId = extractSlackId(rest[0]);
      if (!slackId) return { kind: "unknown", input: trimmed };
      return { kind: "removeUser", slackId };
    }
    case "promote":
    case "demote": {
      const slackId = extractSlackId(rest[0]);
      if (!slackId) return { kind: "unknown", input: trimmed };
      const role: UserRole = lower === "promote" ? "admin" : "member";
      return { kind: "setRole", slackId, role };
    }
    default:
      return { kind: "unknown", input: trimmed };
  }
};

export type CommandDeps = {
  users: UserRepo;
  messages: MessageRepo;
  clock: Clock;
  ownerSlackId: string;
};

const HELP = [
  "Command deck (prefix everything with `!`):",
  "- `!help` - this",
  "- `!whoami` - your role",
  "- `!users` - list who I answer to (admins)",
  "- `!add @user [admin|member]` - grant access (admins; admin role is owner-only)",
  "- `!remove @user` - revoke access (admins)",
  "- `!promote @user` / `!demote @user` - change role (owner)",
  "- `!forget` - wipe my memory of this channel",
].join("\n");

/** Execute a parsed command on behalf of `actor`. Returns the bot's reply text. */
export const executeCommand = (
  deps: CommandDeps,
  actor: AllowedUser,
  command: Command,
  channelId: string,
): string => {
  switch (command.kind) {
    case "help":
      return HELP;

    case "whoami":
      return `You are <@${actor.slackId}>, role: *${actor.role}*.`;

    case "listUsers": {
      if (!canManageUsers(actor.role)) return "Only admins can see the guest list.";
      const users = deps.users.list();
      if (users.length === 0) return "Nobody on the list yet, oddly enough.";
      return users
        .map((u) => `- <@${u.slackId}> - *${u.role}*${u.displayName ? ` (${u.displayName})` : ""}`)
        .join("\n");
    }

    case "addUser": {
      const target = deps.users.get(command.slackId);
      const currentRole: UserRole = target?.role ?? "member";
      const err = validateRoleChange(
        actor.role,
        currentRole,
        command.role,
        command.slackId === deps.ownerSlackId,
      );
      if (err) return err;
      deps.users.upsert({
        slackId: command.slackId,
        role: command.role,
        displayName: target?.displayName ?? "",
        addedBy: actor.slackId,
        createdAt: target?.createdAt ?? deps.clock(),
      });
      return `Done. <@${command.slackId}> is now *${command.role}*.`;
    }

    case "setRole": {
      const target = deps.users.get(command.slackId);
      if (!target) return "I do not know that user - add them first.";
      const err = validateRoleChange(
        actor.role,
        target.role,
        command.role,
        command.slackId === deps.ownerSlackId,
      );
      if (err) return err;
      deps.users.setRole(command.slackId, command.role);
      return `<@${command.slackId}> is now *${command.role}*.`;
    }

    case "removeUser": {
      const target = deps.users.get(command.slackId);
      if (!target) return "They are not on the list to begin with.";
      const err = validateRemoval(
        actor.role,
        target.role,
        command.slackId === deps.ownerSlackId,
      );
      if (err) return err;
      deps.users.remove(command.slackId);
      return `Access revoked for <@${command.slackId}>.`;
    }

    case "forget": {
      const removed = deps.messages.clearChannel(channelId);
      return removed > 0
        ? `Forgotten. Wiped ${removed} turns from this channel.`
        : "Nothing to forget here.";
    }

    case "unknown":
      return `I do not recognise that command. Try \`!help\`.`;
  }
};
