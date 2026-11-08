import { describe, expect, test } from "bun:test";
import { axisTicks, niceMax } from "../../web/src/ui/chartScale.ts";

describe("chart scale", () => {
  test("niceMax rounds up to 1/2/5 x 10^k", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(3)).toBe(5);
    expect(niceMax(380)).toBe(500);
    expect(niceMax(0.3)).toBe(0.5);
    expect(niceMax(1000)).toBe(1000);
  });

  test("a count axis never labels a half", () => {
    expect(axisTicks(1, true)).toEqual([0, 1]);
    expect(axisTicks(5, true)).toEqual([0, 5]);
    expect(axisTicks(500, true)).toEqual([0, 250, 500]);
    expect(axisTicks(5, false)).toEqual([0, 2.5, 5]);
  });
});
