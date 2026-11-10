import { beforeEach, describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createUserRepo } from "../../src/infrastructure/db/userRepo.ts";
import { createMessageRepo } from "../../src/infrastructure/db/messageRepo.ts";
import { createSettingsRepo, SETTING_KEYS } from "../../src/infrastructure/db/settingsRepo.ts";
import { createCloudwatchRepo } from "../../src/infrastructure/db/cloudwatchRepo.ts";
import { dispatchCommand, type CommandDeps } from "../../src/application/commands.ts";
import { decideCloudwatch, type CloudwatchDeps, type CloudwatchPort } from "../../src/application/cloudwatch.ts";
import { CANCEL_ACTION, CONFIRM_ACTION, CONFIRM_TTL_MS, type CloudwatchRequest, type QueryResult } from "../../src/domain/cloudwatch.ts";
import type { AllowedUser, UserRole } from "../../src/domain/types.ts";
import type { InteractiveAction, SlackAdminPort } from "../../src/application/slackAdmin.ts";

const OWNER = "UOWNER001";
const ADMIN = "UADMIN001";
const EXEC = "UEXEC0001";
const PAL = "UPAL00001";
const NOW0 = Date.parse("2026-11-10T10:00:00Z");
const GROUP = "/ecs/prod-api-2";
const DAY = 86_400_000;

const user = (slackId: string, role: UserRole): AllowedUser => ({ slackId, role, displayName: slackId, addedBy: "x", createdAt: 0 });

const RESULT: QueryResult = {
  status: "Complete",
  rows: [[{ field: "@timestamp", value: "2026-11-10 09:59:00" }, { field: "@message", value: "boom" }]],
  bytesScanned: 3e9,
  recordsMatched: 1,
  recordsScanned: 50,
};

type Rig = {
  deps: CommandDeps;
  cw: CloudwatchDeps;
  now: { t: number };
  ran: CloudwatchRequest[];
  described: string[][];
  posts: { channel: string; text: string; threadTs?: string; by?: string }[];
  interactive: { channel: string; text: string; actions: readonly InteractiveAction[]; threadTs?: string }[];
  settled: { channel: string; ts: string; text: string }[];
  timers: { fn: () => void; ms: number }[];
  fail: { run?: string };
  known: { groups: string[] };
};

const build = (): Rig => {
  const db = openDatabase(":memory:");
  const users = createUserRepo(db);
  for (const [id, role] of [[OWNER, "owner"], [ADMIN, "admin"], [EXEC, "executer"], [PAL, "pal"]] as const) users.upsert(user(id, role));
  const now = { t: NOW0 };
  const ran: CloudwatchRequest[] = [];
  const described: string[][] = [];
  const fail: Rig["fail"] = {};
  const known = { groups: [GROUP] };
  const aws: CloudwatchPort = {
    describeGroups: async (names) => {
      described.push([...names]);
      return names.filter((n) => known.groups.includes(n)).map((name) => ({ name, storedBytes: 365e9, retentionDays: 365 }));
    },
    runQuery: async (req) => {
      ran.push(req);
      if (fail.run) throw new Error(fail.run);
      return RESULT;
    },
  };
  const posts: Rig["posts"] = [];
  const interactive: Rig["interactive"] = [];
  const settled: Rig["settled"] = [];
  const slack = {
    post: async (channel: string, text: string, threadTs?: string, by?: string) => void posts.push({ channel, text, threadTs, by }),
    postInteractive: async (channel: string, text: string, actions: readonly InteractiveAction[], threadTs?: string) => {
      interactive.push({ channel, text, actions, threadTs });
      return { channel, ts: `n${interactive.length}` };
    },
    settleInteractive: async (channel: string, ts: string, text: string) => void settled.push({ channel, ts, text }),
  } as unknown as SlackAdminPort;
  const settings = createSettingsRepo(db);
  const timers: Rig["timers"] = [];
  const cw: CloudwatchDeps = {
    aws,
    repo: createCloudwatchRepo(db),
    users,
    slack,
    settings,
    clock: () => now.t,
    ownerSlackId: OWNER,
    timer: (fn, ms) => void timers.push({ fn, ms }),
    log: () => {},
  };
  const deps: CommandDeps = { users, messages: createMessageRepo(db), clock: () => now.t, ownerSlackId: OWNER, slack, settings, cloudwatch: cw };
  return { deps, cw, now, ran, described, posts, interactive, settled, timers, fail, known };
};

