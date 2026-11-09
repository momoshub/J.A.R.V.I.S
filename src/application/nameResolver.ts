/**
 * Slack names for the dashboard, cached.
 *
 * A page that lists forty conversations must not cost forty `conversations.info`
 * calls every time it is opened, so each answer is kept for `ttlMs` and a
 * failure for the shorter `failTtlMs` (a channel the bot cannot see stays
 * unseen for a while rather than being asked about on every render). Lookups
 * already in flight are shared. Names held on the allowlist win over Slack's,
 * because that is the name the owner chose to show.
 */
import { conversationLabel, userLabel, type ConversationInfo } from "../domain/slackNames.ts";
import type { Clock } from "./ports.ts";
import { ignoreQuietly } from "./ignoredError.ts";

export type NameLookups = {
  /** One conversation's kind and name; undefined when Slack would not say. */
  readonly conversation: (id: string) => Promise<ConversationInfo | undefined>;
  /** Display names for user ids; an id missing or mapped to itself is unresolved. */
  readonly users: (ids: readonly string[]) => Promise<Record<string, string>>;
};

export type NameResolver = {
  /** Slack id -> display name ("" when unknown). */
  readonly userNames: (ids: readonly string[]) => Promise<Record<string, string>>;
  /** Slack id -> `Name (U…)`. */
  readonly userLabels: (ids: readonly string[]) => Promise<Record<string, string>>;
  /** Conversation id -> `#name (C…)` / `@Person (D…)`. */
  readonly conversationLabels: (ids: readonly string[]) => Promise<Record<string, string>>;
};

export const NAME_TTL_MS = 6 * 3_600_000;
/**
 * At most this many `conversations.info` calls at once. A cold first render of
 * a long Conversations list would otherwise fire one per channel together,
 * hit Slack's rate limit, and either hang in the client's backoff or cache a
 * page full of "unknown" for the failure TTL.
 */
export const NAME_LOOKUP_CONCURRENCY = 5;
export const NAME_FAIL_TTL_MS = 10 * 60_000;

type Entry<T> = { readonly value: T; readonly until: number };

export const createNameResolver = (opts: {
  readonly lookups?: NameLookups;
  readonly clock: Clock;
  /** Names stored on the allowlist. */
  readonly knownName?: (id: string) => string | undefined;
  readonly ttlMs?: number;
  readonly failTtlMs?: number;
  readonly concurrency?: number;
}): NameResolver => {
  const limit = Math.max(1, opts.concurrency ?? NAME_LOOKUP_CONCURRENCY);
  const ttl = opts.ttlMs ?? NAME_TTL_MS;
  const failTtl = opts.failTtlMs ?? NAME_FAIL_TTL_MS;
  const users = new Map<string, Entry<string>>();
  const conversations = new Map<string, Entry<ConversationInfo | undefined>>();
  const inflight = new Map<string, Promise<ConversationInfo | undefined>>();

  const fresh = <T>(e: Entry<T> | undefined): e is Entry<T> => !!e && e.until > opts.clock();

  const userNames = async (ids: readonly string[]): Promise<Record<string, string>> => {
    const wanted = [...new Set(ids.filter(Boolean))];
    const out: Record<string, string> = {};
    const missing: string[] = [];
    for (const id of wanted) {
      const stored = opts.knownName?.(id)?.trim();
      if (stored) out[id] = stored;
      else if (fresh(users.get(id))) out[id] = users.get(id)!.value;
      else missing.push(id);
    }
    if (missing.length && opts.lookups) {
      const got = await opts.lookups.users(missing).catch((): Record<string, string> => ({}));
      for (const id of missing) {
        const name = got[id]?.trim();
        const ok = !!name && name !== id;
        users.set(id, { value: ok ? name : "", until: opts.clock() + (ok ? ttl : failTtl) });
        out[id] = ok ? name : "";
      }
    }
    for (const id of wanted) out[id] ??= "";
    return out;
  };

  const conversation = (id: string): Promise<ConversationInfo | undefined> => {
    const cached = conversations.get(id);
    if (fresh(cached)) return Promise.resolve(cached.value);
    const pending = inflight.get(id);
    if (pending) return pending;
    const lookup = opts.lookups?.conversation(id).catch(ignoreQuietly("conversation name lookup")) ?? Promise.resolve(undefined);
    const p = lookup.then((info) => {
      conversations.set(id, { value: info, until: opts.clock() + (info ? ttl : failTtl) });
      inflight.delete(id);
      return info;
    });
    inflight.set(id, p);
    return p;
  };

  return {
    userNames,
    userLabels: async (ids) => {
      const names = await userNames(ids);
      return Object.fromEntries(Object.entries(names).map(([id, n]) => [id, userLabel(id, n)]));
    },
    conversationLabels: async (ids) => {
      const wanted = [...new Set(ids.filter(Boolean))];
      const infos: (readonly [string, ConversationInfo | undefined])[] = [];
      for (let i = 0; i < wanted.length; i += limit) {
        const batch = wanted.slice(i, i + limit);
        infos.push(...(await Promise.all(batch.map(async (id) => [id, await conversation(id)] as const))));
      }
      const partners = infos.map(([, i]) => (i?.kind === "im" ? i.userId : undefined)).filter((u): u is string => !!u);
      const names = partners.length ? await userNames(partners) : {};
      return Object.fromEntries(
        infos.map(([id, info]) => [id, conversationLabel(id, info, info?.userId ? names[info.userId] : undefined)]),
      );
    },
  };
};
