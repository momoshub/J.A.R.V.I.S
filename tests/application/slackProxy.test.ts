import { describe, expect, test } from "bun:test";
import { SELF_POST_NOTE, capBytes, createSlackProxy } from "../../src/application/slackProxy.ts";
import { createSlackTickets } from "../../src/application/slackTickets.ts";
import { createSelfPosts } from "../../src/application/selfPosts.ts";

const BOT_TOKEN = "xoxb-the-bots-own-token";

type Seen = { url: string; init: RequestInit };

const setup = (
  answer: (url: string, init: RequestInit) => Response | Promise<Response> = () => Response.json({ ok: true }),
  isNotice?: (channel: string, ts: string) => boolean,
) => {
  const seen: Seen[] = [];
  const tickets = createSlackTickets(() => 0);
  const logs: string[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return answer(String(url), init ?? {});
  }) as typeof fetch;
  const proxy = createSlackProxy({ tickets, botToken: BOT_TOKEN, isNotice, fetchFn, log: (l) => logs.push(l) });
  return { proxy, tickets, seen, logs };
};

describe("Slack proxy and approval notices", () => {
  const notices = new Set(["C0TEST00001:55.5"]);
  const lookup = (channel: string, ts: string) => notices.has(`${channel}:${ts}`);

  test("refuses a turn's chat.update on a notice without calling Slack, and logs only who and why", async () => {
    const { proxy, tickets, seen, logs } = setup(undefined, lookup);
    const ticket = tickets.issue({ channel: "C0TEST00001", threadTs: "1.1" });
    const answer = await proxy.call({ ticket, method: "chat.update", params: { channel: "C0TEST00001", ts: "55.5", text: "Dismiss" } });
    expect(answer.status).toBe(403);
    expect(JSON.parse(answer.body).error).toContain("message_not_allowed");
    expect(seen).toHaveLength(0);
    expect(logs.join("\n")).not.toContain("Dismiss");
  });

  test("a normal turn's chat.update of its own non-notice message still goes to Slack", async () => {
    const { proxy, tickets, seen } = setup(undefined, lookup);
    const ticket = tickets.issue({ channel: "C0TEST00001", threadTs: "1.1" });
    const answer = await proxy.call({ ticket, method: "chat.update", params: { channel: "C0TEST00001", ts: "56.6", text: "progress 2/3" } });
    expect(answer.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(String(seen[0]!.init.body)).toBe("channel=C0TEST00001&ts=56.6&text=progress+2%2F3");
  });
});

describe("Slack proxy", () => {
  test("an allowed call is proxied with the bot's token, which the caller never supplied", async () => {
    const { proxy, tickets, seen } = setup(() => Response.json({ ok: true, messages: [{ ts: "1.1", text: "hello" }] }));
    const ticket = tickets.issue({ channel: "C0TEST00001" });
    const answer = await proxy.call({ ticket, method: "conversations.replies", params: { channel: "C0OTHER0001", ts: "1.1" } });
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toEqual({ ok: true, messages: [{ ts: "1.1", text: "hello" }] });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://slack.com/api/conversations.replies");
    expect((seen[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${BOT_TOKEN}`);
    expect(String(seen[0]!.init.body)).toBe("channel=C0OTHER0001&ts=1.1");
  });

  test("a post from a turn in a thread is sent to Slack with that thread, and none is stripped", async () => {
    const { proxy, tickets, seen } = setup();
    const ticket = tickets.issue({ channel: "C0TEST00001", threadTs: "1700000000.000100" });
    await proxy.call({ ticket, method: "chat.postMessage", params: { channel: "C0TEST00001", text: "done" } });
    await proxy.call({ ticket, method: "chat.postMessage", params: { channel: "C0TEST00001", text: "fyi", thread_ts: "none" } });
    await proxy.call({ ticket, method: "chat.postMessage", params: { channel: "C0TEST00001", text: "x", thread_ts: "1600000000.000200" } });
    expect(seen.map((s) => String(s.init.body))).toEqual([
      "channel=C0TEST00001&text=done&thread_ts=1700000000.000100",
      "channel=C0TEST00001&text=fyi",
      "channel=C0TEST00001&text=x&thread_ts=1600000000.000200",
    ]);
  });

  test("a write into the turn's own channel goes through", async () => {
    const { proxy, tickets, seen, logs } = setup();
    const ticket = tickets.issue({ channel: "C0TEST00001" });
    const answer = await proxy.call({ ticket, method: "chat.postMessage", params: { channel: "C0TEST00001", text: "done" } });
    expect(logs).toEqual(["slack proxy chat.postMessage channel=C0TEST00001"]);
    expect(JSON.parse(answer.body).ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(String(seen[0]!.init.body)).toContain("text=done");
  });

  test("a method off the allowlist is refused and never reaches Slack", async () => {
    const { proxy, tickets, seen, logs } = setup();
    const ticket = tickets.issue({ channel: "C0TEST00001" });
    const answer = await proxy.call({ ticket, method: "chat.delete", params: { channel: "C0TEST00001", ts: "1.1" } });
    expect(answer.status).toBe(403);
    expect(JSON.parse(answer.body)).toMatchObject({ ok: false });
    expect(JSON.parse(answer.body).error).toContain("method_not_allowed");
    expect(seen).toHaveLength(0);
    expect(logs.join("\n")).toContain("chat.delete");
  });

  test("a write into another channel is refused and never reaches Slack", async () => {
    const { proxy, tickets, seen } = setup();
    const ticket = tickets.issue({ channel: "C0TEST00001" });
    const answer = await proxy.call({ ticket, method: "chat.postMessage", params: { channel: "C0OTHER0001", text: "leak" } });
    expect(answer.status).toBe(403);
    expect(JSON.parse(answer.body).error).toContain("channel_not_allowed");
    expect(seen).toHaveLength(0);
  });

  test("a missing, unknown, revoked or expired ticket is refused before anything else", async () => {
    let now = 0;
    const seen: string[] = [];
    const tickets = createSlackTickets(() => now);
    const proxy = createSlackProxy({
      tickets,
      botToken: BOT_TOKEN,
      fetchFn: (async (url: string | URL | Request) => {
        seen.push(String(url));
        return Response.json({ ok: true });
      }) as typeof fetch,
    });
    const params = { channel: "C1", ts: "1.1" };
    for (const ticket of [undefined, "", "jvsl_never-issued", 42, null]) {
      const answer = await proxy.call({ ticket, method: "conversations.replies", params });
      expect(answer.status).toBe(401);
      expect(JSON.parse(answer.body).ok).toBe(false);
    }
    const revoked = tickets.issue({ channel: "C1" });
    tickets.revoke(revoked);
    expect((await proxy.call({ ticket: revoked, method: "conversations.replies", params })).status).toBe(401);
    const stale = tickets.issue({ channel: "C1" });
    now += 4 * 60 * 60_000;
    expect((await proxy.call({ ticket: stale, method: "conversations.replies", params })).status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  test("Slack's own refusal comes back unchanged, and its rate limit keeps the retry hint", async () => {
    const { proxy, tickets } = setup(() => Response.json({ ok: false, error: "channel_not_found" }));
    const ticket = tickets.issue({ channel: "C1" });
    expect(JSON.parse((await proxy.call({ ticket, method: "conversations.info", params: { channel: "CX" } })).body)).toEqual({ ok: false, error: "channel_not_found" });

    const limited = setup(() => new Response("{}", { status: 429, headers: { "retry-after": "7" } }));
    const t2 = limited.tickets.issue({ channel: "C1" });
    const answer = await limited.proxy.call({ ticket: t2, method: "conversations.info", params: { channel: "C1" } });
    expect(answer.status).toBe(429);
    expect(JSON.parse(answer.body)).toEqual({ ok: false, error: "ratelimited", retry_after: 7 });
  });

  test("Slack being unreachable is a 502 in the helpers' own shape", async () => {
    const { proxy, tickets } = setup(() => {
      throw new Error("socket hang up");
    });
    const answer = await proxy.call({ ticket: tickets.issue({ channel: "C1" }), method: "users.info", params: { user: "U1" } });
    expect(answer.status).toBe(502);
    expect(JSON.parse(answer.body).ok).toBe(false);
  });

  describe("private files", () => {
    test("a Slack file url is fetched with the bot's token and streamed back", async () => {
      const { proxy, tickets, seen } = setup(() => new Response("PNGDATA", { headers: { "content-type": "image/png", "content-length": "7" } }));
      const ticket = tickets.issue({ channel: "C1" });
      const file = await proxy.download({ ticket, url: "https://files.slack.com/files-pri/T1-F1/a.png" });
      expect(file.ok).toBe(true);
      if (file.ok) {
        expect(file.contentType).toBe("image/png");
        expect(await new Response(file.body).text()).toBe("PNGDATA");
      }
      expect((seen[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${BOT_TOKEN}`);
    });

    test("a body is capped by bytes even with no content-length, so it fails the transfer instead of ending short", async () => {
      const big = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array(60));
          c.enqueue(new Uint8Array(60));
          c.close();
        },
      });
      await expect(new Response(capBytes(big, 100)).arrayBuffer()).rejects.toThrow();
      const small = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(60)); c.close(); } });
      expect((await new Response(capBytes(small, 100)).arrayBuffer()).byteLength).toBe(60);
    });

    test("a slow body is not cut off by the header timer", async () => {
      const { proxy, tickets } = setup(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              async start(c) {
                c.enqueue(new TextEncoder().encode("part1-"));
                await Bun.sleep(150);
                c.enqueue(new TextEncoder().encode("part2"));
                c.close();
              },
            }),
          ),
      );
      const file = await proxy.download({ ticket: tickets.issue({ channel: "C1" }), url: "https://files.slack.com/files-pri/T1-F1/a.bin" });
      expect(file.ok).toBe(true);
      if (file.ok) expect(await new Response(file.body).text()).toBe("part1-part2");
    });

    test("no ticket or a url that is not Slack's never sends the token anywhere", async () => {
      const { proxy, tickets, seen } = setup();
      const ticket = tickets.issue({ channel: "C1" });
      expect(await proxy.download({ ticket: "nope", url: "https://files.slack.com/files-pri/T1-F1/a.png" })).toMatchObject({ ok: false, status: 401 });
      expect(await proxy.download({ ticket, url: "https://evil.example/a.png" })).toMatchObject({ ok: false, status: 403 });
      expect(seen).toHaveLength(0);
    });

    test("a redirect off Slack is not followed, so the token does not follow it", async () => {
      const { proxy, tickets, seen } = setup(
        () => new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } }),
      );
      const file = await proxy.download({ ticket: tickets.issue({ channel: "C1" }), url: "https://files.slack.com/files-pri/T1-F1/a.png" });
      expect(file).toMatchObject({ ok: false, status: 403 });
      expect(seen.map((s) => s.url)).toEqual(["https://files.slack.com/files-pri/T1-F1/a.png"]);
    });

    test("a redirect inside Slack is followed", async () => {
      let hop = 0;
      const { proxy, tickets, seen } = setup(() =>
        hop++ === 0
          ? new Response(null, { status: 302, headers: { location: "https://acme.slack.com/files-pri/T1-F1/a.png" } })
          : new Response("ok"),
      );
      const file = await proxy.download({ ticket: tickets.issue({ channel: "C1" }), url: "https://files.slack.com/files-pri/T1-F1/a.png" });
      expect(file.ok).toBe(true);
      expect(seen).toHaveLength(2);
    });
  });
});