const run = (r: Rig, who: AllowedUser, line: string, reply?: (t: string) => Promise<void>, threadTs: string | undefined = "100.1") =>
  dispatchCommand(r.deps, who, "C1", `cloudwatch ${line}`, { prefix: "X/jv", slash: "/jv", threadTs, reply });

const LINE = `--group ${GROUP} --last 15m fields @timestamp, @message | filter @message like /ERROR/ | limit 5`;
const press = (r: Rig, by: string, actionId: string, value: string) => decideCloudwatch(r.cw, { slackUserId: by, actionId, value });
const rowOf = (r: Rig, id = 1) => r.cw.repo.get(id);

let r: Rig;
beforeEach(() => {
  r = build();
});

describe("who may run it", () => {
  test("a pal is turned away at the role gate, and nothing touches AWS", async () => {
    const out = await run(r, user(PAL, "pal"), LINE);
    expect(out).toContain("needs *executer* access");
    expect(r.described).toEqual([]);
    expect(r.ran).toEqual([]);
    expect(r.interactive).toEqual([]);
  });

  test("the refusal inside the command names every role that can (a switched-off or odd role)", async () => {
    // reached only if a role policy lets a pal through the gate: still refused, still naming who can
    const { askCloudwatch } = await import("../../src/application/cloudwatch.ts");
    const out = await askCloudwatch(r.cw, { actor: user(PAL, "pal"), channelId: "C1", usage: "u" }, LINE.split(" "));
    expect(out).toContain("executer");
    expect(out).toContain("admin");
    expect(out).toContain("owner");
    expect(r.ran).toEqual([]);
  });

  test("not wired -> says so", async () => {
    r.deps.cloudwatch = undefined;
    expect(await run(r, user(OWNER, "owner"), LINE)).toContain("not wired up");
  });
});

describe("owner: warned, then runs straight away", () => {
  test("warning first through the reply sink, then the result; one audit row", async () => {
    const said: string[] = [];
    const out = await run(r, user(OWNER, "owner"), LINE, async (t) => void said.push(t));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(GROUP);
    expect(said[0]).toContain("fields @timestamp");
    expect(said[0]).toContain("bills per GB");
    expect(r.ran).toHaveLength(1);
    expect(r.ran[0]).toMatchObject({ groups: [GROUP], region: "us-west-2", limit: 50 });
    expect(out).toContain("CloudWatch complete - 1 row");
    expect(out).toContain("run by <@UOWNER001> (owner, no confirmation needed)");
    expect(rowOf(r)).toMatchObject({ requestedBy: OWNER, mode: "run", status: "done", confirmedBy: OWNER, scannedBytes: 3e9 });
    expect(r.interactive).toEqual([]);
  });

  test("with no reply sink the warning and the result come back together", async () => {
    const out = await run(r, user(OWNER, "owner"), LINE);
    expect(out.indexOf("bills per GB")).toBeGreaterThan(-1);
    expect(out.indexOf("bills per GB")).toBeLessThan(out.indexOf("CloudWatch complete"));
  });

  test("a range over 3 weeks is flagged costly in the warning, and still runs", async () => {
    const said: string[] = [];
    await run(r, user(OWNER, "owner"), `--group ${GROUP} --last 4w fields @message`, async (t) => void said.push(t));
    expect(said[0]).toContain("Costly range");
    expect(r.ran).toHaveLength(1);
    expect(rowOf(r)?.costly).toBe(true);
  });

  test("a failing query is reported and audited as failed", async () => {
    r.fail.run = "ThrottlingException";
    const out = await run(r, user(OWNER, "owner"), LINE);
    expect(out).toContain("failed: ThrottlingException");
    expect(rowOf(r)).toMatchObject({ status: "failed", error: "ThrottlingException" });
  });
});

