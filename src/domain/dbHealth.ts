/**
 * Telling a broken database handle apart from an ordinary query failure.
 *
 * A database file inside the git checkout (the old `data/*.db`, still the case
 * until `DATABASE_PATH` points elsewhere) can be replaced by a `git stash`,
 * `checkout` or `reset` while the bot holds it open. SQLite then
 * answers every call on the old handle with SQLITE_IOERR_VNODE, and nothing
 * short of reopening the file fixes that - so the bot restarts once idle.
 */
export const isDbFileSwapped = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as { code?: unknown }).code === "SQLITE_IOERR_VNODE";
