/**
 * What each turn has posted into its own thread through the Slack proxy.
 *
 * The proxy records a successful `chat.postMessage` / `chat.update` here; the
 * Slack handler reads it when the turn ends, to take back a closing reply that
 * only repeats what the turn already said (`domain/selfPost.ts`), and clears it.
 *
 * Keyed by channel and thread, not by ticket: a thread runs one turn at a time
 * (the thread queue), and a turn may spawn several processes, each with its own
 * ticket. In memory: a restart ends every turn anyway.
 */
import { applySelfPostCall, type SelfPost, type SelfPostCall } from "../domain/selfPost.ts";
import type { Clock } from "./ports.ts";

/** Longer than any turn the bot allows (the ticket's own TTL): the backstop for a turn that never reached its clear. */
export const SELF_POSTS_TTL_MS = 3 * 60 * 60_000;
/** Threads remembered at once; the oldest goes first. Only turns outside the Slack handler (loops, workflows) can leave one behind. */
export const SELF_POSTS_MAX_THREADS = 500;

export type SelfPosts = {
  /** Note a call the proxy made for a turn running in `channel` / `threadTs`. */
  record: (channel: string, threadTs: string | undefined, call: SelfPostCall) => void;
  /** What the turn in that thread has posted so far. */
  posts: (channel: string, threadTs: string) => readonly SelfPost[];
  /** The turn ended. */
  clear: (channel: string, threadTs: string) => void;
};

const keyOf = (channel: string, threadTs: string): string => `${channel}:${threadTs}`;

type Entry = { readonly posts: readonly SelfPost[]; readonly at: number };

export const createSelfPosts = (clock: Clock = () => Date.now()): SelfPosts => {
  const byThread = new Map<string, Entry>();
  return {
    record: (channel, threadTs, call) => {
      if (!threadTs) return;
      const key = keyOf(channel, threadTs);
      const now = clock();
      const live = byThread.get(key);
      const before = live && now - live.at < SELF_POSTS_TTL_MS ? live.posts : [];
      const after = applySelfPostCall(before, call, threadTs);
      if (after === before) return;
      // delete first so a re-set thread moves to the newest end of the Map
      byThread.delete(key);
      byThread.set(key, { posts: after, at: now });
      for (const oldest of byThread.keys()) {
        if (byThread.size <= SELF_POSTS_MAX_THREADS) break;
        byThread.delete(oldest);
      }
    },
    posts: (channel, threadTs) => {
      const live = byThread.get(keyOf(channel, threadTs));
      return live && clock() - live.at < SELF_POSTS_TTL_MS ? live.posts : [];
    },
    clear: (channel, threadTs) => void byThread.delete(keyOf(channel, threadTs)),
  };
};