describe.each([
  ["executer", EXEC],
  ["admin", ADMIN],
] as const)("%s: never runs immediately", (role, id) => {
  test("posts the Confirm / Cancel message with query, group, range and cost warning, and runs nothing", async () => {
    const out = await run(r, user(id, role), LINE);
    // never empty: a brain running this must not read silence as "nothing happened" and ask again
    expect(out).toContain("nothing has run yet");
    expect(r.ran).toEqual([]);
    expect(r.interactive).toHaveLength(1);
    const msg = r.interactive[0];
    expect(msg?.channel).toBe("C1");
    expect(msg?.threadTs).toBe("100.1");
    for (const needle of [`<@${id}>`, GROUP, "fields @timestamp, @message | filter @message like /ERROR/ | limit 5", "2026-11-10 09:45Z → 2026-11-10 10:00Z", "bills per GB", "Nothing runs until it is confirmed"]) {
      expect(msg?.text).toContain(needle);
    }
    expect(msg?.actions.map((a) => a.actionId)).toEqual([CONFIRM_ACTION, CANCEL_ACTION]);
    expect(msg?.actions.every((a) => a.actionId.startsWith("jv:") && a.value === "1")).toBe(true);
    expect(rowOf(r)).toMatchObject({ status: "pending", mode: "confirm", requestedBy: id, noticeChannel: "C1", noticeTs: "n1" });
  });

  test("a costly range says so in the message", async () => {
    await run(r, user(id, role), `--group ${GROUP} --last 30d fields @message`);
    expect(r.interactive[0]?.text).toContain("Costly range");
  });

  test("a log group AWS does not know stops before any button", async () => {
    const out = await run(r, user(id, role), "--group /nope fields @message");
    expect(out).toContain("No such log group");
    expect(r.interactive).toEqual([]);
    expect(rowOf(r)).toBeUndefined();
  });

  test("with no way to post buttons nothing runs", async () => {
    r.cw.slack = undefined;
    const out = await run(r, user(id, role), LINE);
    expect(out).toContain("nothing ran");
    expect(r.ran).toEqual([]);
  });
});

describe("pressing the buttons", () => {
  beforeEach(async () => {
    await run(r, user(EXEC, "executer"), LINE);
  });

  test("Confirm by the requester runs it, settles the message and posts the result in the thread", async () => {
    const out = await press(r, EXEC, CONFIRM_ACTION, "1");
    expect(out).toEqual({ kind: "ran", id: 1 });
    expect(r.ran).toHaveLength(1);
    expect(r.settled).toEqual([{ channel: "C1", ts: "n1", text: expect.stringContaining("confirmed by <@UEXEC0001>") }]);
    expect(r.posts).toHaveLength(1);
    expect(r.posts[0]).toMatchObject({ channel: "C1", threadTs: "100.1" });
    expect(r.posts[0]?.text).toContain("CloudWatch complete");
    expect(r.posts[0]?.text).toContain("confirmed by <@UEXEC0001>");
    expect(rowOf(r)).toMatchObject({ status: "done", confirmedBy: EXEC, requestedBy: EXEC });
  });

  test("the owner may confirm someone else's request, and is the one recorded", async () => {
    expect(await press(r, OWNER, CONFIRM_ACTION, "1")).toEqual({ kind: "ran", id: 1 });
    expect(rowOf(r)).toMatchObject({ confirmedBy: OWNER, requestedBy: EXEC });
    expect(r.posts[0]?.text).toContain("confirmed by <@UOWNER001>");
  });

  test("anyone else - even an admin - is refused, and nothing runs or settles", async () => {
    expect(await press(r, ADMIN, CONFIRM_ACTION, "1")).toEqual({ kind: "refused", requester: EXEC });
    expect(await press(r, PAL, CANCEL_ACTION, "1")).toEqual({ kind: "refused", requester: EXEC });
    expect(r.ran).toEqual([]);
    expect(r.settled).toEqual([]);
    expect(rowOf(r)?.status).toBe("pending");
  });

  test("a second Confirm does not run it twice", async () => {
    await press(r, EXEC, CONFIRM_ACTION, "1");
    expect(await press(r, EXEC, CONFIRM_ACTION, "1")).toEqual({ kind: "decided" });
    expect(r.ran).toHaveLength(1);
  });

  test("Cancel runs nothing, settles the message, and a later Confirm is dead", async () => {
    expect(await press(r, EXEC, CANCEL_ACTION, "1")).toEqual({ kind: "cancelled", id: 1 });
    expect(r.settled[0]?.text).toContain("cancelled by <@UEXEC0001>");
    expect(await press(r, EXEC, CONFIRM_ACTION, "1")).toEqual({ kind: "decided" });
    expect(r.ran).toEqual([]);
    expect(rowOf(r)?.status).toBe("cancelled");
  });

  test("an expired request does not run on Confirm, and is recorded as expired", async () => {
    r.now.t += CONFIRM_TTL_MS + 1;
    expect(await press(r, EXEC, CONFIRM_ACTION, "1")).toEqual({ kind: "expired" });
    expect(r.ran).toEqual([]);
    expect(r.settled[0]?.text).toContain("expired");
    expect(rowOf(r)?.status).toBe("expired");
  });

  test("an unanswered request settles itself on a timer, and the timer does nothing once it was answered", async () => {
    expect(r.timers).toHaveLength(1);
    expect(r.timers[0]?.ms).toBeGreaterThan(CONFIRM_TTL_MS);
    r.now.t += CONFIRM_TTL_MS + 5_000;
    r.timers[0]?.fn();
    await Promise.resolve();
    expect(r.settled[0]?.text).toContain("expired");
    expect(rowOf(r)?.status).toBe("expired");
    expect(r.ran).toEqual([]);

    // a second request, answered before its timer fires
    await run(r, user(EXEC, "executer"), LINE);
    await press(r, EXEC, CANCEL_ACTION, "2");
    const settledBefore = r.settled.length;
    r.now.t += CONFIRM_TTL_MS + 5_000;
    r.timers[1]?.fn();
    await Promise.resolve();
    expect(r.settled).toHaveLength(settledBefore);
  });

  test("a requester who lost the right in the meantime is not run for", async () => {
    r.deps.users.setRole(EXEC, "pal");
    expect(await press(r, EXEC, CONFIRM_ACTION, "1")).toEqual({ kind: "decided" });
    expect(r.ran).toEqual([]);
    expect(r.settled[0]?.text).toContain("no longer allowed");
    expect(rowOf(r)).toMatchObject({ status: "failed" });
  });

  test("a failed query after Confirm is posted and audited", async () => {
    r.fail.run = "boom";
    await press(r, EXEC, CONFIRM_ACTION, "1");
    expect(r.posts[0]?.text).toContain("failed: boom");
    expect(rowOf(r)).toMatchObject({ status: "failed", error: "boom" });
  });

  test("an unknown id or a foreign action is ignored", async () => {
    expect(await press(r, EXEC, CONFIRM_ACTION, "99")).toEqual({ kind: "unknown" });
    expect(await press(r, EXEC, "jv:other", "1")).toEqual({ kind: "unknown" });
    expect(r.ran).toEqual([]);
  });

  test("an owner's direct-run row cannot be 'confirmed' again", async () => {
    await run(r, user(OWNER, "owner"), LINE);
    expect(await press(r, OWNER, CONFIRM_ACTION, "2")).toEqual({ kind: "unknown" });
    expect(r.ran).toHaveLength(1);
  });
});

