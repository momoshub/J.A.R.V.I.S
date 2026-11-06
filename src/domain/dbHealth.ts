/**
 * Telling a broken database handle apart from an ordinary query failure.
 *
 * `data/jarvis.db` is committed to git, so a `git stash`, `checkout` or `reset`
 * in this repo can replace the file while the bot holds it open. SQLite then
 * answers every call on the old handle with SQLITE_IOERR_VNODE, and nothing
 * short of reopening the file fixes that - so the bot restarts once idle.
 */
export const isDbFileSwapped = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as { code?: unknown }).code === "SQLITE_IOERR_VNODE";
