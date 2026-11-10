/**
 * One turn at a time, per thread.
 *
 * Every Slack message used to spawn its own run with no idea another was in
 * flight. Ask for something, add "do all" three minutes later, and two runs do
 * the same work in parallel: two branches, two implementations, two pull
 * requests for one task. Neither could see the other, so neither was wrong.
 *
 * It is also required by the session model. A thread holds ONE CLI session, and
 * two `--resume` processes on one session id at the same moment are two
 * conversations writing over each other's history.
 *
 * So turns queue behind each other. The second message then runs with the
 * first's result already in the session, which is what makes "do all" mean "and
 * the rest" rather than "again, from scratch".
 *
 * Commands are deliberately NOT serialised here: a review is its own process
 * with its own session, and queueing one behind a long chat turn would make it
 * look dead.
 */

export type ThreadQueue = {
  /** Run `task` after anything already queued for `key`. */
  run: <T>(key: string, task: () => Promise<T>) => Promise<T>;
  /** How many turns are waiting or running for `key`, for callers that wait on a thread (workflow checks). */
  depth: (key: string) => number;
};

export const createThreadQueue = (): ThreadQueue => {
  // The tail of each thread's chain, plus how deep it is. Entries are removed as
  // chains drain, so an idle bot holds nothing.
  const tails = new Map<string, Promise<unknown>>();
  const depths = new Map<string, number>();

  const run = <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const depth = (depths.get(key) ?? 0) + 1;
    depths.set(key, depth);

    // A failed turn must not break the chain: the next one still gets to run,
    // which is the whole point of queueing rather than refusing.
    const prev = tails.get(key) ?? Promise.resolve();
    const result = prev.then(task, task);

    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, settled);
    void settled.then(() => {
      const left = (depths.get(key) ?? 1) - 1;
      if (left <= 0) {
        depths.delete(key);
        // Only clear the tail if nothing else has queued behind us since.
        if (tails.get(key) === settled) tails.delete(key);
      } else {
        depths.set(key, left);
      }
    });

    return result;
  };

  return { run, depth: (key) => depths.get(key) ?? 0 };
};
