import { describe, expect, test } from "bun:test";
import { SLACK_PROXY_METHODS, checkSlackCall, isSlackFileUrl } from "../../src/domain/slackProxy.ts";

const own = { channel: "C0TEST00001" };

describe("Slack proxy policy", () => {
  test("every allowlisted read passes, in any channel", () => {
    for (const method of SLACK_PROXY_METHODS.read) {
      const call = checkSlackCall(method, { channel: "C0OTHER0001" }, own);
      expect(call.ok).toBe(true);
    }
  });

  test("a method that is not on the allowlist is refused", () => {
    for (const method of ["chat.delete", "conversations.invite", "conversations.archive", "auth.test", "admin.users.remove", "users.list", "files.delete", "chat.scheduleMessage", "views.open", "usergroups.update"]) {
      const call = checkSlackCall(method, { channel: own.channel }, own);
      expect(call.ok).toBe(false);
      if (!call.ok) {
        expect(call.status).toBe(403);
        expect(call.error).toContain("method_not_allowed");
      }
    }
  });

  test("a prototype-chain name is not a method", () => {
    expect(checkSlackCall("constructor", {}, own).ok).toBe(false);
    expect(checkSlackCall("toString", {}, own).ok).toBe(false);
    expect(checkSlackCall("__proto__", {}, own).ok).toBe(false);
  });

  test("a write is scoped to the channel the turn runs in", () => {
    for (const [method, param] of [
      ["chat.postMessage", "channel"],
      ["chat.update", "channel"],
      ["reactions.add", "channel"],
      ["files.completeUploadExternal", "channel_id"],
    ] as const) {
      expect(checkSlackCall(method, { [param]: own.channel, text: "hi" }, own).ok).toBe(true);
      const elsewhere = checkSlackCall(method, { [param]: "C0OTHER0001", text: "hi" }, own);
      expect(elsewhere.ok).toBe(false);
      if (!elsewhere.ok) expect(elsewhere.error).toContain("channel_not_allowed");
      // no channel at all is not a way around it
      expect(checkSlackCall(method, { text: "hi" }, own).ok).toBe(false);
    }
  });

  test("a read-only ticket cannot write at all", () => {
    for (const method of SLACK_PROXY_METHODS.write) {
      const call = checkSlackCall(method, { channel: "C0TEST00001", channel_id: "C0TEST00001" }, {});
      expect(call.ok).toBe(false);
      if (!call.ok) expect(call.error).toContain("read_only_ticket");
    }
    expect(checkSlackCall("conversations.history", { channel: "C1" }, {}).ok).toBe(true);
  });

  test("the token is never taken from the caller, and file shares cannot fan out", () => {
    expect(checkSlackCall("users.info", { user: "U1", token: "xoxb-mine" }, own).ok).toBe(false);
    const fan = checkSlackCall("files.completeUploadExternal", { channel_id: own.channel, channels: "C0OTHER0001", files: "[]" }, own);
    expect(fan.ok).toBe(false);
  });

  test("listing is the public directory, not DMs and private groups", () => {
    expect(checkSlackCall("conversations.list", { types: "public_channel" }, own).ok).toBe(true);
    expect(checkSlackCall("conversations.list", {}, own).ok).toBe(true);
    expect(checkSlackCall("conversations.list", { types: "im,mpim,private_channel" }, own).ok).toBe(false);
  });

  test("parameters must be flat strings with sane names", () => {
    expect(checkSlackCall("users.info", { user: { nested: true } }, own).ok).toBe(false);
    expect(checkSlackCall("users.info", ["U1"], own).ok).toBe(false);
    expect(checkSlackCall("users.info", { "bad name": "x" }, own).ok).toBe(false);
    expect(checkSlackCall("users.info", { user: 7 as unknown as string }, own)).toEqual({ ok: true, method: "users.info", params: { user: "7" } });
    expect(checkSlackCall(undefined, {}, own).ok).toBe(false);
    expect(checkSlackCall("users.info", { text: "x".repeat(1_100_000) }, own).ok).toBe(false);
  });

  test("only Slack's own file urls are fetched", () => {
    expect(isSlackFileUrl("https://files.slack.com/files-pri/T1-F1/a.png")).toBe(true);
    expect(isSlackFileUrl("https://acme.slack.com/files-pri/T1-F1/a.png")).toBe(true);
    for (const bad of [
      "http://files.slack.com/files-pri/T1-F1/a.png",
      "https://files.slack.com.evil.example/a.png",
      "https://evil.example/files.slack.com/a.png",
      "https://acme.slack.com/messages/C1",
      "https://user:pw@files.slack.com/a.png",
      "https://files.slack.com:8443/a.png",
      "file:///etc/passwd",
      "not a url",
      undefined,
    ]) {
      expect(isSlackFileUrl(bad)).toBe(false);
    }
  });
});
