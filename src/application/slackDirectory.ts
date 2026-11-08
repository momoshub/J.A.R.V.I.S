/**
 * The workspace's members, for the Users page's search.
 *
 * Typing a name should not cost a `users.list` sweep per keystroke, so the whole
 * directory is held in memory and refreshed at most every `DIRECTORY_TTL_MS`.
 * Every page of the cursor is read (a workspace is more than one page), one
 * sweep at a time (concurrent searches share it), and a failed refresh keeps
 * serving the last good list rather than emptying the dropdown.
 */
import { searchMembers, type SlackMember } from "../domain/slackMembers.ts";
import type { Clock } from "./ports.ts";

export const DIRECTORY_TTL_MS = 10 * 60_000;
/** A runaway guard on the cursor loop, not a size anyone expects to reach. */
const MAX_PAGES = 50;

/** One page of `users.list`. */
export type MemberPage = { readonly members: readonly SlackMember[]; readonly nextCursor?: string };

export type SlackDirectoryDeps = {
  readonly clock: Clock;
  readonly listMembers: (cursor?: string) => Promise<MemberPage>;
  readonly ttlMs?: number;
};

export type SlackDirectory = {
  /** People matching `query`, best first. Throws only when no list was ever read. */
  readonly search: (query: string, limit: number) => Promise<SlackMember[]>;
};

export const createSlackDirectory = (deps: SlackDirectoryDeps): SlackDirectory => {
  const ttl = deps.ttlMs ?? DIRECTORY_TTL_MS;
  let members: readonly SlackMember[] | undefined;
  let readAt = 0;
  let inFlight: Promise<readonly SlackMember[]> | undefined;

  const sweep = async (): Promise<readonly SlackMember[]> => {
    const all: SlackMember[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await deps.listMembers(cursor);
      all.push(...res.members);
      cursor = res.nextCursor || undefined;
      if (!cursor) break;
    }
    return all;
  };

  const current = async (): Promise<readonly SlackMember[]> => {
    if (members && deps.clock() - readAt < ttl) return members;
    inFlight ??= sweep()
      .then((list) => {
        members = list;
        readAt = deps.clock();
        return list;
      })
      .catch((e: unknown) => {
        // Stale beats empty; only a directory never read has nothing to show.
        if (members) {
          readAt = deps.clock();
          return members;
        }
        throw e;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };

  return {
    search: async (query, limit) => (query.trim() ? searchMembers(await current(), query, limit) : []),
  };
};
