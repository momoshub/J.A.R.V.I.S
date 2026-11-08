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
import { KIT_MODAL_PREFIX, viewProblem, type KitView } from "../domain/kitEvents.ts";
import { SETTING_KEYS } from "../infrastructure/db/settingsRepo.ts";
import { listCommandInfo } from "./commands.ts";
import type { BotProfile } from "./botProfile.ts";
import type { Clock } from "./ports.ts";

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
  readonly clock: Clock;
  readonly profile: () => BotProfile;
  readonly users: {
    readonly get: (slackId: string) => AllowedUser | undefined;
    readonly list: () => readonly AllowedUser[];
    readonly upsert: (user: AllowedUser) => unknown;
    readonly remove: (slackId: string) => void;
  };
  readonly messages: {
    readonly channels: () => readonly unknown[];
    readonly count: () => number;
    readonly recentForChannel: (channelId: string, limit: number) => readonly unknown[];
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
  };
  readonly adapter?: MemoryAdapterPort;
  readonly commandLog?: { readonly recent: (limit: number) => readonly unknown[]; readonly clear: () => unknown };
  readonly usage?: {
    readonly totals: (since: number) => unknown;
    readonly byUser: (since: number, limit?: number) => readonly unknown[];
    readonly byKind: (since: number, limit?: number) => readonly unknown[];
  };
  readonly kitViews?: { readonly save: (view: KitView, at: number) => string };
  /** Resolve Slack display names for ids with none stored. Failure means "no names". */
  readonly resolveNames?: (ids: readonly string[]) => Promise<Record<string, string>>;
};

const SLACK_ID = /^[UW][A-Z0-9]+$/;
const CONVERSATION_LIMIT = 200;
const COMMAND_LOG_LIMIT = 200;
/** Every write made from the deck is recorded as made by it. */
const BY = "dashboard";

const parseCsv = (v: string | undefined): Set<string> =>
  new Set((v ?? "").split(",").map((s) => s.trim()).filter(Boolean));

const text = (v: unknown): string => String(v ?? "").trim();
const asRole = (v: unknown): UserRole => (v === "admin" ? "admin" : "pal");
const gateError = (r: { readonly violations?: readonly string[] }, fallback: string): Refusal =>
  refuse((r.violations ?? [fallback]).join("; "));

/** Hours of usage to show, clamped to a year; anything unreadable means the last day. */
export const usageWindowMs = (hours: string | null): number => {
  const h = Number(hours ?? "24");
  return (Number.isFinite(h) && h > 0 ? Math.min(h, 24 * 365) : 24) * 3_600_000;
};

export const createDashboardService = (p: DashboardPorts) => ({
  overview: () => ({
    users: p.users.list().length,
    conversations: p.messages.channels().length,
    messages: p.messages.count(),
    // With an adapter the old table is empty by design, so count what memory
    // actually holds rather than reporting a truthful zero.
    learnings: p.adapter ? p.adapter.view().items : p.learnings.list().length,
    memory: !!p.adapter,
  }),

  /** Users with a display name, filled from Slack where none is stored. */
  listUsers: async () => {
    const users = p.users.list();
    const missing = users.filter((u) => !u.displayName).map((u) => u.slackId);
    const resolved: Record<string, string> =
      missing.length && p.resolveNames ? await p.resolveNames(missing).catch(() => ({})) : {};
    return users.map((u) => ({ ...u, name: u.displayName || resolved[u.slackId] || "" }));
  },

  saveUser: (slackIdIn: unknown, role: unknown): Outcome<null> => {
    const slackId = text(slackIdIn);
    if (!SLACK_ID.test(slackId)) return refuse("Invalid Slack id");
    if (slackId === p.ownerSlackId) return refuse("The owner record cannot be modified");
    const existing = p.users.get(slackId);
    p.users.upsert({
      slackId,
      role: asRole(role),
      displayName: existing?.displayName ?? "",
      addedBy: BY,
      createdAt: existing?.createdAt ?? p.clock(),
    });
    return done(null);
  },

  removeUser: (slackIdIn: unknown): Outcome<null> => {
    const slackId = text(slackIdIn);
    if (slackId === p.ownerSlackId) return refuse("The owner cannot be removed");
    p.users.remove(slackId);
    return done(null);
  },

  roles: () => ({ executerTools: p.settings.get(SETTING_KEYS.executerTools) ?? "", palTools: PAL_TOOLS }),

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

  conversations: () => p.messages.channels(),

  conversation: (channel: string) => (channel ? p.messages.recentForChannel(channel, CONVERSATION_LIMIT) : []),

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

  commandLog: () => p.commandLog?.recent(COMMAND_LOG_LIMIT) ?? [],

  clearCommandLog: () => {
    p.commandLog?.clear();
  },

  /** One window per request: the page asks for the one it shows, so the two never disagree. */
  usage: (hours: string | null) => {
    if (!p.usage) return { recording: false };
    const windowMs = usageWindowMs(hours);
    const since = p.clock() - windowMs;
    const names = Object.fromEntries(p.users.list().map((u) => [u.slackId, u.displayName || u.slackId]));
    return {
      recording: true,
      windowMs,
      totals: p.usage.totals(since),
      byUser: p.usage.byUser(since, 25),
      byKind: p.usage.byKind(since, 25),
      names,
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
});

export type DashboardService = ReturnType<typeof createDashboardService>;
