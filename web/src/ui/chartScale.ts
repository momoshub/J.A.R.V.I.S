/**
 * Axis maths for `charts.tsx`, kept free of JSX so it can be tested directly.
 */

/** The smallest 1/2/5 x 10^k at or above `v`, so gridlines land on round numbers. */
export const niceMax = (v: number): number => {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 5, 10].find((m) => m * p >= v) ?? 10) * p;
};

/**
 * Gridline values for an axis topped at `max`. A count axis never shows a
 * half: with a max of 1 or 5 the middle line would read "1" or "3" while
 * sitting at 0.5 or 2.5, so it is left out.
 */
export const axisTicks = (max: number, integer: boolean): number[] => {
  const mid = max / 2;
  return integer && !Number.isInteger(mid) ? [0, max] : [0, mid, max];
};
