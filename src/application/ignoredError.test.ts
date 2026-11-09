import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { ignoreQuietly, logAndIgnore } from "./ignoredError.ts";

let warn: ReturnType<typeof spyOn>;
let debug: ReturnType<typeof spyOn>;
const saved = process.env.JARVIS_DEBUG;

beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
  debug = spyOn(console, "debug").mockImplementation(() => {});
  delete process.env.JARVIS_DEBUG;
});
afterEach(() => {
  warn.mockRestore();
  debug.mockRestore();
  if (saved === undefined) delete process.env.JARVIS_DEBUG;
  else process.env.JARVIS_DEBUG = saved;
});

test("logAndIgnore warns with the context and the error, and resolves undefined", async () => {
  const out = await Promise.reject(new Error("boom")).catch(logAndIgnore("post dm"));
  expect(out).toBeUndefined();
  expect(warn).toHaveBeenCalledWith("[ignored] post dm: boom");
});

test("logAndIgnore returns the fallback and copes with non-Error rejections", async () => {
  const out = await Promise.reject("nope").catch(logAndIgnore("list ids", [] as string[]));
  expect(out).toEqual([]);
  expect(warn).toHaveBeenCalledWith("[ignored] list ids: nope");
});

test("ignoreQuietly is silent unless JARVIS_DEBUG is set", async () => {
  await Promise.reject(new Error("gone")).catch(ignoreQuietly("remove placeholder"));
  expect(debug).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
  process.env.JARVIS_DEBUG = "1";
  const out = await Promise.reject(new Error("gone")).catch(ignoreQuietly("remove placeholder", "x"));
  expect(out).toBe("x");
  expect(debug).toHaveBeenCalledWith("[ignored] remove placeholder: gone");
});
