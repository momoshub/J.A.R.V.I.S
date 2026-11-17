import { describe, expect, test } from "bun:test";
import { SLACK_PROXY_METHODS, TOP_LEVEL_THREAD, checkSlackCall, isSlackFileUrl } from "../../src/domain/slackProxy.ts";

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

  describe("a turn in a thread posts into it by default", () => {
    const inThread = { channel: "C0TEST00001", threadTs: "1700000000.000100" };
    const post = (params: Record<string, string>, scope = inThread) => {
      const call = checkSlackCall("chat.postMessage", { channel: scope.channel, ...params }, scope);
      if (!call.ok) throw new Error(call.error);
      return call.params;
    };

    test("chat.postMessage with no thread_ts gets the turn's thread", () => {
      expect(post({ text: "done" })).toEqual({ channel: "C0TEST00001", text: "done", thread_ts: "1700000000.000100" });
    });

    test("files.completeUploadExternal with no thread_ts gets it too", () => {
      const call = checkSlackCall("files.completeUploadExternal", { channel_id: inThread.channel, files: "[]" }, inThread);
      expect(call.ok && call.params.thread_ts).toBe("1700000000.000100");
    });

    test("a blank thread_ts counts as not given", () => {
      expect(post({ text: "done", thread_ts: "" }).thread_ts).toBe("1700000000.000100");
      expect(post({ text: "done", thread_ts: "  " }).thread_ts).toBe("1700000000.000100");
    });

    test("an explicit thread_ts is kept, even another thread of the same channel", () => {
      expect(post({ text: "done", thread_ts: "1600000000.000200" }).thread_ts).toBe("1600000000.000200");
    });

    test("thread_ts=none posts at the top level and is stripped before Slack", () => {
      const params = post({ text: "heads up", thread_ts: TOP_LEVEL_THREAD });
      expect(params).toEqual({ channel: "C0TEST00001", text: "heads up" });
      expect("thread_ts" in params).toBe(false);
      const upload = checkSlackCall("files.completeUploadExternal", { channel_id: inThread.channel, thread_ts: "none" }, inThread);
      expect(upload.ok && "thread_ts" in upload.params).toBe(false);
    });

    test("a turn that is not in a thread is left alone", () => {
      expect(post({ text: "hi" }, own as typeof inThread)).toEqual({ channel: "C0TEST00001", text: "hi" });
    });

    test("only new posts are defaulted: updates, reactions and reads pass through untouched", () => {
      for (const [method, params] of [
        ["chat.update", { channel: inThread.channel, ts: "1.1", text: "x" }],
        ["reactions.add", { channel: inThread.channel, timestamp: "1.1", name: "eyes" }],
        ["conversations.replies", { channel: "C0OTHER0001", ts: "1.1" }],
      ] as const) {
        const call = checkSlackCall(method, params, inThread);
        expect(call.ok && call.params).toEqual(params);
      }
    });

    test("the channel check still comes first", () => {
      const call = checkSlackCall("chat.postMessage", { channel: "C0OTHER0001", text: "x" }, inThread);
      expect(call.ok).toBe(false);
    });
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
    expect(isSlackFileUrl("https://files.slack.com/files-tmb/T1-F1-abc/a_360.png")).toBe(true);
    for (const bad of [
      "http://files.slack.com/files-pri/T1-F1/a.png",
      "https://files.slack.com/api/anything",
      "https://files.slack.com/",
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

describe("chat.update on an approval notice", () => {
  const scope = { channel: "C0TEST00001", threadTs: "1700000000.000100" };
  const isNotice = (channel: string, ts: string) => channel === "C0TEST00001" && ts === "55.5";

  test("is refused when the message is a stored notice, even in the turn's own channel", () => {
    const call = checkSlackCall("chat.update", { channel: scope.channel, ts: "55.5", text: "Dismiss" }, scope, isNotice);
    expect(call).toMatchObject({ ok: false, status: 403 });
    expect(!call.ok && call.error).toContain("message_not_allowed");
  });

  test("the turn's own messages are still editable", () => {
    const params = { channel: scope.channel, ts: "56.6", text: "progress 2/3" };
    const call = checkSlackCall("chat.update", params, scope, isNotice);
    expect(call.ok && call.params).toEqual(params);
  });

  test("other writes and reads on a notice's ts are not affected", () => {
    expect(checkSlackCall("reactions.add", { channel: scope.channel, timestamp: "55.5", name: "eyes" }, scope, isNotice).ok).toBe(true);
    expect(checkSlackCall("conversations.replies", { channel: scope.channel, ts: "55.5" }, scope, isNotice).ok).toBe(true);
  });
});

describe("chat.update outside the turn's channel", () => {
  const owner = { channel: "C0TEST00001", threadTs: "1700000000.000100", owner: true };
  const member = { channel: "C0TEST00001", threadTs: "1700000000.000100" };
  const away = { channel: "C0OTHER0001", ts: "77.7", text: "fixed" };

  test("an owner's turn passes it through, marked so the proxy checks who wrote the message", () => {
    const call = checkSlackCall("chat.update", away, owner);
    expect(call.ok && call.ownMessageIn).toEqual({ channel: "C0OTHER0001", ts: "77.7" });
    expect(call.ok && call.params).toEqual(away);
  });

  test("a turn that is not the owner's keeps the channel rule", () => {
    const call = checkSlackCall("chat.update", away, member);
    expect(call).toMatchObject({ ok: false, status: 403 });
    expect(!call.ok && call.error).toContain("channel_not_allowed");
  });

  test("the same channel is unchanged and needs no lookup", () => {
    const call = checkSlackCall("chat.update", { channel: owner.channel, ts: "77.7", text: "x" }, owner);
    expect(call.ok && call.ownMessageIn).toBeUndefined();
  });

  test("an owner's other writes keep the turn-channel rule", () => {
    for (const [method, param] of [
      ["chat.postMessage", "channel"],
      ["reactions.add", "channel"],
      ["files.completeUploadExternal", "channel_id"],
    ] as const) {
      const call = checkSlackCall(method, { [param]: "C0OTHER0001", text: "hi", ts: "77.7" }, owner);
      expect(call.ok).toBe(false);
    }
  });

  test("it needs a message to point at, and a stored notice elsewhere stays untouchable", () => {
    expect(checkSlackCall("chat.update", { channel: "C0OTHER0001", text: "x" }, owner).ok).toBe(false);
    const isNotice = (channel: string, ts: string) => channel === "C0OTHER0001" && ts === "77.7";
    const call = checkSlackCall("chat.update", away, owner, isNotice);
    expect(!call.ok && call.error).toContain("message_not_allowed");
  });
});
