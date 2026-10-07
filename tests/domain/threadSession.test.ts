import { describe, expect, test } from "bun:test";
import { isAuthFailure, isMissingSession, isTimeout, tierOf, unseenTurns } from "../../src/domain/threadSession.ts";
import type { StoredMessage } from "../../src/domain/types.ts";

const turn = (ts: string, content = ts): StoredMessage => ({
  id: Number(ts),
  channelId: "C1",
  slackUserId: "U1",
  role: "user",
  content,
  createdAt: Number(ts) * 1000,
  slackTs: ts,
  threadTs: "1",
});

describe("tierOf", () => {
  test("full access and sandbox are different pools", () => {
    // they run in different working directories, and the CLI files a session
    // under the directory it ran in - one could not resume the other regardless
    expect(tierOf({ skipPermissions: true })).toBe("full");
    expect(tierOf({ skipPermissions: false })).toBe("sandbox");
    expect(tierOf(undefined)).toBe("sandbox");
  });
});

describe("unseenTurns", () => {
  const history = [turn("1"), turn("2"), turn("3"), turn("4")];

  test("hands over only what was said after the session's last turn", () => {
    expect(unseenTurns(history, "2").map((m) => m.slackTs)).toEqual(["3", "4"]);
  });

  test("everything said while the bot was not addressed still reaches it", () => {
    // the point: a thread carries on between mentions, and a resumed session
    // would otherwise never learn what was said in between
    expect(unseenTurns(history, "1")).toHaveLength(3);
  });

  test("an unknown marker sends the newest turn only, never the thread twice", () => {
    expect(unseenTurns(history, "").map((m) => m.slackTs)).toEqual(["4"]);
    expect(unseenTurns(history, "99").map((m) => m.slackTs)).toEqual(["4"]);
  });

  test("a marker on the newest turn still sends that turn", () => {
    // re-running the same message must not send an empty prompt
    expect(unseenTurns(history, "4").map((m) => m.slackTs)).toEqual(["4"]);
  });

  test("no history, nothing to send", () => {
    expect(unseenTurns([], "1")).toEqual([]);
  });
});

describe("isMissingSession", () => {
  test("recognises the CLI saying the session is gone", () => {
    expect(isMissingSession(new Error("No conversation found with session ID abc"))).toBe(true);
    expect(isMissingSession(new Error("Session not found"))).toBe(true);
    expect(isMissingSession(new Error("session abc does not exist"))).toBe(true);
  });

  test("does not swallow a real failure as a missing session", () => {
    expect(isMissingSession(new Error("claude CLI exited with code 1: rate limited"))).toBe(false);
    expect(isMissingSession(new Error("boom"))).toBe(false);
    expect(isMissingSession(undefined)).toBe(false);
  });
});

describe("isTimeout", () => {
  test("143 is the adapter's own timeout reaping the turn", () => {
    expect(isTimeout(new Error("claude CLI exited with code 143: no output"))).toBe(true);
  });

  test("any other failure is a failure, and must not be excused as slowness", () => {
    expect(isTimeout(new Error("claude CLI exited with code 1: rate limited"))).toBe(false);
    expect(isTimeout(new Error("No conversation found with session ID x"))).toBe(false);
    expect(isTimeout(undefined)).toBe(false);
  });
});

describe("isAuthFailure", () => {
  test("recognises a credential that will not authenticate", () => {
    expect(isAuthFailure(new Error("Failed to authenticate. API Error: 401 OAuth access token is invalid."))).toBe(true);
    expect(isAuthFailure(new Error("claude CLI exited with code 1: OAuth token is invalid"))).toBe(true);
  });

  test("does not excuse an ordinary failure as a lapsed login", () => {
    expect(isAuthFailure(new Error("claude CLI exited with code 143: no output"))).toBe(false);
    expect(isAuthFailure(new Error("rate limited"))).toBe(false);
    expect(isAuthFailure(undefined)).toBe(false);
  });
});
