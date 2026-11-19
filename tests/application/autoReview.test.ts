import { beforeEach, describe, expect, test } from "bun:test";
import { createAutoReview, type AutoReview, type AutoReviewDeps, type ReviewAsk } from "../../src/application/autoReview.ts";
import { decideReviewRunPress, type ReviewRunApprovalDeps } from "../../src/application/reviewRunApproval.ts";
import type { ReviewStart } from "../../src/application/commands.ts";
import type { InteractiveAction } from "../../src/application/slackAdmin.ts";
import { REVIEW_RUN_APPROVE_ACTION, REVIEW_RUN_REJECT_ACTION } from "../../src/domain/reviewIdentity.ts";
import type { AllowedUser } from "../../src/domain/types.ts";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createReviewRunRepo, type ReviewRunRepo } from "../../src/infrastructure/db/reviewRunRepo.ts";

const OWNER = "UOWNER";
const user = (slackId: string, displayName: string, role: AllowedUser["role"] = "executer"): AllowedUser => ({
  slackId,
  role,
  displayName,
  addedBy: "U0",
  createdAt: 0,
});

const ask = (over: Partial<ReviewAsk> = {}): ReviewAsk => ({
  identity: "app",
  url: "https://github.com/acme/web/pull/7",
  repo: "acme/web",
  number: 7,
  title: "add thing",
  requester: "dev-gh",
  installationId: 5,
  ...over,
});

type Post = { channel: string; text: string; threadTs?: string };

let now: number;
let runs: ReviewRunRepo;
let posts: Post[];
let asks: { channel: string; text: string; actions: readonly InteractiveAction[]; threadTs: string }[];
let started: ReviewStart[];
let reviewOut: string | Error;
let sha: string | undefined;
let enabled: boolean;
let channel: string;
let tokens: Set<string>;
let people: AllowedUser[];
let links: Map<string, string>;

const make = (over: Partial<AutoReviewDeps> = {}): AutoReview =>
  createAutoReview({
    clock: () => now,
    runs,
    enabled: () => enabled,
    channel: () => channel,
    identity: {
      settings: { get: (k) => links.get(k) },
      users: { list: () => people },
      githubName: async () => undefined,
    },
    users: { get: (id) => people.find((p) => p.slackId === id) },
    hasToken: (id) => tokens.has(id),
    ownerSlackId: OWNER,
    allowedOwners: ["acme"],
    headSha: async () => sha,
    account: async (identity) => (identity === "app" ? "jv-app[bot]" : "kai-gh"),
    ownLogins: async () => ["kai-gh", "jv-app[bot]"],
    post: async (c, text, threadTs) => {
      posts.push({ channel: c, text, ...(threadTs ? { threadTs } : {}) });
      return `ts${posts.length}`;
    },
    postInteractive: async (c, text, actions, threadTs) => {
      asks.push({ channel: c, text, actions, threadTs });
      return { channel: c, ts: `ask${asks.length}` };
    },
    review: async (start) => {
      started.push(start);
      if (reviewOut instanceof Error) throw reviewOut;
      return reviewOut;
    },
    prefix: "X/jv",
    ...over,
  });

