import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SCRIPT = join(import.meta.dir, "..", "..", "bin", "slack-read.sh");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

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

/**
 * A stand-in `curl` on PATH answering conversations.replies and users.info from
 * fixtures, and logging every users.info call so the one-lookup-per-id cache
 * can be asserted.
 */
const fakeCurl = (thread: unknown = THREAD) => {
  const dir = mkdtempSync(join(tmpdir(), "slack-read-test-"));
  dirs.push(dir);
  writeFileSync(join(dir, "thread.json"), JSON.stringify(thread));
  for (const [id, body] of Object.entries(USERS)) writeFileSync(join(dir, `${id}.json`), JSON.stringify(body));
  writeFileSync(
    join(dir, "curl"),
    `#!/usr/bin/env bash
args="$*"
case "$args" in
  *conversations.replies*) cat "${dir}/thread.json" ;;
  *users.info*)
    id=$(printf '%s' "$args" | grep -oE 'user=[A-Z0-9]+' | cut -d= -f2)
    echo "$id" >> "${dir}/lookups.txt"
    cat "${dir}/$id.json" ;;
  *) echo '{"ok":false,"error":"unexpected"}' ;;
esac
`,
    { mode: 0o755 },
  );
  return dir;
};

const replies = async (dir: string) => {
  const proc = Bun.spawn({
    cmd: ["bash", SCRIPT, "replies", "C1", "1.1"],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, SLACK_BOT_TOKEN: "xoxb-test", PATH: `${dir}:${process.env.PATH}` },
  });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  expect(code).toBe(0);
  return JSON.parse(stdout) as { messages: { user: string; user_name?: string; text: string }[] };
};

describe("slack-read.sh names every user id", () => {
  test("each message carries the author's name, not just the id", async () => {
    // the failure this exists for: the thread showed only U0ALEX00001 and the
    // bot guessed a name from memory for U0ALEX00001
    const { messages } = await replies(fakeCurl());
    expect(messages[0]!.user_name).toBe("Alex Example");
    expect(messages[1]!.user_name).toBe("Jarvis");
  });

  test("mentions in the text read <@U…:name>, labelled ones included", async () => {
    const { messages } = await replies(fakeCurl());
    expect(messages[1]!.text).toBe("looking, <@U0ALEX00001:Alex Example> - cc <@U0OWNER0001:Kai>");
  });

  test("an id users.info will not answer for stays as it is, never guessed", async () => {
    const { messages } = await replies(fakeCurl());
    expect(messages[2]!.user_name).toBeUndefined();
    expect(messages[2]!.text).toBe("ping <@U0GONE00000>");
  });

  test("each id is looked up once however often it appears", async () => {
    const dir = fakeCurl();
    await replies(dir);
    const lookups = readFileSync(join(dir, "lookups.txt"), "utf8").trim().split("\n");
    expect(lookups.sort()).toEqual(["U0ALEX00001", "U0BOT000001", "U0GONE00000", "U0OWNER0001"]);
  });

  test("a read past ARG_MAX still comes back whole and named", async () => {
    // round-1 review: with the payload in the env, a ~1.2MB read failed at exec
    // with "Argument list too long" and printed nothing
    const big = {
      ok: true,
      messages: Array.from({ length: 400 }, (_, i) => ({ user: "U0ALEX00001", ts: `1.${i}`, text: "x".repeat(3000) })),
    };
    const { messages } = await replies(fakeCurl(big));
    expect(messages).toHaveLength(400);
    expect(messages[399]!.user_name).toBe("Alex Example");
  });
});
