/**
 * What each turn has posted into its own thread through the Slack proxy.
 *
 * The proxy records a successful `chat.postMessage` / `chat.update` here; the
 * Slack handler reads it when the turn ends, to take back a closing reply that
 * only repeats what the turn already said (`domain/selfPost.ts`), and clears it.
 *
 * Keyed by the turn's run ticket (shared by every process the turn spawns, each
 * of which has its own Slack ticket), not by thread: watch hand-backs, `tell`,
 * workflow steps and commands post into the same thread under tickets of their
 * own, and none of that may be taken for what THIS turn said. In memory: a
 * restart ends every turn anyway.
 */
import { applySelfPostCall, type SelfPost, type SelfPostCall } from "../domain/selfPost.ts";
import type { Clock } from "./ports.ts";

/** Longer than any turn the bot allows (the ticket's own TTL): the backstop for a turn that never reached its clear. */
export const SELF_POSTS_TTL_MS = 3 * 60 * 60_000;
/** Turns remembered at once; the oldest goes first. Only a turn the Slack handler never read (a hand-back, a loop, a workflow step) leaves one behind. */
export const SELF_POSTS_MAX_TURNS = 500;

export type SelfPosts = {
  /** Note a call the proxy made for the turn `turn`, which runs in the thread `threadTs`. */
  record: (turn: string, threadTs: string | undefined, call: SelfPostCall) => void;
  /** What that turn has posted so far. */
  posts: (turn: string) => readonly SelfPost[];
  /** The turn ended. */
  clear: (turn: string) => void;
};

type Entry = { readonly posts: readonly SelfPost[]; readonly at: number };

export const createSelfPosts = (clock: Clock = () => Date.now()): SelfPosts => {
  const byTurn = new Map<string, Entry>();
  return {
    record: (key, threadTs, call) => {
      if (!threadTs) return;
      const now = clock();
      const live = byTurn.get(key);
      const before = live && now - live.at < SELF_POSTS_TTL_MS ? live.posts : [];
      const after = applySelfPostCall(before, call, threadTs);
      if (after === before) return;
      // delete first so a re-set turn moves to the newest end of the Map
      byTurn.delete(key);
      byTurn.set(key, { posts: after, at: now });
      for (const oldest of byTurn.keys()) {
        if (byTurn.size <= SELF_POSTS_MAX_TURNS) break;
        byTurn.delete(oldest);
      }
    },
    posts: (turn) => {
      const live = byTurn.get(turn);
      return live && clock() - live.at < SELF_POSTS_TTL_MS ? live.posts : [];
    },
    clear: (turn) => void byTurn.delete(turn),
  };
};