/** Let a review the request started (not awaited by it) finish. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  now = 1_000_000;
  runs = createReviewRunRepo(openDatabase(":memory:"));
  posts = [];
  asks = [];
  started = [];
  reviewOut = "";
  sha = "abcdef1234567";
  enabled = true;
  channel = "CREV";
  tokens = new Set(["U1"]);
  people = [user("U1", "Dev Person"), user(OWNER, "Owner", "owner")];
  links = new Map([["github_login:dev-gh", "U1"]]);
});

describe("a request whose requester has a token", () => {
  test("opens the PR's thread, then runs the review in it as the requester, as the identity asked", async () => {
    const review = make();
    expect(await review.request(ask())).toBe("started");
    await settle();

    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ channel: "CREV" });
    expect(posts[0]?.text).toContain("<@U1> asked the app (`jv-app[bot]`) to review");
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      channelId: "CREV",
      threadTs: "ts1", // the top-level post is the thread
      url: "https://github.com/acme/web/pull/7",
      identity: "app",
    });
    expect(started[0]?.actor.slackId).toBe("U1");
    expect(started[0]?.botCredentialOk).toBe(false);
    expect(runs.find("acme/web#7", "abcdef1234567", "app")?.state).toBe("done");
  });

  test("a review as the host's account runs the same way with the human identity", async () => {
    await make().request(ask({ identity: "human" }));
    await settle();
    expect(started[0]?.identity).toBe("human");
    expect(posts[0]?.text).toContain("asked `kai-gh` to review");
  });

  test("the review's own lines land in the thread, and a refusal it returns is said there too", async () => {
    reviewOut = "That command needs *admin* access.";
    await make().request(ask());
    await settle();
    await started[0]?.reply("🔍 reviewing it");
    const inThread = posts.filter((p) => p.threadTs === "ts1").map((p) => p.text);
    expect(inThread).toContain("🔍 reviewing it");
    expect(inThread).toContain("That command needs *admin* access.");
  });

  test("text coming back from the review means it did not run: it is said in the thread and the head can be asked for again", async () => {
    reviewOut = "I could not get a credential for the GitHub App on that repository, so nothing ran.";
    const review = make();
    await review.request(ask());
    await settle();
    expect(posts.some((p) => p.threadTs === "ts1" && p.text.includes("could not get a credential"))).toBe(true);
    expect(runs.find("acme/web#7", "abcdef1234567", "app")?.state).toBe("failed");
    reviewOut = "";
    expect(await review.request(ask())).toBe("started");
  });

  test("a review that throws is said in the thread and can be asked for again", async () => {
    reviewOut = new Error("boom");
    const review = make();
    await review.request(ask());
    await settle();
    expect(posts.some((p) => p.threadTs === "ts1" && p.text.includes("the review of https://github.com/acme/web/pull/7 stopped: boom"))).toBe(true);
    expect(runs.find("acme/web#7", "abcdef1234567", "app")?.state).toBe("failed");
    reviewOut = "";
    expect(await review.request(ask())).toBe("started");
  });

  test("the steering note the asker left goes to the review", async () => {
    await make().request(ask({ note: "the migration is risky" }));
    await settle();
    expect(started[0]?.note).toBe("the migration is risky");
  });
});

describe("one review per PR head per identity", () => {
  test("a redelivery or a re-request on the same head never runs twice, and says so in the thread", async () => {
    const review = make();
    expect(await review.request(ask())).toBe("started");
    await settle();
    expect(await review.request(ask())).toBe("duplicate");
    await settle();
    expect(started).toHaveLength(1);
    expect(posts.at(-1)).toMatchObject({ threadTs: "ts1" });
    expect(posts.at(-1)?.text).toContain("already has a review this way");
  });

  test("a push is reviewed only when it is asked for again", async () => {
    const review = make();
    await review.request(ask());
    await settle();
    sha = "ffffffffffff";
    expect(await review.request(ask())).toBe("started");
    await settle();
    expect(started).toHaveLength(2);
    // the second request went into the same thread
    expect(posts.filter((p) => p.threadTs === "ts1").some((p) => p.text.includes("asked the app"))).toBe(true);
    expect(posts.filter((p) => !p.threadTs)).toHaveLength(1);
  });

  test("the same head under the other identity is its own review", async () => {
    const review = make();
    await review.request(ask({ identity: "app" }));
    await settle();
    expect(await review.request(ask({ identity: "human" }))).toBe("started");
    await settle();
    expect(started.map((s) => s.identity)).toEqual(["app", "human"]);
  });

  test("two requests arriving together open one thread, not two", async () => {
    const review = make();
    await Promise.all([review.request(ask({ identity: "app" })), review.request(ask({ identity: "human" }))]);
    await settle();
    expect(posts.filter((p) => !p.threadTs)).toHaveLength(1);
  });
});

describe("nobody to run it on", () => {
  test("a requester with no token: nothing runs, the owner is asked in the PR's thread with two buttons", async () => {
    tokens.clear();
    expect(await make().request(ask())).toBe("asked");
    await settle();

    expect(started).toHaveLength(0);
    expect(asks).toHaveLength(1);
    expect(asks[0]?.threadTs).toBe("ts1");
    expect(asks[0]?.text).toContain("no Claude Code token on file");
    expect(asks[0]?.actions.map((a) => a.actionId)).toEqual([REVIEW_RUN_APPROVE_ACTION, REVIEW_RUN_REJECT_ACTION]);
    const run = runs.find("acme/web#7", "abcdef1234567", "app");
    expect(run).toMatchObject({ state: "asking", askChannel: "CREV", askTs: "ask1", askReason: "no-token", requesterSlack: "U1" });
  });

  test("a requester nobody can place on Slack is asked about too, never run on a guess", async () => {
    links.clear();
    people = [user(OWNER, "Owner", "owner")];
    expect(await make().request(ask({ requester: "stranger" }))).toBe("asked");
    expect(asks[0]?.text).toContain("cannot tell who that is on Slack");
    expect(started).toHaveLength(0);
    expect(runs.find("acme/web#7", "abcdef1234567", "app")?.askReason).toBe("unknown");
  });

  test("a requester matched to Slack by name only is not billed: the owner is asked, and the thread says why", async () => {
    links.clear(); // no explicit link, but exactly one person is named "Dev Person"
    expect(await make({ identity: { settings: { get: (k) => links.get(k) }, users: { list: () => people }, githubName: async () => "Dev Person" } }).request(ask())).toBe("asked");
    expect(started).toHaveLength(0);
    expect(asks[0]?.text).toContain("the login is not linked");
    expect(runs.find("acme/web#7", "abcdef1234567", "app")).toMatchObject({ askReason: "unlinked", requesterSlack: "U1" });
  });

  test("a second request on the same head does not ask the owner twice", async () => {
    tokens.clear();
    const review = make();
    await review.request(ask());
    expect(await review.request(ask())).toBe("duplicate");
    expect(asks).toHaveLength(1);
  });
});

describe("the owner's press", () => {
  const press = (over: Partial<Parameters<typeof decideReviewRunPress>[1]> = {}) => ({
    slackUserId: OWNER,
    actionId: REVIEW_RUN_APPROVE_ACTION,
    value: "1",
    channel: "CREV",
    messageTs: "ask1",
    ...over,
  });

  let settled: { channel: string; ts: string; text: string }[];
  const wire = (review: AutoReview): ReviewRunApprovalDeps => ({
    runs,
    slack: { settleInteractive: async (c, ts, text) => void settled.push({ channel: c, ts, text }) },
    clock: () => now,
    ownerSlackId: OWNER,
    resolve: (run, decision, by) => review.resolve(run, decision, by),
  });

  beforeEach(async () => {
    settled = [];
    tokens.clear();
  });

  test("approve runs the review as the owner, on the owner's own token or the bot's credential", async () => {
    const review = make();
    await review.request(ask());
    expect(await decideReviewRunPress(wire(review), press())).toEqual({ kind: "approved", id: 1 });
    await settle();

    expect(started).toHaveLength(1);
    expect(started[0]?.actor.slackId).toBe(OWNER);
    expect(started[0]?.botCredentialOk).toBe(true);
    expect(started[0]?.threadTs).toBe("ts1");
    expect(started[0]?.identity).toBe("app");
    expect(settled[0]?.text).toContain("approved by <@UOWNER>");
    expect(runs.find("acme/web#7", "abcdef1234567", "app")?.state).toBe("done");
  });

  test("reject posts a short note in the thread and nothing runs", async () => {
    const review = make();
    await review.request(ask());
    expect(await decideReviewRunPress(wire(review), press({ actionId: REVIEW_RUN_REJECT_ACTION }))).toEqual({ kind: "rejected", id: 1 });
    await settle();

    expect(started).toHaveLength(0);
    expect(posts.at(-1)).toMatchObject({ threadTs: "ts1" });
    expect(posts.at(-1)?.text).toContain("not reviewing https://github.com/acme/web/pull/7 - <@UOWNER> said no, nothing ran");
    expect(settled[0]?.text).toContain("rejected by <@UOWNER>");
    expect(runs.find("acme/web#7", "abcdef1234567", "app")?.state).toBe("rejected");
  });

  test("only the owner's press counts: the requester, an admin or anyone else changes nothing", async () => {
    const review = make();
    await review.request(ask());
    for (const slackUserId of ["U1", "UADMIN", "UANYONE"]) {
      expect(await decideReviewRunPress(wire(review), press({ slackUserId }))).toEqual({ kind: "refused", why: "not-owner", id: 1 });
    }
    await settle();
    expect(started).toHaveLength(0);
    expect(settled).toHaveLength(0);
    expect(runs.find("acme/web#7", "abcdef1234567", "app")?.state).toBe("asking");
  });

  test("a press that names another message, or a made-up run, changes nothing", async () => {
    const review = make();
    await review.request(ask());
    expect(await decideReviewRunPress(wire(review), press({ messageTs: "elsewhere" }))).toEqual({ kind: "refused", why: "wrong-message", id: 1 });
    expect(await decideReviewRunPress(wire(review), press({ channel: "COTHER" }))).toEqual({ kind: "refused", why: "wrong-message", id: 1 });
    expect(await decideReviewRunPress(wire(review), press({ value: "99" }))).toEqual({ kind: "unknown" });
    expect(await decideReviewRunPress(wire(review), press({ actionId: "jv:something-else" }))).toEqual({ kind: "unknown" });
    expect(runs.find("acme/web#7", "abcdef1234567", "app")?.state).toBe("asking");
  });

  test("a second press, or a press on a decided review, is told it is decided and runs nothing more", async () => {
    const review = make();
    await review.request(ask());
    const deps = wire(review);
    await decideReviewRunPress(deps, press());
    await settle();
    expect(await decideReviewRunPress(deps, press())).toEqual({ kind: "decided", id: 1 });
    expect(await decideReviewRunPress(deps, press({ actionId: REVIEW_RUN_REJECT_ACTION }))).toEqual({ kind: "decided", id: 1 });
    await settle();
    expect(started).toHaveLength(1);
  });
});

describe("when nothing should run", () => {
  test("switched off, a request is left to the inbox's old announcement", async () => {
    enabled = false;
    expect(await make().request(ask())).toBe("off");
    expect(posts).toHaveLength(0);
    expect(runs.find("acme/web#7", "abcdef1234567", "app")).toBeUndefined();
  });

  test("no channel set means nowhere to post, so nothing runs", async () => {
    channel = "";
    expect(await make().request(ask())).toBe("no-channel");
    expect(started).toHaveLength(0);
  });

  test("a request to the app on an owner it is not set up for is ignored; the host's account is not limited by it", async () => {
    const stranger = { repo: "evil/web", url: "https://github.com/evil/web/pull/7" };
    expect(await make().request(ask(stranger))).toBe("refused");
    expect(await make().request(ask({ ...stranger, identity: "human" }))).toBe("started");
  });

  test("a head that cannot be read is not reviewed: there is nothing to dedupe on", async () => {
    sha = undefined;
    expect(await make().request(ask())).toBe("unreadable");
    expect(posts).toHaveLength(0);
  });

  test("a thread that cannot be posted leaves the review claimable again", async () => {
    const review = make({ post: async () => undefined });
    expect(await review.request(ask())).toBe("unposted");
    expect(runs.find("acme/web#7", "abcdef1234567", "app")?.state).toBe("failed");
    expect(await make().request(ask())).toBe("started");
  });
});

describe("what others do on the PR", () => {
  test("goes into the PR's thread once it has one, and nowhere before", async () => {
    const review = make();
    const line = { kind: "comment" as const, login: "dev-gh", url: "u", body: "looks off", repo: "acme/web", number: 7 };
    expect(await review.activity(line)).toBe(false);
    expect(posts).toHaveLength(0);
    await review.request(ask());
    await settle();
    expect(await review.activity(line)).toBe(true);
    expect(posts.at(-1)).toMatchObject({ threadTs: "ts1" });
    expect(posts.at(-1)?.text).toContain("`dev-gh` commented");
  });

  test("the review's own accounts are not news: it already announced what it did", async () => {
    const review = make();
    await review.request(ask());
    await settle();
    const before = posts.length;
    for (const login of ["kai-gh", "jv-app[bot]", "jv-app"]) {
      expect(await review.activity({ kind: "approved", login, url: "u", body: "", repo: "acme/web", number: 7 })).toBe(false);
    }
    expect(posts).toHaveLength(before);
  });

  test("a restart fails what it cut off, so asking again retries", async () => {
    const review = make();
    tokens.clear();
    await review.request(ask());
    expect(review.recover()).toBe(0); // a pending question is not cut off
    runs.move(1, ["asking"], "running", now);
    expect(review.recover()).toBe(1);
  });
});
