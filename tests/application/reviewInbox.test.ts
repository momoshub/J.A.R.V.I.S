import { beforeEach, describe, expect, test } from "bun:test";
import { createReviewInbox, POLL_MS, type ReviewInboxDeps } from "../../src/application/reviewInbox.ts";
import type { ReviewRequest } from "../../src/domain/reviewInbox.ts";
import type { AllowedUser } from "../../src/domain/types.ts";

const T0 = Date.parse("2026-11-06T10:00:00Z");
const KEY = "review_inbox_cursor";

const user = (slackId: string, displayName: string, role: AllowedUser["role"] = "executer"): AllowedUser => ({
  slackId,
  role,
  displayName,
  addedBy: "U0",
  createdAt: 0,
});

const req = (over: Partial<ReviewRequest> = {}): ReviewRequest => ({
  prUrl: "https://github.com/o/r/pull/7",
  repo: "o/r",
  number: 7,
  title: "add thing",
  requester: "dev-gh",
  requestedAt: "2026-11-06T10:00:30Z",
  ...over,
});

let now: number;
let store: Map<string, string>;
let posts: { channel: string; text: string }[];
let pending: ReviewRequest[];
let people: AllowedUser[];

const inbox = (over: Partial<ReviewInboxDeps> = {}) =>
  createReviewInbox({
    clock: () => now,
    settings: { get: (k) => store.get(k), set: (k, v) => void store.set(k, v) },
    channel: () => "CPR",
    cursorKey: KEY,
    requests: async () => pending,
    account: async () => "bot-gh",
    githubName: async (login) => (login === "dev-gh" ? "Dev Person" : undefined),
    users: { get: (id) => people.find((p) => p.slackId === id), list: () => people },
    post: async (channel, text) => {
      posts.push({ channel, text });
      return `ts${posts.length}`;
    },
    prefix: "X/jv",
    ...over,
  });

beforeEach(() => {
  now = T0;
  store = new Map([[KEY, "2026-11-06T10:00:00Z"]]);
  posts = [];
  pending = [req()];
  people = [user("UDEV", "Dev Person")];
});

describe("review inbox", () => {
  test("announces the request with how to ask for a review, and runs nothing", async () => {
    await inbox().tick();
    expect(posts).toHaveLength(1);
    expect(posts[0]?.channel).toBe("CPR");
    expect(posts[0]?.text).toContain("<@UDEV> requested a review from `bot-gh`");
    expect(posts[0]?.text).toContain("X/jv quick-review https://github.com/o/r/pull/7");
    expect(store.get(KEY)).toBe("2026-11-06T10:00:30Z");
  });

  test("it has no way to start a review: there is no runner to call", () => {
    const keys = Object.keys(inbox() as object);
    expect(keys).toEqual(["tick"]);
    // The deps type has no `runReview` or `hasToken`; a regression that adds
    // them back would fail typecheck here before it ever ran.
    const deps: ReviewInboxDeps = {
      clock: () => now,
      settings: { get: () => undefined, set: () => {} },
      channel: () => "",
      cursorKey: KEY,
      requests: async () => [],
      account: async () => undefined,
      githubName: async () => undefined,
      users: { get: () => undefined, list: () => [] },
      post: async () => undefined,
      prefix: "X/jv",
    };
    expect("runReview" in deps).toBe(false);
  });

  test("the same request is announced once", async () => {
    const i = inbox();
    await i.tick();
    now += POLL_MS;
    await i.tick();
    expect(posts).toHaveLength(1);
  });

  test("an explicit link names the Slack account in the announcement", async () => {
    people.push(user("UKAI", "Kai"));
    store.set("github_login:dev-gh", "UKAI");
    await inbox().tick();
    expect(posts[0]?.text).toContain("<@UKAI> requested");
  });

  test("an unknown requester is named by their GitHub login", async () => {
    pending = [req({ requester: "stranger" })];
    await inbox().tick();
    expect(posts).toHaveLength(1);
    expect(posts[0]?.text).toContain("`stranger` requested");
  });

  test("the first run only sets the cursor", async () => {
    store.delete(KEY);
    await inbox().tick();
    expect(posts).toHaveLength(0);
    expect(store.get(KEY)).toBe(new Date(T0).toISOString());
  });

  test("off without a channel, and GitHub is asked at most once a minute", async () => {
    let asked = 0;
    await inbox({ channel: () => "", requests: async () => (asked++, []) }).tick();
    expect(asked).toBe(0);
    const i = inbox({ requests: async () => (asked++, []) });
    await i.tick();
    now += 10_000;
    await i.tick();
    expect(asked).toBe(1);
  });

  test("a failing GitHub never throws onto the timer", async () => {
    const errors: unknown[] = [];
    await inbox({ requests: async () => Promise.reject(new Error("rate limited")), onError: (e) => errors.push(e) }).tick();
    expect(errors).toHaveLength(1);
  });
});
