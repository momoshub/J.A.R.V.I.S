import { describe, expect, test } from "bun:test";
import { capBytes, createSlackProxy } from "../../src/application/slackProxy.ts";
import { createSlackTickets } from "../../src/application/slackTickets.ts";

const BOT_TOKEN = "xoxb-the-bots-own-token";

type Seen = { url: string; init: RequestInit };

const setup = (answer: (url: string, init: RequestInit) => Response | Promise<Response> = () => Response.json({ ok: true })) => {
  const seen: Seen[] = [];
  const tickets = createSlackTickets(() => 0);
  const logs: string[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return answer(String(url), init ?? {});
  }) as typeof fetch;
  const proxy = createSlackProxy({ tickets, botToken: BOT_TOKEN, fetchFn, log: (l) => logs.push(l) });
  return { proxy, tickets, seen, logs };
};

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
