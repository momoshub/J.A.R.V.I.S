/**
 * Dashboard use cases.
 *
 * Everything the control deck reads or changes, as plain functions over narrow
 * ports. No HTTP in here: `infrastructure/dashboard/server.ts` parses the
 * request, calls one of these and turns the outcome into a response. Inputs
 * arrive as `unknown` because they come straight off a JSON body, and checking
 * them is part of the rule, not of the transport.
 */
import type { AllowedUser, UserRole } from "../domain/types.ts";
import { DEFAULT_PERSONALITY } from "../domain/personality.ts";
import { PAL_TOOLS } from "../domain/toolPolicy.ts";
import { GITHUB_LINK_PREFIX, githubLinkKey } from "../domain/reviewInbox.ts";
import {
  CORE_TOOLS,
  ROLES,
  UNDENIABLE_COMMANDS,
  defaultRolePolicy,
  effectivePolicy,
  knownMcpServers,
  parseRolePolicy,
  type RolePolicy,
} from "../domain/rolePolicy.ts";
import { labelMentions, mentionedIds, userLabel } from "../domain/slackNames.ts";
import type { NameResolver } from "./nameResolver.ts";
import { KIT_MODAL_PREFIX, viewProblem, type KitView } from "../domain/kitEvents.ts";
import { SETTING_KEYS } from "../infrastructure/db/settingsRepo.ts";
import { listCommandInfo } from "./commands.ts";
import type { BotProfile } from "./botProfile.ts";
import type { Clock } from "./ports.ts";
import type { SlackDirectory } from "./slackDirectory.ts";
import type { StatsRepo } from "../infrastructure/db/statsRepo.ts";
import { fillDays, offsetMsOf, statsDays, windowStart } from "../domain/dashboardStats.ts";
import { logAndIgnore } from "./ignoredError.ts";

/** A refused use case: what to tell the caller, and the HTTP-ish status it maps to. */
export type Refusal = { readonly ok: false; readonly error: string; readonly status: number };
export type Outcome<T> = { readonly ok: true; readonly value: T } | Refusal;

const done = <T>(value: T): Outcome<T> => ({ ok: true, value });
const refuse = (error: string, status = 400): Refusal => ({ ok: false, error, status });

/** The adapter result shape every gated write returns. */
type GateResult = {
  readonly ok: boolean;
  readonly violations?: readonly string[];
  readonly warnings?: readonly string[];
};

/** The memory adapter, when one is configured. */
export type MemoryAdapterPort = {
  readonly status: () => string;
  /** Everything the memory page renders. */
  readonly view: () => {
    readonly policy: string;
    readonly notes: string;
    readonly skills: readonly { readonly name: string; readonly description: string }[];
    readonly people: readonly string[];
    readonly channels: readonly string[];
    readonly revisions: readonly {
      readonly id: number;
      readonly createdAt: number;
      readonly createdBy: string;
      readonly reason: string;
    }[];
    readonly items: number;
  };
  /** What the brain's own save endpoint writes through. */
  readonly remember: (content: string, by: string) => GateResult;
  readonly revert: (id: number, by: string) => { readonly ok: boolean; readonly violations?: readonly string[] };
  /** Every file the adapter holds, for the hand editor. */
  readonly files: () => readonly { readonly path: string; readonly content: string }[];
  /** Rewrite one file by hand (blank removes it), gated and recorded as a revision. */
  readonly edit: (path: string, content: string, by: string, base?: string) => GateResult;
};

