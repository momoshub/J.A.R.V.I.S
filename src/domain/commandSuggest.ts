/**
 * What someone probably meant.
 *
 * People guess commands by intuition and the bot used to answer every guess
 * with the same flat line - `I do not recognise X. Try help.` - which is
 * technically true and useless. The log is full of near misses that a single
 * character would have fixed: `hel[`, `bomp`, `approvel`, `who` for `whoami`,
 * `learns` for `learn`. Each one is somebody who knew what they wanted and was
 * sent to read a list of forty commands to find it again.
 *
 * Suggesting is cheap and never guesses on the bot's behalf: it names the near
 * match, it does not run it.
 */

/** Edit distance, bounded - anything past `max` is "not close" and stops early. */
export const editDistance = (a: string, b: string, max = 3): number => {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
      row[j] = v;
      if (v < best) best = v;
    }
    if (best > max) return max + 1; // every path through this row is already too far
    prev = row;
  }
  return prev[b.length] ?? max + 1;
};

/** How far a typo may be from a real name before it stops being a typo. */
const NEAR = 2;

/**
 * The closest command name to what was typed, or undefined when nothing is
 * close. A prefix wins outright: somebody typing `app` has not made a mistake,
 * they have stopped typing.
 */
export const nearestCommand = (typed: string, names: readonly string[]): string | undefined => {
  const t = typed.trim().toLowerCase();
  if (!t) return undefined;
  const exact = names.find((n) => n === t);
  if (exact) return undefined; // it is not a near miss, it is the thing itself
  const prefixes = names.filter((n) => n.startsWith(t) || t.startsWith(n)).sort((a, b) => a.length - b.length);
  if (prefixes[0]) return prefixes[0];
  // Short names are mostly consonants; two edits away from `add` is a different
  // command, not a slip. Scale the tolerance to what was typed.
  const max = t.length <= 4 ? 1 : NEAR;
  let best: { name: string; d: number } | undefined;
  for (const n of names) {
    const d = editDistance(t, n, max);
    if (d > max) continue;
    if (!best || d < best.d) best = { name: n, d };
  }
  return best?.name;
};