describe("Slack proxy notes what a turn posts into its own thread", () => {
  const withLog = (answer: () => Response) => {
    const selfPosts = createSelfPosts();
    const tickets = createSlackTickets(() => 0);
    const fetchFn = (async () => answer()) as unknown as typeof fetch;
    const proxy = createSlackProxy({ tickets, botToken: BOT_TOKEN, selfPosts, fetchFn });
    return { proxy, tickets, selfPosts };
  };

  test("a post with no thread_ts lands in the turn's thread and is noted under the turn; its update replaces the words", async () => {
    const { proxy, tickets, selfPosts } = withLog(() => Response.json({ ok: true, ts: "5.5" }));
    const ticket = tickets.issue({ channel: "C1", threadTs: "1.1", turn: "run-1" });
    await proxy.call({ ticket, method: "chat.postMessage", params: { channel: "C1", text: "first" } });
    expect(selfPosts.posts("run-1")).toEqual([{ ts: "5.5", texts: ["first"] }]);
    await proxy.call({ ticket, method: "chat.update", params: { channel: "C1", ts: "5.5", text: "final" } });
    expect(selfPosts.posts("run-1")).toEqual([{ ts: "5.5", texts: ["final"] }]);
  });

  test("two processes of one turn share the record; another turn in the thread does not", async () => {
    let n = 0;
    const { proxy, tickets, selfPosts } = withLog(() => Response.json({ ok: true, ts: `5.${++n}` }));
    const a = tickets.issue({ channel: "C1", threadTs: "1.1", turn: "run-1" });
    const b = tickets.issue({ channel: "C1", threadTs: "1.1", turn: "run-1" });
    const other = tickets.issue({ channel: "C1", threadTs: "1.1", turn: "run-2" });
    await proxy.call({ ticket: a, method: "chat.postMessage", params: { channel: "C1", text: "from a" } });
    await proxy.call({ ticket: other, method: "chat.postMessage", params: { channel: "C1", text: "from another turn" } });
    expect(selfPosts.posts("run-1").flatMap((p) => p.texts)).toEqual(["from a"]);
    await proxy.call({ ticket: b, method: "chat.postMessage", params: { channel: "C1", text: "from b" } });
    expect(selfPosts.posts("run-1").flatMap((p) => p.texts)).toEqual(["from a", "from b"]);
  });

  test("a ticket with no turn notes nothing", async () => {
    const { proxy, tickets, selfPosts } = withLog(() => Response.json({ ok: true, ts: "5.5" }));
    const ticket = tickets.issue({ channel: "C1", threadTs: "1.1" });
    await proxy.call({ ticket, method: "chat.postMessage", params: { channel: "C1", text: "x" } });
    expect(selfPosts.posts("")).toEqual([]);
  });

  test("a top-level post, a failed post and a refused post are not noted", async () => {
    const { proxy, tickets, selfPosts } = withLog(() => Response.json({ ok: true, ts: "5.5" }));
    const ticket = tickets.issue({ channel: "C1", threadTs: "1.1", turn: "run-1" });
    await proxy.call({ ticket, method: "chat.postMessage", params: { channel: "C1", text: "x", thread_ts: "none" } });
    await proxy.call({ ticket, method: "chat.postMessage", params: { channel: "C2", text: "x" } });
    expect(selfPosts.posts("run-1")).toEqual([]);
    const failing = withLog(() => Response.json({ ok: false, error: "channel_not_found" }));
    const t2 = failing.tickets.issue({ channel: "C1", threadTs: "1.1", turn: "run-1" });
    await failing.proxy.call({ ticket: t2, method: "chat.postMessage", params: { channel: "C1", text: "x" } });
    expect(failing.selfPosts.posts("run-1")).toEqual([]);
  });

  test("a reaction or a read is not a post", async () => {
    const { proxy, tickets, selfPosts } = withLog(() => Response.json({ ok: true, ts: "5.5" }));
    const ticket = tickets.issue({ channel: "C1", threadTs: "1.1", turn: "run-1" });
    await proxy.call({ ticket, method: "reactions.add", params: { channel: "C1", timestamp: "1.1", name: "eyes" } });
    await proxy.call({ ticket, method: "conversations.replies", params: { channel: "C1", ts: "1.1" } });
    expect(selfPosts.posts("run-1")).toEqual([]);
  });

  test("a post or update into the turn's own thread gets a jarvis_note, with Slack's own fields untouched", async () => {
    const slack = { ok: true, ts: "5.5", channel: "C1", message: { text: "first", ts: "5.5" } };
    const { proxy, tickets } = withLog(() => Response.json(slack));
    const ticket = tickets.issue({ channel: "C1", threadTs: "1.1", turn: "run-1" });
    const posted = await proxy.call({ ticket, method: "chat.postMessage", params: { channel: "C1", text: "first" } });
    expect(JSON.parse(posted.body)).toEqual({ ...slack, jarvis_note: SELF_POST_NOTE });
    expect(SELF_POST_NOTE).toContain("NO_REPLY");
    const updated = await proxy.call({ ticket, method: "chat.update", params: { channel: "C1", ts: "5.5", text: "final" } });
    expect(JSON.parse(updated.body)).toEqual({ ...slack, jarvis_note: SELF_POST_NOTE });
  });

  test("no note for a failed post, a top-level post, an update of a foreign message, another call, or a ticket with no turn", async () => {
    const slack = { ok: true, ts: "5.5" };
    const { proxy, tickets } = withLog(() => Response.json(slack));
    const ticket = tickets.issue({ channel: "C1", threadTs: "1.1", turn: "run-1" });
    const top = await proxy.call({ ticket, method: "chat.postMessage", params: { channel: "C1", text: "x", thread_ts: "none" } });
    expect(JSON.parse(top.body)).toEqual(slack);
    const foreign = await proxy.call({ ticket, method: "chat.update", params: { channel: "C1", ts: "7.7", text: "x" } });
    expect(JSON.parse(foreign.body)).toEqual(slack);
    const react = await proxy.call({ ticket, method: "reactions.add", params: { channel: "C1", timestamp: "1.1", name: "eyes" } });
    expect(JSON.parse(react.body)).toEqual(slack);
    const noTurn = tickets.issue({ channel: "C1", threadTs: "1.1" });
    const plain = await proxy.call({ ticket: noTurn, method: "chat.postMessage", params: { channel: "C1", text: "x" } });
    expect(JSON.parse(plain.body)).toEqual(slack);
    const failing = withLog(() => Response.json({ ok: false, error: "channel_not_found" }));
    const t2 = failing.tickets.issue({ channel: "C1", threadTs: "1.1", turn: "run-1" });
    const failed = await failing.proxy.call({ ticket: t2, method: "chat.postMessage", params: { channel: "C1", text: "x" } });
    expect(JSON.parse(failed.body)).toEqual({ ok: false, error: "channel_not_found" });
  });

  test("a body that is not a JSON object is passed on as it is", async () => {
    const { proxy, tickets } = withLog(() => new Response("<html>"));
    const ticket = tickets.issue({ channel: "C1", threadTs: "1.1", turn: "run-1" });
    const res = await proxy.call({ ticket, method: "chat.postMessage", params: { channel: "C1", text: "x" } });
    expect(res.body).toBe("<html>");
  });
});
