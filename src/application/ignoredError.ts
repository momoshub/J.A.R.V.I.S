/**
 * Named handlers for failures we deliberately carry on past (`.catch(...)`, a
 * best-effort `catch`). Nothing here throws and both return a fallback, so
 * swapping one in for `() => undefined` keeps behaviour and adds a trace.
 *
 * - `logAndIgnore`   : the failure is unexpected - warn with what failed + why.
 * - `ignoreQuietly`  : the failure is expected and harmless (best-effort
 *                      cleanup, a file that is not there yet) - debug only,
 *                      printed when `JARVIS_DEBUG` is set.
 */
const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Warn `[ignored] <context>: <error>`, then resolve to `fallback` (default `undefined`). */
export const logAndIgnore =
  <T = undefined>(context: string, fallback?: T) =>
  (err: unknown): T => {
    console.warn(`[ignored] ${context}: ${reason(err)}`);
    return fallback as T;
  };

/** Debug-log `[ignored] <context>: <error>` (only with `JARVIS_DEBUG`), then resolve to `fallback`. */
export const ignoreQuietly =
  <T = undefined>(context: string, fallback?: T) =>
  (err: unknown): T => {
    if (process.env.JARVIS_DEBUG) console.debug(`[ignored] ${context}: ${reason(err)}`);
    return fallback as T;
  };
