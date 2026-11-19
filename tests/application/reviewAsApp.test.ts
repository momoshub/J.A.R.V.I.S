import { beforeEach, describe, expect, test } from "bun:test";
import { createSettingsRepo } from "../../src/infrastructure/db/settingsRepo.ts";
import { createWatchRepo } from "../../src/infrastructure/db/watchRepo.ts";
import { startReview, type CommandDeps } from "../../src/application/commands.ts";
import { createCiGate } from "../../src/application/ciGate.ts";
import type { ReviewApp } from "../../src/application/commands/shared.ts";
import type { GitHubPort, PrSnapshot } from "../../src/application/github.ts";
import type { LlmCompleteParams, LlmPort } from "../../src/application/ports.ts";
import type { CiStatus } from "../../src/domain/ciGate.ts";
import { OWNER, actor, build, db } from "./commandsFixture.ts";

const PR = "https://github.com/o/r/pull/1";
const GREEN: CiStatus = { verdict: "green", failed: [] };
const RED: CiStatus = { verdict: "red", failed: ["checks"] };

let log: string[];
let ci: CiStatus;
let appMine: string | undefined;
let revoked: string[];
let seen: LlmCompleteParams | undefined;

/** The host's own account: it reads, and it is the one that approves. */
const human = (): GitHubPort => ({
  whoami: async () => ({ login: "kai-gh" }),
  reviewDecision: async () => undefined,
  approve: async () => {
    log.push("human:approve");
    return { ok: true };
  },
  requestChanges: async () => {
    log.push("human:request-changes");
    return { ok: true };
  },
  snapshot: async (): Promise<PrSnapshot> => ({ state: "OPEN", ci, mine: undefined }),
});

/** The app's own adapter: it writes change requests and never approves. */
const appPort = (): GitHubPort => ({
  whoami: async () => ({ login: "bot-app[bot]" }),
  reviewDecision: async () => undefined,
  approve: async () => {
    log.push("app:approve");
    return { ok: true };
  },
  requestChanges: async (_u, body) => {
    log.push(`app:request-changes:${body}`);
    return { ok: true };
  },
  snapshot: async (): Promise<PrSnapshot> => ({ state: "OPEN", ci, mine: appMine }),
});

const setup = (minted = true) => {
  const base = build();
  const github = human();
  const app = appPort();
  const reviewApp: ReviewApp = {
    login: "bot-app[bot]",
    github: app,
    mintToken: async (repo) => {
      if (!minted) throw new Error("not installed");
      log.push(`mint:${repo}`);
      return { token: "ghs_scoped", revoke: async () => void revoked.push("ghs_scoped") };
    },
  };
  const llm: LlmPort = {
    complete: async (p) => {
      seen = p;
      log.push("brain");
      return "the review";
    },
  };
  const watches = createWatchRepo(db);
  const ciGate = createCiGate({ github, appGithub: app, watches, clock: () => 1_000, say: async () => {} });
  const deps: CommandDeps = { ...base, github, reviewApp, ciGate, llm, settings: createSettingsRepo(db) };
  const lines: string[] = [];
  const start = (over: Partial<Parameters<typeof startReview>[1]> = {}) =>
    startReview(deps, {
      actor: actor(),
      channelId: "C1",
      threadTs: "1.1",
      url: PR,
      identity: "app",
      reply: async (t) => void lines.push(t),
      ...over,
    });
  return { deps, start, lines, watches };
};

beforeEach(() => {
  log = [];
  ci = GREEN;
  appMine = undefined;
  revoked = [];
  seen = undefined;
});

describe("a review as the GitHub App", () => {
  test("the model's gh gets a token minted for that one repo, the prompt says it writes as the app, and the token is revoked after", async () => {
    const { start } = setup();
    await start();
    expect(log).toContain("mint:o/r");
    expect(seen?.env).toEqual({ GH_TOKEN: "ghs_scoped" });
    expect(seen?.system).toContain("Your gh credential is the GitHub App's (bot-app[bot])");
    expect(seen?.system).toContain("The approval is never yours and never the app's");
    expect(revoked).toEqual(["ghs_scoped"]);
  });

  test("a review as the host's own account has no minted token and no app wording", async () => {
    const { start } = setup();
    await start({ identity: "human" });
    expect(seen?.env).toBeUndefined();
    expect(seen?.system).not.toContain("GitHub App's");
    expect(log).not.toContain("mint:o/r");
  });

  test("the approval after a clean review is the human's, never the app's", async () => {
    const { start, lines } = setup();
    await start();
    expect(log.filter((l) => l.endsWith(":approve"))).toEqual(["human:approve"]);
    expect(lines.some((l) => l.startsWith("✅ approved"))).toBe(true);
  });

  test("red CI: the change request goes out as the app, the approval does not happen", async () => {
    ci = RED;
    const { start } = setup();
    await start();
    expect(log.some((l) => l.startsWith("app:request-changes:"))).toBe(true);
    expect(log).not.toContain("human:request-changes");
    expect(log.filter((l) => l.endsWith(":approve"))).toEqual([]);
  });

  test("a change request of the app's own already on the PR is not repeated", async () => {
    ci = RED;
    appMine = "CHANGES_REQUESTED";
    const { start } = setup();
    await start();
    expect(log.some((l) => l.includes("request-changes"))).toBe(false);
  });

  test("a running CI keeps its watcher on the app's identity", async () => {
    ci = { verdict: "running", failed: [] };
    const { start, watches } = setup();
    await start();
    const rows = watches.waiting(10).filter((w) => w.check.startsWith("ci-gate:"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.check).toContain('"identity":"app"');
  });

  test("no credential for the app on that repo: nothing runs and it is said", async () => {
    const { start } = setup(false);
    const out = await start();
    expect(out).toContain("could not get a credential");
    expect(log).not.toContain("brain");
  });

  test("it takes exactly one PR and needs the app wired", async () => {
    const { start, deps } = setup();
    expect(await start({ url: `${PR} https://github.com/o/r/pull/2`.split(" ")[0] ?? PR, note: "https://github.com/o/r/pull/2" })).toContain("exactly one PR url");
    deps.reviewApp = undefined;
    expect(await start()).toContain("not wired up");
  });

  test("an actor without a token runs on the bot's credential only when the owner allowed it", async () => {
    const { deps, start } = setup();
    deps.claudeTokens = { ...deps.claudeTokens!, get: () => undefined, has: () => false };
    const asked = await start({ actor: actor({ slackId: OWNER }) });
    expect(asked).toBe(""); // the ask for a token went into the thread
    expect(log).not.toContain("brain");
    await start({ actor: actor({ slackId: OWNER }), botCredentialOk: true });
    expect(log).toContain("brain");
    expect(seen?.oauthToken).toBeUndefined();
  });
});