describe("arguments", () => {
  test("mistakes come back with the usage and run nothing", async () => {
    for (const bad of ["", "--group /g", "--last 15m fields @message", `--group ${GROUP} --last soon fields @message`]) {
      const out = await run(r, user(OWNER, "owner"), bad);
      expect(out).toContain("X/jv cloudwatch");
    }
    expect(r.ran).toEqual([]);
  });

  test("the region and default group come from settings", async () => {
    r.deps.settings?.set(SETTING_KEYS.cloudwatchRegion, "us-east-1");
    r.deps.settings?.set(SETTING_KEYS.cloudwatchGroup, GROUP);
    await run(r, user(OWNER, "owner"), "--last 15m fields @message");
    expect(r.ran[0]).toMatchObject({ region: "us-east-1", groups: [GROUP] });
  });

  test("a range over 21 days reaches the estimate even when the group is small", async () => {
    const said: string[] = [];
    await run(r, user(OWNER, "owner"), `--group ${GROUP} --from ${new Date(NOW0 - 22 * DAY).toISOString()} fields @message`, async (t) => void said.push(t));
    expect(said[0]).toContain("Costly range");
  });
});

describe("help and the default group", () => {
  test("help, any role that can run it, touches nothing", async () => {
    const out = await run(r, user(EXEC, "executer"), "help");
    expect(out).toContain("only allowed way");
    expect(out).toContain("Confirm");
    expect(r.described).toEqual([]);
  });

  test("an admin sets and clears the default group; an executer cannot", async () => {
    expect(await run(r, user(EXEC, "executer"), `default ${GROUP}`)).toContain("Only admins");
    expect(await run(r, user(ADMIN, "admin"), `default ${GROUP}`)).toContain(GROUP);
    expect(r.deps.settings?.get(SETTING_KEYS.cloudwatchGroup)).toBe(GROUP);
    expect(await run(r, user(EXEC, "executer"), "default")).toContain(GROUP);
    expect(await run(r, user(ADMIN, "admin"), "default notagroup")).toContain("not a log group name");
    expect(await run(r, user(ADMIN, "admin"), "default reset")).toContain("Cleared");
    expect(r.deps.settings?.get(SETTING_KEYS.cloudwatchGroup)).toBe("");
  });

  test("the alias cw works and the command is in the registry for executer", async () => {
    const out = await dispatchCommand(r.deps, user(OWNER, "owner"), "C1", `cw ${LINE}`, { prefix: "X/jv" });
    expect(out).toContain("CloudWatch complete");
  });
});
