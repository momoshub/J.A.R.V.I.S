import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";

// every Slack call is its own helper process (bash, python, curl), and the box is shared
setDefaultTimeout(30_000);

const SCRIPT = join(import.meta.dir, "..", "..", "bin", "slack-read.sh");

const THREAD = {
  ok: true,
  messages: [
    { user: "U0ALEX00001", ts: "1.1", text: "why does the 2-year range OOM?" },
    { user: "U0BOT000001", ts: "1.2", text: "looking, <@U0ALEX00001> - cc <@U0OWNER0001|kai>" },
    { user: "U0GONE00000", ts: "1.3", text: "ping <@U0GONE00000>" },
  ],
};

const USERS: Record<string, unknown> = {
  U0ALEX00001: { ok: true, user: { real_name: "Alex Example", profile: { display_name: "", real_name: "Alex Example" } } },
  U0BOT000001: { ok: true, user: { profile: { display_name: "Jarvis" } } },
  U0OWNER0001: { ok: true, user: { profile: { display_name: "Kai" } } },
  U0GONE00000: { ok: false, error: "user_not_found" },
};

const TICKET = "jvsl_test-ticket";

/**
 * A stand-in for the bot's Slack proxy: a local server answering conversations.replies and users.info from
 * fixtures, and logging every users.info call so the one-lookup-per-id cache can be asserted. The helper holds
 * a ticket, never a token, so this is the only thing it can talk to.
 */
const fakeProxy = (thread: unknown = THREAD) => {
  const lookups: string[] = [];
  const tickets: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const { ticket, method, params } = (await req.json()) as { ticket: unknown; method: string; params: Record<string, string> };
      tickets.push(ticket);
      if (method === "conversations.replies") return Response.json(thread);
      if (method === "users.info") {
        lookups.push(params.user ?? "");
        return Response.json(USERS[params.user ?? ""] ?? { ok: false, error: "user_not_found" });
      }
      return Response.json({ ok: false, error: "unexpected" });
    },
  });
  return { server, lookups, tickets, url: `http://127.0.0.1:${server.port}/api/slack` };
};

const replies = async (proxy: ReturnType<typeof fakeProxy>) => {
  const proc = Bun.spawn({
    cmd: ["bash", SCRIPT, "replies", "C1", "1.1"],
    stdout: "pipe",
    stderr: "pipe",
    // no bot token in this environment: the only thing the helper has is the ticket
    env: { ...process.env, SLACK_BOT_TOKEN: undefined, JARVIS_SLACK_TICKET: TICKET, JARVIS_SLACK_API_URL: proxy.url },
  });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  expect(code).toBe(0);
  return JSON.parse(stdout) as { messages: { user: string; user_name?: string; text: string }[] };
};

let current: ReturnType<typeof fakeProxy> | undefined;
const proxyFor = (thread?: unknown) => (current = fakeProxy(thread));
afterEach(() => current?.server.stop(true));

describe("slack-read.sh names every user id", () => {
  test("each message carries the author's name, not just the id", async () => {
    // the failure this exists for: the thread showed only U0ALEX00001 and the
    // bot guessed a name from memory for U0ALEX00001
    const { messages } = await replies(proxyFor());
    expect(messages[0]!.user_name).toBe("Alex Example");
    expect(messages[1]!.user_name).toBe("Jarvis");
  });

  test("mentions in the text read <@U…:name>, labelled ones included", async () => {
    const { messages } = await replies(proxyFor());
    expect(messages[1]!.text).toBe("looking, <@U0ALEX00001:Alex Example> - cc <@U0OWNER0001:Kai>");
  });

  test("an id users.info will not answer for stays as it is, never guessed", async () => {
    const { messages } = await replies(proxyFor());
    expect(messages[2]!.user_name).toBeUndefined();
    expect(messages[2]!.text).toBe("ping <@U0GONE00000>");
  });

  test("each id is looked up once however often it appears", async () => {
    const proxy = proxyFor();
    await replies(proxy);
    expect([...proxy.lookups].sort()).toEqual(["U0ALEX00001", "U0BOT000001", "U0GONE00000", "U0OWNER0001"]);
    // every call, the reads and the lookups, presented this turn's ticket and nothing else
    expect(new Set(proxy.tickets)).toEqual(new Set([TICKET]));
  });

  test("a read past ARG_MAX still comes back whole and named", async () => {
    // round-1 review: with the payload in the env, a ~1.2MB read failed at exec
    // with "Argument list too long" and printed nothing
    const big = {
      ok: true,
      messages: Array.from({ length: 400 }, (_, i) => ({ user: "U0ALEX00001", ts: `1.${i}`, text: "x".repeat(3000) })),
    };
    const { messages } = await replies(proxyFor(big));
    expect(messages).toHaveLength(400);
    expect(messages[399]!.user_name).toBe("Alex Example");
  });
});