/** Only what the dashboard touches of each store, so any repo shape that fits will do. */
export type DashboardPorts = {
  readonly ownerSlackId: string;
  /** Local database MCP servers (`DB_MCP_SERVERS`), offered for denial. */
  readonly dbMcpServers?: readonly string[];
  readonly clock: Clock;
  readonly profile: () => BotProfile;
  /** The RAW allowlist: the dashboard must see and edit members of a switched-off role too. */
  readonly users: {
    readonly get: (slackId: string) => AllowedUser | undefined;
    readonly list: () => readonly AllowedUser[];
    readonly upsert: (user: AllowedUser) => unknown;
    readonly setDisplayName: (slackId: string, displayName: string) => void;
    readonly rename: (from: string, to: string) => boolean;
    readonly remove: (slackId: string) => void;
  };
  readonly messages: {
    readonly channels: () => readonly { readonly channelId: string }[];
    readonly count: () => number;
    readonly channelsPage: (
      cursor: string | undefined,
      limit: number,
    ) => { readonly channels: readonly { readonly channelId: string }[]; readonly nextCursor?: string };
    /** Turns older than message id `before` (newest when absent), oldest-first. */
    readonly pageForChannel: (
      channelId: string,
      before: number | undefined,
      limit: number,
    ) => {
      readonly messages: readonly { readonly slackUserId: string; readonly content: string }[];
      readonly nextBefore?: number;
    };
    readonly countForChannel: (channelId: string) => number;
    readonly clearChannel: (channelId: string) => unknown;
  };
  readonly learnings: {
    readonly list: () => readonly unknown[];
    readonly add: (content: string, createdBy: string, createdAt: number) => unknown;
    readonly update: (id: number, content: string) => void;
    readonly remove: (id: number) => void;
  };
  readonly settings: {
    readonly get: (key: string) => string | undefined;
    readonly set: (key: string, value: string) => void;
    readonly remove: (key: string) => void;
    readonly list: () => readonly { readonly key: string; readonly value: string }[];
  };
  /** Per-role policy - the same rows the bot enforces from. Absent: roles read as defaults and cannot be edited. */
  readonly rolePolicies?: {
    readonly list: () => readonly RolePolicy[];
    readonly save: (policy: RolePolicy, by: string, at: number) => void;
  };
  /** Cached Slack names for channels and people, so no page shows a bare id. */
  readonly names?: NameResolver;
  readonly adapter?: MemoryAdapterPort;
  readonly commandLog?: {
    readonly recent: (limit: number) => readonly { readonly slackUserId: string; readonly channelId: string }[];
    readonly clear: () => unknown;
  };
  readonly usage?: {
    readonly totals: (since: number) => unknown;
    readonly byUser: (since: number, limit?: number) => readonly { readonly key: string }[];
    readonly byKind: (since: number, limit?: number) => readonly unknown[];
  };
  readonly kitViews?: { readonly save: (view: KitView, at: number) => string };
  /** The workspace's members, cached, for the Users page's search. Absent: no search, paste an id. */
  readonly directory?: SlackDirectory;
  /** Aggregates for the overview charts. */
  readonly stats?: StatsRepo;
  /** The host's `Date#getTimezoneOffset`, so a chart's days are the reader's days. */
  readonly timezoneOffset?: () => number;
  /** Resolve Slack display names for ids with none stored. Failure means "no names". */
  readonly resolveNames?: (ids: readonly string[]) => Promise<Record<string, string>>;
};

const SLACK_ID = /^[UW][A-Z0-9]+$/;
/** Turns per page of a conversation, and its ceiling when the page asks for more. */
const CONVERSATION_PAGE = 50;
const CHANNEL_PAGE = 30;
const PAGE_MAX = 200;
const MEMBER_RESULTS = 8;
const STATS_TOP = 8;
const COMMAND_LOG_LIMIT = 200;
/** Every write made from the deck is recorded as made by it. */
const BY = "dashboard";

const parseCsv = (v: string | undefined): Set<string> =>
  new Set((v ?? "").split(",").map((s) => s.trim()).filter(Boolean));

const text = (v: unknown): string => String(v ?? "").trim();
/** A page size from a query string, clamped; anything unreadable means `fallback`. */
export const pageSize = (v: string | null | undefined, fallback: number): number => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(n, PAGE_MAX) : fallback;
};
/** A message-id cursor, or undefined for "start at the newest". */
const beforeId = (v: string | null | undefined): number | undefined => {
  const n = Number(v);
  return v && Number.isInteger(n) && n > 0 ? n : undefined;
};
/**
 * A role the deck may hand out, or undefined. Never `owner` (there is one, and
 * it comes from the environment), and never a silent fallback: bad input is
 * refused, because the fallback would be a demotion nobody asked for.
 */
const assignable = (v: unknown): UserRole | undefined =>
  v === "admin" || v === "executer" || v === "pal" ? v : undefined;
