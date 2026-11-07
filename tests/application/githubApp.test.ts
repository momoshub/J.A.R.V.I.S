import { beforeEach, describe, expect, test } from "bun:test";
import { createGithubApp, type GithubAppDeps } from "../../src/application/githubApp.ts";
import type { AllowedUser } from "../../src/domain/types.ts";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createGithubAppRepo, type GithubAppRepo } from "../../src/infrastructure/db/githubAppRepo.ts";

const user = (slackId: string, displayName: string): AllowedUser => ({
  slackId,
  role: "executer",
  displayName,
  addedBy: "U0",
  createdAt: 0,
});

const comment = (body: string, login = "dev-gh", owner = "acme") => ({
  action: "created",
  repository: { full_name: `${owner}/api`, owner: { login: owner } },
  installation: { id: 42 },
  sender: { login, type: "User" },
  issue: { number: 7, title: "broken", html_url: `https://github.com/${owner}/api/issues/7` },
  comment: { id: 99, body },
});

let repo: GithubAppRepo;
let store: Map<string, string>;
let people: AllowedUser[];
let posts: { channel: string; text: string }[];
let comments: { repo: string; number: number; body: string }[];
let reactions: string[];
let turns: { actor: string; threadTs: string; text: string }[];
let reply: string;
let draining: boolean;
let turnDone: Promise<void>;

const app = (over: Partial<GithubAppDeps> = {}) => {
  let release: () => void = () => {};
  turnDone = new Promise((r) => (release = r));
  return createGithubApp({
    clock: () => 1_000,
    repo,
    github: {
      react: async (_i, path, content) => void reactions.push(`${content}@${path}`),
      comment: async (_i, r, n, body) => {
        comments.push({ repo: r, number: n, body });
        return "https://github.com/x#c";
      },
      userName: async (_i, login) => (login === "dev-gh" ? "Dev Person" : undefined),
    },
    slug: "jarvis-at-acme",
    label: "jarvis",
    allowedOwners: ["acme"],
    channel: () => "CGH",
    settings: { get: (k) => store.get(k) },
    users: { get: (id) => people.find((p) => p.slackId === id), list: () => people },
    post: async (channel, text) => {
      posts.push({ channel, text });
      return `ts${posts.length}`;
    },
    runTurn: async ({ actor, threadTs, text }) => {
      turns.push({ actor: actor.slackId, threadTs, text });
      setTimeout(release, 0);
      return reply;
    },
    helperPath: "/bin/github-app-comment.sh",
    prefix: "X/jv",
    draining: () => draining,
    ...over,
  });
};

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  repo = createGithubAppRepo(openDatabase(":memory:"));
  store = new Map();
  people = [user("U1", "Dev Person"), user("U2", "Someone Else")];
  posts = [];
  comments = [];
  reactions = [];
  turns = [];
  reply = "";
  draining = false;
});

describe("github app", () => {
  test("a known caller: eyes, a post in the channel, a turn in its thread as them", async () => {
    const a = app();
    a.receive({ id: "d1", event: "issue_comment", payload: comment("@jarvis-at-acme why is it broken?") });
    await settle();
    expect(reactions).toEqual(["eyes@repos/acme/api/issues/comments/99/reactions"]);
    expect(posts[0]?.channel).toBe("CGH");
    expect(posts[0]?.text).toContain("<@U1>");
    expect(posts[0]?.text).toContain("> @jarvis-at-acme why is it broken?");
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ actor: "U1", threadTs: "ts1" });
    expect(turns[0]?.text).toContain("/bin/github-app-comment.sh acme/api 7 <file>");
    expect(repo.state("d1")).toBe("done");
  });

  test("an explicit github_login link wins over the name match", async () => {
    store.set("github_login:dev-gh", "U2");
    app().receive({ id: "d1", event: "issue_comment", payload: comment("@jarvis-at-acme hi") });
    await settle();
    expect(turns[0]?.actor).toBe("U2");
  });

  test("an unknown caller gets one comment on how to link, and nothing runs", async () => {
    app().receive({ id: "d1", event: "issue_comment", payload: comment("@jarvis-at-acme hi", "nobody") });
    await settle();
    expect(posts).toEqual([]);
    expect(turns).toEqual([]);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("X/jv review-inbox link nobody");
  });

  test("a repository outside the allowed owners is ignored and not recorded", async () => {
    app().receive({ id: "d1", event: "issue_comment", payload: comment("@jarvis-at-acme hi", "dev-gh", "stranger") });
    await settle();
    expect(repo.state("d1")).toBeUndefined();
    expect(reactions).toEqual([]);
    expect(posts).toEqual([]);
  });

  test("a redelivered id is not run twice, even by a new process", async () => {
    app().receive({ id: "d1", event: "issue_comment", payload: comment("@jarvis-at-acme hi") });
    await settle();
    app().receive({ id: "d1", event: "issue_comment", payload: comment("@jarvis-at-acme hi") });
    await settle();
    expect(turns).toHaveLength(1);
  });

  test("while draining a call waits on its row, and the next tick takes it", async () => {
    draining = true;
    const a = app();
    a.receive({ id: "d1", event: "issue_comment", payload: comment("@jarvis-at-acme hi") });
    await settle();
    expect(posts).toEqual([]);
    expect(repo.state("d1")).toBe("pending");
    draining = false;
    await a.tick();
    await settle();
    expect(turns).toHaveLength(1);
  });

  test("a turn that never used the helper still answers on GitHub, cleaned of Slack markup", async () => {
    reply = "done, see <https://x.dev|the fix> <@U1>";
    app().receive({ id: "d1", event: "issue_comment", payload: comment("@jarvis-at-acme hi") });
    await turnDone;
    await settle();
    expect(comments).toEqual([{ repo: "acme/api", number: 7, body: "done, see [the fix](https://x.dev) someone" }]);
  });

  test("the helper posts only to the issue its thread was opened for, and suppresses the fallback", async () => {
    reply = "posted it";
    const b = app({
      runTurn: async ({ channelId, threadTs }) => {
        await expect(b.commentFromTurn({ channelId, threadTs, repo: "acme/other", number: 7, body: "x" })).rejects.toThrow(
          /belongs to acme\/api#7/,
        );
        await b.commentFromTurn({ channelId, threadTs, repo: "acme/api", number: 7, body: "the answer" });
        return reply;
      },
    });
    b.receive({ id: "d1", event: "issue_comment", payload: comment("@jarvis-at-acme hi") });
    await settle();
    await settle();
    expect(comments).toEqual([{ repo: "acme/api", number: 7, body: "the answer" }]);
    await expect(b.commentFromTurn({ channelId: "CGH", threadTs: "nope", repo: "acme/api", number: 7, body: "x" })).rejects.toThrow(
      /not opened from GitHub/,
    );
  });

  test("a bot's comment never triggers a run", async () => {
    app().receive({
      id: "d1",
      event: "issue_comment",
      payload: { ...comment("@jarvis-at-acme"), sender: { login: "jarvis-at-acme[bot]", type: "Bot" } },
    });
    await settle();
    expect(repo.state("d1")).toBeUndefined();
    expect(turns).toEqual([]);
  });
});
