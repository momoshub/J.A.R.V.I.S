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
let posts: { channel: string; text: string; thread?: string }[];
let reviews: { actor: string; threadTs: string; line: string }[];
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
    post: async (channel, text, thread) => {
      posts.push({ channel, text, thread });
      return `ts${posts.length}`;
    },
    runReview: async ({ actor, threadTs, line }) => void reviews.push({ actor: actor.slackId, threadTs, line }),
    prefix: "X/jv",
    ...over,
  });

beforeEach(() => {
  now = T0;
  store = new Map([[KEY, "2026-11-06T10:00:00Z"]]);
  posts = [];
  reviews = [];
  pending = [req()];
  people = [user("UDEV", "Dev Person")];
});

describe("review inbox", () => {
  test("posts the request and reviews it in the thread as the requester, review before approve", async () => {
    await inbox().tick();
    expect(posts[0]?.channel).toBe("CPR");
    expect(posts[0]?.text).toContain("<@UDEV> requested a review from `bot-gh`");
    expect(reviews).toEqual([{ actor: "UDEV", threadTs: "ts1", line: "review https://github.com/o/r/pull/7 --policy after" }]);
    expect(store.get(KEY)).toBe("2026-11-06T10:00:30Z");
  });

  test("the same request is handled once", async () => {
    const i = inbox();
    await i.tick();
    now += POLL_MS;
    await i.tick();
    expect(reviews).toHaveLength(1);
  });

  test("a review runs whether or not the requester has a token on file", async () => {
    await inbox().tick();
    expect(reviews).toHaveLength(1);
    expect(posts).toHaveLength(1); // the announcement only: no refusal line, no ask
  });

  test("an explicit link wins over the name", async () => {
    people.push(user("UKAI", "Kai"));
    store.set("github_login:dev-gh", "UKAI");
    await inbox().tick();
    expect(reviews[0]?.actor).toBe("UKAI");
  });

  test("an unknown requester gets a line, not a review", async () => {
    pending = [req({ requester: "stranger" })];
    await inbox().tick();
    expect(reviews).toHaveLength(0);
    expect(posts[0]?.text).toContain("`stranger` requested");
    expect(posts[1]?.text).toContain("review-inbox link stranger");
  });

  test("a pal's review drops the policy flag it may not pass", async () => {
    people = [user("UDEV", "Dev Person", "pal")];
    await inbox().tick();
    expect(reviews[0]?.line).toBe("review https://github.com/o/r/pull/7");
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