const BAD_ROLE = "Pick admin, executer or pal";
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const gateError = (r: { readonly violations?: readonly string[] }, fallback: string): Refusal =>
  refuse((r.violations ?? [fallback]).join("; "));

/** Hours of usage to show, clamped to a year; anything unreadable means the last day. */
export const usageWindowMs = (hours: string | null): number => {
  const h = Number(hours ?? "24");
  return (Number.isFinite(h) && h > 0 ? Math.min(h, 24 * 365) : 24) * 3_600_000;
};

const RANK: Record<UserRole, number> = { pal: 0, executer: 1, admin: 2, owner: 3 };

export const createDashboardService = (p: DashboardPorts) => {
  const rolePolicies = (): readonly RolePolicy[] => p.rolePolicies?.list() ?? ROLES.map(defaultRolePolicy);

  /** Slack id -> its GitHub logins, from the `github_login:` links the review inbox and GitHub App use. */
  const githubLogins = (): Map<string, string[]> => {
    const out = new Map<string, string[]>();
    for (const { key, value } of p.settings.list()) {
      if (!key.startsWith(GITHUB_LINK_PREFIX)) continue;
      const id = value.trim();
      out.set(id, [...(out.get(id) ?? []), key.slice(GITHUB_LINK_PREFIX.length)]);
    }
    return out;
  };

  const storedName = (id: string): string | undefined => p.users.get(id)?.displayName || undefined;
  const userLabels = async (ids: readonly string[]): Promise<Record<string, string>> => {
    const wanted = [...new Set(ids.filter(Boolean))];
    if (p.names) return p.names.userLabels(wanted);
    return Object.fromEntries(wanted.map((id) => [id, userLabel(id, storedName(id))]));
  };
  const conversationLabels = async (ids: readonly string[]): Promise<Record<string, string>> => {
    const wanted = [...new Set(ids.filter(Boolean))];
    if (p.names) return p.names.conversationLabels(wanted);
    return Object.fromEntries(wanted.map((id) => [id, `unknown (${id})`]));
  };

  return {
  overview: () => ({
    users: p.users.list().length,
    conversations: p.messages.channels().length,
    messages: p.messages.count(),
    // With an adapter the old table is empty by design, so count what memory
    // actually holds rather than reporting a truthful zero.
    learnings: p.adapter ? p.adapter.view().items : p.learnings.list().length,
    memory: !!p.adapter,
  }),

  /** Users with a display name, filled from Slack where none is stored, and their GitHub logins. */
  listUsers: async () => {
    const users = p.users.list();
    const missing = users.filter((u) => !u.displayName).map((u) => u.slackId);
    const resolved: Record<string, string> =
      missing.length && p.resolveNames ? await p.resolveNames(missing).catch(logAndIgnore("dashboard resolve names", {} as Record<string, string>)) : {};
    const logins = githubLogins();
    return users.map((u) => ({
      ...u,
      name: u.displayName || resolved[u.slackId] || "",
      githubLogins: logins.get(u.slackId) ?? [],
    }));
  },

  /**
   * Add someone, or change their role. `displayName` is the name the search
   * showed when they were picked; it only fills an empty one, never overwrites.
   */
  saveUser: (slackIdIn: unknown, role: unknown, displayNameIn?: unknown): Outcome<null> => {
    const slackId = text(slackIdIn);
    if (!SLACK_ID.test(slackId)) return refuse("Invalid Slack id");
    if (slackId === p.ownerSlackId) return refuse("The owner record cannot be modified");
    const next = assignable(role ?? "pal");
    if (!next) return refuse(BAD_ROLE);
    const existing = p.users.get(slackId);
    p.users.upsert({
      slackId,
      role: next,
      displayName: existing?.displayName || text(displayNameIn),
      addedBy: BY,
      createdAt: existing?.createdAt ?? p.clock(),
    });
    return done(null);
  },

  /**
   * Edit one user: a corrected Slack id, the name shown for them, the GitHub
   * logins that are theirs, and their role. The owner keeps their id (it comes
   * from the environment) and their role; name and GitHub are theirs to edit.
   */
  updateUser: (body: {
    readonly slackId: unknown;
    readonly newSlackId?: unknown;
    readonly displayName?: unknown;
    readonly githubLogins?: unknown;
    readonly role?: unknown;
  }): Outcome<null> => {
    const slackId = text(body.slackId);
    const existing = p.users.get(slackId);
    if (!existing) return refuse("No such user", 404);
    const isOwner = slackId === p.ownerSlackId;
    const nextId = body.newSlackId === undefined ? slackId : text(body.newSlackId);
    if (!SLACK_ID.test(nextId)) return refuse("Invalid Slack id");
    if (isOwner && nextId !== slackId) return refuse("The owner's Slack id comes from the environment");
    if (nextId === p.ownerSlackId && !isOwner) return refuse("That is the owner's Slack id");
    if (nextId !== slackId && p.users.get(nextId)) return refuse("Another user already has that Slack id");
    if (body.role !== undefined && isOwner && body.role !== "owner") return refuse("The owner's role cannot be changed");
    const nextRole = body.role === undefined || isOwner ? undefined : assignable(body.role);
    if (body.role !== undefined && !isOwner && !nextRole) return refuse(BAD_ROLE);
    const logins =
      body.githubLogins === undefined
        ? undefined
        : [...new Set(
            (Array.isArray(body.githubLogins) ? body.githubLogins : String(body.githubLogins ?? "").split(/[,\s]+/))
              .map((l) => String(l ?? "").trim().replace(/^@/, "").toLowerCase())
              .filter(Boolean),
          )];
    const badLogin = logins?.find((l) => !GITHUB_LOGIN.test(l));
    if (badLogin) return refuse(`Not a GitHub login: ${badLogin}`);
    // A link held by someone no longer on the list is stale, not taken.
    const taken = logins?.find((l) => {
      const holder = p.settings.get(githubLinkKey(l))?.trim();
      return holder && holder !== slackId && !!p.users.get(holder);
    });
    if (taken) {
      const holder = p.settings.get(githubLinkKey(taken))!.trim();
      return refuse(`${taken} is already linked to ${userLabel(holder, p.users.get(holder)?.displayName)}`);
    }

    // Everything checked; now write, id first so the rest lands on the new row.
    if (nextId !== slackId) {
      if (!p.users.rename(slackId, nextId)) return refuse("Another user already has that Slack id");
      for (const { key, value } of p.settings.list()) {
        if (key.startsWith(GITHUB_LINK_PREFIX) && value.trim() === slackId) p.settings.set(key, nextId);
      }
    }
    if (body.displayName !== undefined) p.users.setDisplayName(nextId, text(body.displayName));
    if (logins) {
      for (const { key, value } of p.settings.list()) {
        if (key.startsWith(GITHUB_LINK_PREFIX) && value.trim() === nextId) p.settings.remove(key);
      }
      for (const l of logins) p.settings.set(githubLinkKey(l), nextId);
    }
    if (nextRole) {
      const current = p.users.get(nextId);
      if (current) p.users.upsert({ ...current, role: nextRole });
    }
    return done(null);
  },

  /**
   * Workspace members matching what was typed, for the Users page's picker.
   * Each carries the role they already hold, so the picker can say "already
   * added" instead of offering a second row.
   */
  searchMembers: async (queryIn: unknown): Promise<Outcome<{ members: readonly unknown[] }>> => {
    if (!p.directory) return refuse("Slack directory is not wired up - paste a Slack id instead", 503);
    const query = text(queryIn).slice(0, 80);
    try {
      const found = await p.directory.search(query, MEMBER_RESULTS);
      return done({
        members: found.map((m) => ({
          id: m.id,
          handle: m.handle,
          realName: m.realName,
          displayName: m.displayName,
          title: m.title,
          avatar: m.avatar,
          role: p.users.get(m.id)?.role,
        })),
      });
    } catch (e) {
      return refuse(`Could not read the Slack directory: ${e instanceof Error ? e.message : String(e)}`, 502);
    }
  },

  /** Put an existing user in a role, from the Roles page. */
  assignRole: (slackIdIn: unknown, role: unknown): Outcome<null> => {
    const slackId = text(slackIdIn);
    const existing = p.users.get(slackId);
    if (!existing) return refuse("No such user", 404);
    if (slackId === p.ownerSlackId) return refuse("The owner's role cannot be changed");
    const next = assignable(role);
    if (!next) return refuse(BAD_ROLE);
    p.users.upsert({ ...existing, role: next });
    return done(null);
  },

  removeUser: (slackIdIn: unknown): Outcome<null> => {
    const slackId = text(slackIdIn);
    if (slackId === p.ownerSlackId) return refuse("The owner cannot be removed");
    p.users.remove(slackId);
    // Their GitHub links go too: left behind, they would still map GitHub
    // calls to an id nobody can see on this page, and block the login's reuse.
    for (const { key, value } of p.settings.list()) {
      if (key.startsWith(GITHUB_LINK_PREFIX) && value.trim() === slackId) p.settings.remove(key);
    }
    return done(null);
  },

  /**
   * Every role with its policy and members, plus what can be denied. Commands
   * are offered per role only up to its rank: a role cannot be granted past a
   * command's `minRole`, so there is nothing to tick above it.
   */
  roles: () => {
    const policies = rolePolicies();
    const users = p.users.list();
    const commands = listCommandInfo();
    return {
      roles: policies.map((policy) => ({
        ...effectivePolicy(policy),
        locked: policy.role === "owner",
        members: users
          .filter((u) => u.role === policy.role || (policy.role === "owner" && u.slackId === p.ownerSlackId))
          .map((u) => ({ slackId: u.slackId, name: u.displayName })),
        commands: commands
          .filter((c) => RANK[policy.role] >= RANK[c.minRole] && !UNDENIABLE_COMMANDS.includes(c.name))
          .map((c) => c.name),
      })),
      tools: CORE_TOOLS,
      mcpServers: knownMcpServers(policies, p.dbMcpServers),
      editable: !!p.rolePolicies,
      executerTools: p.settings.get(SETTING_KEYS.executerTools) ?? "",
      palTools: PAL_TOOLS,
    };
  },

  /** Switch a role on or off and set what it is denied. The owner role is never restricted. */
  saveRolePolicy: (body: {
    readonly role: unknown;
    readonly enabled: unknown;
    readonly deniedCommands: unknown;
    readonly deniedTools: unknown;
    readonly deniedMcpServers: unknown;
  }): Outcome<null> => {
    if (!p.rolePolicies) return refuse("Role policies are not wired up", 503);
    const parsed = parseRolePolicy(body, listCommandInfo().map((c) => c.name));
    if (!parsed.ok) return refuse(parsed.error);
    p.rolePolicies.save(parsed.policy, BY, p.clock());
    return done(null);
  },

  /** The executer role's tool allow-list, comma or newline separated. */
  setExecuterTools: (tools: unknown) => p.settings.set(SETTING_KEYS.executerTools, text(tools)),

  learnings: () => p.learnings.list(),

  /**
   * Teach one fact. This is also what the brain curls when it decides to keep
   * something, so it has to reach whichever memory is live.
   */
  teach: (contentIn: unknown): Outcome<{ warnings?: readonly string[] }> => {
    const content = text(contentIn);
    if (!content) return refuse("Empty learning");
    if (p.adapter) {
      const result = p.adapter.remember(content, BY);
      if (!result.ok) return gateError(result, "Could not save that");
      return done({ warnings: result.warnings ?? [] });
    }
    p.learnings.add(content, BY, p.clock());
    return done({});
  },

  updateLearning: (idIn: unknown, contentIn: unknown): Outcome<null> => {
    const id = Number(idIn);
    const content = text(contentIn);
    if (!Number.isInteger(id)) return refuse("A learning id is required");
    if (!content) return refuse("Empty learning");
    p.learnings.update(id, content);
    return done(null);
  },

  removeLearning: (idIn: unknown): Outcome<null> => {
    const id = Number(idIn);
    if (!Number.isInteger(id)) return refuse("Invalid id");
    p.learnings.remove(id);
    return done(null);
  },

  /**
   * The memory page. Hand edits go through `editAdapterFile`, one whole file
   * at a time, through the same gate as refine and recorded as a revision.
   */
  adapterView: () =>
    p.adapter ? { configured: true, status: p.adapter.status(), ...p.adapter.view() } : { configured: false },

  adapterFiles: (): Outcome<readonly { readonly path: string; readonly content: string }[]> =>
    p.adapter ? done(p.adapter.files()) : refuse("No memory adapter is configured", 404),

  revertAdapter: (idIn: unknown): Outcome<null> => {
    if (!p.adapter) return refuse("No memory adapter is configured");
    const id = Number(idIn);
    if (!Number.isInteger(id)) return refuse("A revision id is required");
    const result = p.adapter.revert(id, BY);
    return result.ok ? done(null) : gateError(result, "Could not revert");
  },

  /** `base` is what the editor was opened on, so a save cannot undo a change that landed while the page sat open. */
  editAdapterFile: (pathIn: unknown, content: unknown, base: unknown): Outcome<{ warnings: readonly string[] }> => {
    if (!p.adapter) return refuse("No memory adapter is configured");
    const path = text(pathIn);
    if (!path) return refuse("A file path is required");
    if (typeof content !== "string") return refuse("content is required (blank removes the file)");
    const result = p.adapter.edit(path, content, BY, typeof base === "string" ? base : undefined);
    return result.ok ? done({ warnings: result.warnings ?? [] }) : gateError(result, "Could not save that");
  },

  identity: () => {
    const override = p.settings.get(SETTING_KEYS.systemPrompt);
    const profile = p.profile();
    return {
      name: profile.name,
      thinkingLabel: profile.thinkingLabel,
      thinkingDoneLabel: profile.thinkingDoneLabel,
      persona: override ?? DEFAULT_PERSONALITY,
      usingDefault: override === undefined,
      defaultPersona: DEFAULT_PERSONALITY,
    };
  },

  /** Name is required; a blank label falls back to the default; a blank prompt keeps the current one. */
  saveIdentity: (body: {
    readonly name: unknown;
    readonly thinkingLabel: unknown;
    readonly thinkingDoneLabel: unknown;
    readonly prompt: unknown;
  }): Outcome<null> => {
    const name = text(body.name);
    if (!name) return refuse("Bot name is required");
    p.settings.set(SETTING_KEYS.botName, name);
    const setOrClear = (key: string, value: unknown) => {
      const v = text(value);
      if (v) p.settings.set(key, v);
      else p.settings.remove(key);
    };
    setOrClear(SETTING_KEYS.thinkingLabel, body.thinkingLabel);
    setOrClear(SETTING_KEYS.thinkingDoneLabel, body.thinkingDoneLabel);
    const prompt = text(body.prompt);
    if (prompt) p.settings.set(SETTING_KEYS.systemPrompt, prompt);
    return done(null);
  },

  resetPrompt: () => p.settings.remove(SETTING_KEYS.systemPrompt),

  /**
   * One page of stored conversations, most recently active first, each named:
   * `#channel (C…)`, a DM as the person. `cursor` is the previous page's
   * `nextCursor`; the page scrolls, so only one page is ever named at a time.
   */
  conversations: async (cursor?: string | null, limit?: string | null) => {
    const page = p.messages.channelsPage(cursor || undefined, pageSize(limit, CHANNEL_PAGE));
    const labels = await conversationLabels(page.channels.map((c) => c.channelId));
    return {
      channels: page.channels.map((c) => ({ ...c, label: labels[c.channelId] })),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  },

  /**
   * One page of a conversation's turns, oldest-first, every author - and
   * everyone mentioned - named as well as id'd. No `before` is the newest page;
   * `nextBefore` is what to pass for the one above it, absent at the top.
   */
  conversation: async (channel: string, before?: string | null, limit?: string | null) => {
    const page = channel
      ? p.messages.pageForChannel(channel, beforeId(before), pageSize(limit, CONVERSATION_PAGE))
      : { messages: [] };
    const messages = page.messages;
    const [labels, people] = await Promise.all([
      conversationLabels(channel ? [channel] : []),
      userLabels(messages.flatMap((m) => [m.slackUserId, ...mentionedIds(m.content)])),
    ]);
    return {
      channel: { id: channel, label: labels[channel] ?? `unknown (${channel})` },
      total: channel ? p.messages.countForChannel(channel) : 0,
      ...(page.nextBefore ? { nextBefore: page.nextBefore } : {}),
      messages: messages.map((m) => ({
        ...m,
        content: labelMentions(m.content, people),
        userLabel: people[m.slackUserId] ?? userLabel(m.slackUserId),
      })),
    };
  },

  clearConversation: (channelIn: unknown) => {
    const channel = text(channelIn);
    if (channel) p.messages.clearChannel(channel);
  },

  commands: () => ({
    commands: listCommandInfo(),
    disabled: [...parseCsv(p.settings.get(SETTING_KEYS.disabledCommands))],
  }),

  toggleCommand: (nameIn: unknown, enabled: unknown): Outcome<null> => {
    const name = text(nameIn);
    if (!name) return refuse("Command name required");
    const disabled = parseCsv(p.settings.get(SETTING_KEYS.disabledCommands));
    if (enabled === false) disabled.add(name);
    else disabled.delete(name);
    p.settings.set(SETTING_KEYS.disabledCommands, [...disabled].join(","));
    return done(null);
  },

  commandLog: async () => {
    const entries = p.commandLog?.recent(COMMAND_LOG_LIMIT) ?? [];
    const [people, places] = await Promise.all([
      userLabels(entries.map((e) => e.slackUserId)),
      conversationLabels(entries.map((e) => e.channelId)),
    ]);
    return entries.map((e) => ({
      ...e,
      userLabel: people[e.slackUserId] ?? userLabel(e.slackUserId),
      channelLabel: e.channelId ? places[e.channelId] ?? `unknown (${e.channelId})` : "",
    }));
  },

  clearCommandLog: () => {
    p.commandLog?.clear();
  },

  /** One window per request: the page asks for the one it shows, so the two never disagree. */
  usage: async (hours: string | null) => {
    if (!p.usage) return { recording: false };
    const windowMs = usageWindowMs(hours);
    const since = p.clock() - windowMs;
    const byUser = p.usage.byUser(since, 25);
    // Name + id for every row, allowlisted or not: a spend table of bare ids says nothing.
    const names = await userLabels(byUser.map((r) => r.key));
    return {
      recording: true,
      windowMs,
      totals: p.usage.totals(since),
      byUser,
      byKind: p.usage.byKind(since, 25),
      names,
    };
  },

  /**
   * The overview's charts: a day series per table over the last `days` days
   * (zeros included), the busiest commands and people, and how many threads
   * were live. Days are the host's local days.
   */
  stats: async (daysIn: string | null) => {
    if (!p.stats) return { recording: false as const };
    const days = statsDays(daysIn);
    const now = p.clock();
    const offset = offsetMsOf(p.timezoneOffset?.() ?? 0);
    const since = windowStart(now, days, offset);
    const s = p.stats;
    const topUsers = s.topUsers(since, STATS_TOP);
    const names = await userLabels(topUsers.map((u) => u.key));
    return {
      recording: true as const,
      days,
      messages: fillDays(s.messagesPerDay(since, offset), now, days, offset, { user: 0, assistant: 0 }),
      turns: fillDays(s.turnsPerDay(since, offset), now, days, offset, { ok: 0, failed: 0 }),
      spend: fillDays(s.spendPerDay(since, offset), now, days, offset, { runs: 0, costUsd: 0 }),
      topCommands: s.topCommands(since, STATS_TOP),
      topUsers: topUsers.map((u) => ({ ...u, label: names[u.key] ?? userLabel(u.key) })),
      // Calendar days, like the charts: "today" is since local midnight.
      activeThreads: {
        day: s.activeThreads(windowStart(now, 1, offset)),
        week: s.activeThreads(windowStart(now, 7, offset)),
        window: s.activeThreads(since),
      },
    };
  },

  /**
   * Store a modal for a `jv:modal:<id>` button. The brain cannot open one from
   * a turn, so it stores it here and posts a button naming it. Shape is
   * checked now, not on click, where a bad view could only fail silently.
   */
  saveKitView: (view: unknown): Outcome<{ id: string; action_id: string }> => {
    if (!p.kitViews) return refuse("Modals are not wired up", 503);
    const problem = viewProblem(view);
    if (problem) return refuse(problem);
    const id = p.kitViews.save(view as KitView, p.clock());
    return done({ id, action_id: `${KIT_MODAL_PREFIX}${id}` });
  },
  };
};

export type DashboardService = ReturnType<typeof createDashboardService>;
