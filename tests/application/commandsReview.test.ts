import { describe, expect, test } from "bun:test";
import { createSettingsRepo } from "../../src/infrastructure/db/settingsRepo.ts";
import { dispatchCommand, isQuietCommand } from "../../src/application/commands.ts";
import type { LlmPort } from "../../src/application/ports.ts";
import { OWNER, db, actor, slackCalls, build } from "./commandsFixture.ts";

describe("reviews run on the caller's own Claude token", () => {
  const PR = "https://github.com/o/r/pull/1";
  const TOKEN = `sk-ant-oat01-${"a".repeat(48)}`;

  const withTokens = (stored?: Record<string, string>) => {
    const map = new Map(Object.entries(stored ?? {}));
    const asks = new Set<string>();
    const deps = build();
    deps.settings = createSettingsRepo(db);
    deps.claudeTokens = {
      get: (id) => map.get(id),
      has: (id) => map.has(id),
      set: (id, t) => {
        map.set(id, t);
        asks.delete(id);
      },
      remove: (id) => {
        map.delete(id);
        asks.delete(id);
      },
      count: () => map.size,
      list: () => [...map.keys()].map((slackId) => ({ slackId, updatedAt: 0 })),
      asked: (id) => asks.has(id),
      markAsked: (id) => {
        asks.add(id);
      },
    };
    let seen: string | undefined;
    let system = "";
    deps.llm = {
      complete: async (p) => {
        seen = p.oauthToken;
        system = p.system;
        return "the review";
      },
    };
    return { deps, map, token: () => seen, sys: () => system };
  };

  test("with a token on file, the review runs on it", async () => {
    const { deps, token } = withTokens({ [OWNER]: TOKEN });
    await dispatchCommand(deps, actor(), "C1", `rv ${PR}`);
    expect(token()).toBe(TOKEN);
  });

  test("without one the review does not run - the ask goes out with a button", async () => {
    const { deps, token } = withTokens();
    const lines: string[] = [];
    const out = await dispatchCommand(deps, actor(), "C1", `rv ${PR}`, {
      reply: async (t: string) => {
        lines.push(t);
      },
      threadTs: "111.1",
    });

    expect(out).toBe(""); // posted into the thread, not returned
    expect(token()).toBeUndefined(); // the brain never started
    const ask = slackCalls.posts[slackCalls.posts.length - 1];
    expect(ask?.text).toContain("claude setup-token");
    expect(ask?.threadTs).toBe("111.1");
    expect(ask?.by).toBe("command"); // command output, not Jarvis talking
    // the button carries the command, so submitting a token resumes it
    const button = slackCalls.buttons[slackCalls.buttons.length - 1] ?? "";
    expect(button).toContain("claude_token_add");
    expect(button).toContain(PR);
  });

  test("nobody is asked twice - the second attempt points at the box they have", async () => {
    const { deps } = withTokens();
    const reply = async () => {};
    await dispatchCommand(deps, actor(), "C1", `rv ${PR}`, { reply });
    const asks = slackCalls.posts.filter((p) => p.text.includes("claude setup-token")).length;
    expect(asks).toBe(1);

    const again = await dispatchCommand(deps, actor(), "C1", `rv ${PR}`, { reply });
    expect(again).toContain("still waiting");
    // and no second walkthrough went into the channel
    expect(slackCalls.posts.filter((p) => p.text.includes("claude setup-token")).length).toBe(1);

    // answering resets it, so removing a token later earns a fresh ask
    deps.claudeTokens!.set(OWNER, TOKEN);
    deps.claudeTokens!.remove(OWNER);
    await dispatchCommand(deps, actor(), "C1", `rv ${PR}`, { reply });
    expect(slackCalls.posts.filter((p) => p.text.includes("claude setup-token")).length).toBe(2);
  });

  test("with no token store at all it refuses rather than using the bot's own", async () => {
    const { deps, token } = withTokens();
    deps.claudeTokens = undefined;
    const out = await dispatchCommand(deps, actor(), "C1", `rv ${PR}`);
    expect(out).toContain("only ever runs on the caller's own");
    expect(token()).toBeUndefined(); // the brain never started
  });

  test("with no button to offer, the guidance is still returned in words", async () => {
    const { deps } = withTokens();
    deps.slack = undefined;
    const out = await dispatchCommand(deps, actor(), "C1", `rv ${PR}`);
    expect(out).toContain("claude setup-token");
    expect(out).toContain("token");
  });

  test("a chat turn of theirs uses it too, and someone else's does not", async () => {
    const { deps, token } = withTokens({ [OWNER]: TOKEN });
    await dispatchCommand(deps, actor(), "C1", "ask hello");
    expect(token()).toBe(TOKEN);

    const pal = actor({ slackId: "U0PAL0003", role: "pal" });
    deps.users.upsert(pal);
    await dispatchCommand(deps, pal, "C1", "ask hello");
    expect(token()).toBeUndefined(); // falls back to the bot's own credential
  });

  test("read is a tool: no reply wired means the content comes back", async () => {
    // it is one step of a larger job, so the brain gets the document to work
    // with rather than the thread getting the document posted into it
    const { deps } = withTokens({ [OWNER]: TOKEN });
    deps.llm = { complete: async () => "the page says X" };
    const lines: string[] = [];
    // no `reply` - the shape the command bridge now uses for tool-like commands
    const out = await dispatchCommand(deps, actor(), "C1", "read https://x/p1");
    expect(out).toBe("the page says X");
    expect(lines).toHaveLength(0);
  });

  test("and is marked quiet, so the bridge waits for it instead of posting", () => {
    expect(isQuietCommand("read https://x/p1")).toBe(true);
    expect(isQuietCommand("summarise https://x/p1")).toBe(true);
    // the long-running announcers stay as they are: nobody is holding a line
    // open for a review, and it reports into the thread itself
    expect(isQuietCommand("review https://github.com/o/r/pull/1")).toBe(false);
    expect(isQuietCommand("ticket something broke")).toBe(false);
    expect(isQuietCommand("investigate why")).toBe(false);
  });

  test("spend, users and rm-msg are quiet: the brain relays them, nothing tags the thread", () => {
    expect(isQuietCommand("spend 30d")).toBe(true);
    expect(isQuietCommand("users")).toBe(true);
    expect(isQuietCommand("rm-msg https://x.slack.com/archives/C1/p1700000000000100")).toBe(true);
  });

  test("tell and a remote workflow stop are quiet, a plain workflow stop still answers in the thread", () => {
    expect(isQuietCommand("tell https://x.slack.com/archives/C1/p1700000000000100 hi")).toBe(true);
    expect(isQuietCommand("workflow stop https://x.slack.com/archives/C1/p1700000000000100")).toBe(true);
    expect(isQuietCommand("workflow stop")).toBe(false);
    expect(isQuietCommand("workflow fix the build")).toBe(false);
  });

  test("users lists names and ids without tagging anyone", async () => {
    const { deps } = withTokens({});
    const out = await dispatchCommand(deps, actor(), "C1", "users");
    expect(out).not.toContain("<@");
  });

  test("watch is quiet too: its confirmation goes back to the brain, not the thread", () => {
    expect(isQuietCommand("watch checks https://github.com/o/r/pull/1 post the result")).toBe(true);
    expect(isQuietCommand("watch list")).toBe(true);
  });

  test("any command's help is quiet, so the brain reads it without posting it", () => {
    expect(isQuietCommand("bomb help")).toBe(true);
    expect(isQuietCommand("review help")).toBe(true);
    expect(isQuietCommand("ticket --help")).toBe(true);
    expect(isQuietCommand("help")).toBe(true);
    expect(isQuietCommand("ticket help me the page is broken")).toBe(false);
  });

  test("read's floor is configurable, and a refusal says who can run it", async () => {
    // owner-only made it useless for the case it exists for: a teammate asking
    // it to follow a document the team shares
    const { deps } = withTokens({ [OWNER]: TOKEN });
    const pal = actor({ slackId: "U0PAL77", role: "pal" });
    deps.users.upsert(pal);
    const link = "https://app.notion.com/p/handbook-1a2b3c4d5e6f7081920a1b2c3d4e5f61";

    const refused = await dispatchCommand(deps, pal, "C1", `read ${link}`);
    expect(refused).toContain("*admin* and above"); // the default floor
    expect(refused).toContain("Ask someone at that level");
    expect(refused).toContain("paste the content here");

    // an admin may open it up, and then the pal gets through
    expect(await dispatchCommand(deps, pal, "C1", "read access pal")).toContain("Only admins");
    expect(await dispatchCommand(deps, actor(), "C1", "read access pal")).toContain("open to *pal*");
    expect(deps.settings!.get("read_min_role")).toBe("pal");
    expect(await dispatchCommand(deps, pal, "C1", "read")).toContain("Read what?");
  });

  test("read runs on the host login, and is open to admins by default", async () => {
    // it reads with the authorising human's Slack access, so anyone who can run
    // it can read anything that person can
    const { deps } = withTokens({ [OWNER]: TOKEN });
    let seen: { useHostLogin?: boolean; system?: string } = {};
    deps.llm = {
      complete: async (p) => {
        seen = { useHostLogin: p.useHostLogin, system: p.system };
        return "here is the gist";
      },
    };
    const out = await dispatchCommand(deps, actor(), "C1", "read https://x.slack.com/archives/C1/p1792422356053559 just the decisions");
    expect(seen.useHostLogin).toBe(true);
    expect(seen.system).toContain("just the decisions");
    expect(out).toBe("here is the gist");

    // an admin is above the default floor, so it reaches the brain
    const admin = actor({ slackId: "U0ADMIN99", role: "admin" });
    deps.users.upsert(admin);
    await dispatchCommand(deps, admin, "C1", "read https://x.slack.com/archives/C1/p1");
    expect(seen.useHostLogin).toBe(true);
  });

  test("read needs something to read", async () => {
    const { deps } = withTokens({ [OWNER]: TOKEN });
    expect(await dispatchCommand(deps, actor(), "C1", "read")).toContain("Read what?");
  });

  test("investigate runs on the host login, where the connectors are", async () => {
    // Datadog and its RUM data come from the account's connectors, which a
    // setup token - the bot's or a caller's - carries none of
    const { deps } = withTokens({ [OWNER]: TOKEN });
    let seen: { oauthToken?: string; useHostLogin?: boolean; system?: string } = {};
    deps.llm = {
      complete: async (p) => {
        seen = { oauthToken: p.oauthToken, useHostLogin: p.useHostLogin, system: p.system };
        return "here is what happened";
      },
    };
    const out = await dispatchCommand(deps, actor(), "C1", "investigate why did /home crash");
    expect(seen.useHostLogin).toBe(true);
    expect(seen.oauthToken).toBeUndefined();
    expect(seen.system).toContain("why did /home crash");
    expect(out).toBe("here is what happened");
  });

  test("investigate needs a question, and somewhere to look", async () => {
    const { deps } = withTokens({ [OWNER]: TOKEN });
    expect(await dispatchCommand(deps, actor(), "C1", "investigate")).toContain("What should I look into?");

    deps.settings!.set("log_sources", "");
    const noSources = { ...deps, settings: { ...deps.settings!, get: () => "" } } as typeof deps;
    expect(await dispatchCommand(noSources, actor(), "C1", "investigate why")).not.toContain("What should I look into?");
  });

  test("fanout hands the job to the coordinator prompt", async () => {
    const { deps } = withTokens({ [OWNER]: TOKEN });
    let system = "";
    deps.llm = {
      complete: async (p) => {
        system = p.system ?? "";
        return "two workers done";
      },
    };
    const out = await dispatchCommand(deps, actor(), "C1", "fanout fix the flaky login tests");
    expect(system).toContain("fix the flaky login tests");
    expect(system).toContain("orca worktree create");
    expect(out).toBe("two workers done");
  });

  test("fanout needs a job", async () => {
    const { deps } = withTokens({ [OWNER]: TOKEN });
    expect(await dispatchCommand(deps, actor(), "C1", "fanout")).toContain("What should the agents work on?");
  });

  test("fanout is not open to a pal, since workers bill the host login", async () => {
    const { deps } = withTokens({ [OWNER]: TOKEN });
    let called = false;
    deps.llm = { complete: async () => { called = true; return "x"; } };
    const pal = actor({ slackId: "U0PAL0001", role: "pal" });
    deps.users.upsert(pal);
    await dispatchCommand(deps, pal, "C1", "fanout do things");
    expect(called).toBe(false);
  });

  test("a ticket runs on the host login, never on a setup token", async () => {
    // tickets need Notion, and no setup token - the bot's or a caller's - carries
    // any claude.ai connector authorisation
    const { deps } = withTokens({ [OWNER]: TOKEN });
    deps.settings!.set("ticket_tracker", "https://notion.so/tracker");
    let seen: { oauthToken?: string; useHostLogin?: boolean } = {};
    deps.llm = {
      complete: async (p) => {
        seen = { oauthToken: p.oauthToken, useHostLogin: p.useHostLogin };
        return "raised";
      },
    };
    await dispatchCommand(deps, actor(), "C1", "ticket the webhook retries are dropping");
    expect(seen.useHostLogin).toBe(true);
    expect(seen.oauthToken).toBeUndefined();
  });

  test("a lapsed host login is named, not reported as a failed ticket", async () => {
    const { deps } = withTokens({ [OWNER]: TOKEN });
    deps.settings!.set("ticket_tracker", "https://notion.so/tracker");
    deps.llm = {
      complete: async () => {
        throw new Error("Failed to authenticate. API Error: 401 OAuth access token is invalid.");
      },
    };
    const lines: string[] = [];
    await dispatchCommand(deps, actor(), "C1", "ticket something broke", {
      reply: async (t: string) => {
        lines.push(t);
      },
    });
    const last = lines[lines.length - 1] ?? "";
    expect(last).toContain("login on my host has lapsed");
    expect(last).toContain("sign in again");
  });

  test("a word that is not a PR never reaches the brain", async () => {
    // the bug: `review help` ran a full review of a pull request called "help"
    const { deps, token } = withTokens({ [OWNER]: TOKEN });
    for (const line of ["rv the", "rv acme-api", "rv please have a look"]) {
      const out = await dispatchCommand(deps, actor(), "C1", line);
      expect(out).toContain("Which PR?");
    }
    expect(token()).toBeUndefined(); // nothing expensive was spawned
  });

  test("review help explains itself instead of reviewing something called help", async () => {
    const { deps, token } = withTokens({ [OWNER]: TOKEN });
    const out = await dispatchCommand(deps, actor(), "C1", "rv help");
    expect(out).toContain("How I review a PR");
    expect(out).toContain("your own");
    expect(token()).toBeUndefined();

    const prompt = await dispatchCommand(deps, actor(), "C1", "rv prompt");
    expect(prompt).toContain("doing a real code review");
    expect(token()).toBeUndefined();
  });

  test("a shorthand the brain can resolve is still allowed through", async () => {
    const { deps, sys } = withTokens({ [OWNER]: TOKEN });
    await dispatchCommand(deps, actor(), "C1", "rv acme/acme-api#13600");
    expect(sys()).toContain("acme/acme-api#13600");
  });

  test("token who lists the people who gave me one, and is admin-only", async () => {
    // it used to answer with the usage line: the catch-all sat above this branch
    const { deps } = withTokens({ [OWNER]: TOKEN });
    const out = await dispatchCommand(deps, actor(), "C1", "token who");
    expect(out).toContain(`<@${OWNER}>`);
    expect(out).toContain("1 person has");
    expect(out).not.toContain("to add or replace one");
    expect(out).not.toContain(TOKEN);

    const pal = actor({ slackId: "U0PAL0005", role: "pal" });
    deps.users.upsert(pal);
    expect(await dispatchCommand(deps, pal, "C1", "token who")).toContain("Only admins");
  });

  test("token who says plainly when nobody has one", async () => {
    const { deps } = withTokens();
    const out = await dispatchCommand(deps, actor(), "C1", "token list");
    expect(out).toContain("Nobody has given me a token yet");
    expect(out).toContain("nobody can run a review");
  });

  test("token reports what is on file and forgets it on request", async () => {
    const { deps } = withTokens({ [OWNER]: TOKEN });
    expect(await dispatchCommand(deps, actor(), "C1", "token")).toContain("…aaaa");
    expect(await dispatchCommand(deps, actor(), "C1", "token remove")).toContain("Forgotten");
    expect(await dispatchCommand(deps, actor(), "C1", "token remove")).toContain("did not have");
    // and it never asks anyone to type one into a channel
    const asked = await dispatchCommand(deps, actor(), "C1", "token");
    expect(asked).toContain("claude setup-token");
    expect(asked).not.toContain("token <");
  });
});

describe("review fan-out cap", () => {
  const PR = "https://github.com/o/r/pull/1";

  const withBrain = () => {
    const deps = build();
    deps.settings = createSettingsRepo(db);
    let system = "";
    deps.llm = {
      complete: async (p) => {
        system = p.system;
        return "the review";
      },
    };
    return { deps, sys: () => system };
  };

  test("the default cap reaches the brain's prompt", async () => {
    const { deps, sys } = withBrain();
    await dispatchCommand(deps, actor(), "C1", `rv ${PR}`);
    expect(sys()).toContain("at most 3 child agents");
  });

  test("words typed next to the url become guidance, not a review target", async () => {
    const { deps, sys } = withBrain();
    const lines: string[] = [];
    await dispatchCommand(deps, actor(), "C1", `rv ${PR} focus on the sql migration`, {
      reply: async (t: string) => {
        lines.push(t);
      },
    });
    expect(sys()).toContain("focus on the sql migration");
    expect(sys()).toContain("What the person asking wants you to look at");
    // the note is not mistaken for a second PR
    expect(sys()).toContain(PR);
    expect(lines.some((l) => l.includes("_looking at: focus on the sql migration_"))).toBe(true);
  });

  test("no note, no guidance section", async () => {
    const { deps, sys } = withBrain();
    await dispatchCommand(deps, actor(), "C1", `rv ${PR}`);
    expect(sys()).not.toContain("in their words");
  });

  test("a configured cap replaces it", async () => {
    const { deps, sys } = withBrain();
    await dispatchCommand(deps, actor(), "C1", "review-agents 5");
    await dispatchCommand(deps, actor(), "C1", `rv ${PR}`);
    expect(sys()).toContain("at most 5 child agents");
  });

  test("admins set it, anyone reads it, junk is refused", async () => {
    const deps = build();
    deps.settings = createSettingsRepo(db);
    const pal = actor({ slackId: "U0PAL0002", role: "pal" });

    expect(await dispatchCommand(deps, pal, "C1", "review-agents 2")).toContain("Only admins");
    expect(await dispatchCommand(deps, actor(), "C1", "review-agents 0")).toContain("A number from 1");
    expect(await dispatchCommand(deps, actor(), "C1", "review-agents 99")).toContain("A number from 1");
    expect(await dispatchCommand(deps, actor(), "C1", "review-agents lots")).toContain("A number from 1");

    expect(await dispatchCommand(deps, actor(), "C1", "review-agents 2")).toContain("at most *2* child agents");
    expect(await dispatchCommand(deps, pal, "C1", "review-agents")).toContain("at most *2*");
    expect(deps.settings.get("review_agents")).toBe("2");

    await dispatchCommand(deps, actor(), "C1", "review-agents default");
    expect(await dispatchCommand(deps, pal, "C1", "review-agents")).toContain("the default");
  });

  test("a second comment is announced as a follow-up, not as the review again", async () => {
    // the late-finding case: an agent reports back after the review is posted
    const streamed: LlmPort = {
      complete: async () => "unused",
      stream: async (_p, sink) => {
        const emit = (id: string, command: string) =>
          sink({ type: "tool", id, title: command, command, status: "complete" });
        emit("t1", `gh pr comment ${PR} --body "the review"`);
        emit("t2", `gh pr comment ${PR} --body "one more thing, blocking"`);
        return "done";
      },
    };
    const deps = build();
    deps.settings = createSettingsRepo(db);
    const lines: string[] = [];
    await dispatchCommand({ ...deps, llm: streamed }, actor(), "C1", `rv ${PR}`, {
      reply: async (t: string) => {
        lines.push(t);
      },
    });
    expect(lines.some((l) => l.startsWith(`📝 posted the review on ${PR}`))).toBe(true);
    expect(lines.some((l) => l.startsWith(`📝 posted a follow-up on ${PR}`))).toBe(true);
  });

  test("a review cut off mid-run is reported as unfinished, not posted as the review", async () => {
    // the failure this exists for: the 10-minute timeout reaped a run whose
    // streamed narration then went out as if it were the finished review
    const streamed: LlmPort = {
      complete: async () => "unused",
      stream: async (_p, sink) => {
        sink({ type: "aborted", reason: "it ran out of time" });
        return "waiting on the agents";
      },
    };
    const deps = build();
    deps.settings = createSettingsRepo(db);
    deps.github = {
      whoami: async () => undefined,
      reviewDecision: async () => undefined,
      approve: async () => ({ ok: true }),
    };
    const lines: string[] = [];
    await dispatchCommand({ ...deps, llm: streamed }, actor(), "C1", `rv ${PR}`, {
      reply: async (t: string) => {
        lines.push(t);
      },
    });
    const last = lines[lines.length - 1] ?? "";
    expect(last).toContain("did not finish");
    expect(last).toContain("ran out of time");
    expect(last).toContain("how far it got");
  });

  test("an approve-after repo is not approved when the run is cut off", async () => {
    const streamed: LlmPort = {
      complete: async () => "unused",
      stream: async (_p, sink) => {
        sink({ type: "aborted", reason: "it ran out of time" });
        return "partial";
      },
    };
    const deps = build();
    deps.settings = createSettingsRepo(db);
    const approved: string[] = [];
    deps.github = {
      whoami: async () => undefined,
      reviewDecision: async () => undefined,
      approve: async (url) => {
        approved.push(url);
        return { ok: true };
      },
    };
    await dispatchCommand(deps, actor(), "C1", "review-agents default");
    await dispatchCommand(deps, actor(), "C1", "review-policy o/r after");
    await dispatchCommand({ ...deps, llm: streamed }, actor(), "C1", `rv ${PR}`, {
      reply: async () => {},
    });
    expect(approved).toEqual([]); // no review came back, so nothing is clean
  });
});

describe("per-repo review policy", () => {
  const PR = "https://github.com/acme/report-exports/pull/905";
  const OTHER = "https://github.com/acme/acme-api/pull/1";

  const withPolicy = (decision?: string) => {
    const deps = build();
    deps.settings = createSettingsRepo(db);
    const calls: string[] = [];
    deps.github = {
      whoami: async () => undefined,
      reviewDecision: async () => decision,
      approve: async (url) => {
        calls.push(url);
        return { ok: true };
      },
    };
    let system = "";
    deps.llm = {
      complete: async (p) => {
        system = p.system;
        return "the review";
      },
    };
    const lines: string[] = [];
    const reply = async (t: string) => {
      lines.push(t);
    };
    return { deps, calls, lines, reply, sys: () => system };
  };

  test("by default nothing is approved before the review: reviewing -> review -> approved, only if clean", async () => {
    // Regression: the approval used to land ~2s after the command, before any
    // review ran, and was posted ahead of "reviewing".
    const { deps, calls, lines, reply } = withPolicy();
    const order: string[] = [];
    const approve = deps.github!.approve;
    deps.github!.approve = async (url) => {
      order.push("approve");
      return approve(url);
    };
    const llm = deps.llm!;
    deps.llm = {
      complete: async (p) => {
        order.push("review");
        expect(calls).toEqual([]); // not approved while the review runs
        return llm.complete(p);
      },
    };
    await dispatchCommand(deps, actor(), "C1", `rv ${OTHER}`, { reply });
    expect(order).toEqual(["review", "approve"]);
    expect(calls).toEqual([OTHER]);
    expect(lines[0]).toContain("reviewing");
    expect(lines[1]).toBe("the review");
    expect(lines[lines.length - 1]).toContain("the review came back clean");
    expect(lines.findIndex((l) => l.startsWith("✅ approved"))).toBeGreaterThan(lines.indexOf("the review"));
  });

  test("a blocked review on the default policy is never approved", async () => {
    const { deps, calls, lines, reply } = withPolicy("CHANGES_REQUESTED");
    await dispatchCommand(deps, actor(), "C1", `rv ${OTHER}`, { reply });
    expect(calls).toEqual([]);
    expect(lines.some((l) => l.startsWith("✅ approved"))).toBe(false);
  });

  test("a repo opted in to approve-first announces 'reviewing' before the approval", async () => {
    const { deps, calls, lines, reply } = withPolicy();
    await dispatchCommand(deps, actor(), "C1", "review-policy acme/acme-api first");
    await dispatchCommand(deps, actor(), "C1", `rv ${OTHER}`, { reply });
    expect(calls).toEqual([OTHER]);
    expect(lines[0]).toContain("reviewing");
    expect(lines[1]).toBe(`✅ approved ${OTHER}`);
  });

  test("a bare approve still works on a repo with no explicit policy", async () => {
    const { deps, calls } = withPolicy();
    expect(await dispatchCommand(deps, actor(), "C1", `approve ${OTHER}`)).toContain(`✅ approved ${OTHER}`);
    expect(calls).toEqual([OTHER]);
  });

  test("on approve-after nothing is approved up front", async () => {
    const { deps, calls, lines, reply, sys } = withPolicy(undefined);
    await dispatchCommand(deps, actor(), "C1", "review-policy acme/report-exports after");

    await dispatchCommand(deps, actor(), "C1", `rv ${PR}`, { reply });
    expect(lines[0]).toContain("reviewing"); // no approval line first
    // and the brain is told there is no approval to lean on
    expect(sys()).toContain("NOT approved, and not yours to approve");
    // approved only once the review came back clean
    expect(calls).toEqual([PR]);
    expect(lines[lines.length - 1]).toContain("the review came back clean");
  });

  test("--policy after holds the approval back for one run, without writing it down", async () => {
    const { deps, calls, lines, reply } = withPolicy(undefined);
    await dispatchCommand(deps, actor(), "C1", `rv ${OTHER} --policy after`, { reply });

    expect(lines[0]).toContain("reviewing"); // no approval up front
    expect(lines[0]).toContain("approve-after");
    expect(lines[lines.length - 1]).toContain("the review came back clean");
    expect(calls).toEqual([OTHER]); // approved only after
    // and the repo is still on its own policy for the next one
    expect(deps.settings!.get("review_policy:acme/acme-api")).toBeUndefined();
  });

  test("the flag is not mistaken for a PR or for the steering note", async () => {
    const { deps, lines, reply, sys } = withPolicy(undefined);
    await dispatchCommand(deps, actor(), "C1", `rv ${OTHER} --policy after check the migration`, { reply });
    expect(sys()).toContain("check the migration");
    expect(sys()).not.toContain("--policy");
    expect(lines.some((l) => l.includes("_looking at: check the migration_"))).toBe(true);
  });

  test("loosening an approve-after repo takes an admin; tightening does not", async () => {
    const { deps, calls, reply } = withPolicy(undefined);
    await dispatchCommand(deps, actor(), "C1", "review-policy acme/report-exports after");
    const pal = actor({ slackId: "U0PAL0006", role: "pal" });
    deps.users.upsert(pal);

    // a pal has no say in the policy at all, not even for one run
    const refused = await dispatchCommand(deps, pal, "C1", `rv ${PR} --policy first`, { reply });
    expect(refused).toContain("not a pal's to set");
    expect(calls).toEqual([]); // nothing approved

    // an executer may ask for the stricter run, but not the looser one
    const exec = actor({ slackId: "U0EXE0006", role: "executer" });
    deps.users.upsert(exec);
    expect(await dispatchCommand(deps, exec, "C1", `rv ${PR} --policy first`, { reply })).toContain("only an admin");
    await dispatchCommand(deps, exec, "C1", `rv ${OTHER} --policy after`, { reply });
    expect(calls).toEqual([OTHER]); // approved after the review, not before
  });

  test("a pal cannot see or set review policy", async () => {
    const { deps } = withPolicy(undefined);
    const pal = actor({ slackId: "U0PAL0009", role: "pal" });
    deps.users.upsert(pal);
    expect(await dispatchCommand(deps, pal, "C1", "review-policy")).toContain("needs *admin*");
    expect(await dispatchCommand(deps, pal, "C1", "review-policy acme/acme-api first")).toContain("needs *admin*");
    expect(deps.settings!.get("review_policy:acme/acme-api")).toBeUndefined();
  });

  test("a pal's review never approves up front, whatever the repo is on", async () => {
    const { deps, calls, lines, reply } = withPolicy(undefined);
    const pal = actor({ slackId: "U0PAL0007", role: "pal" });
    deps.users.upsert(pal);

    await dispatchCommand(deps, pal, "C1", `rv ${OTHER}`, { reply });
    expect(lines[0]).toContain("reviewing"); // no approval line first
    expect(lines[lines.length - 1]).toContain("the review came back clean");
    expect(calls).toEqual([OTHER]); // approved only after

    const refused = await dispatchCommand(deps, pal, "C1", `rv ${OTHER} --policy first`, { reply });
    expect(refused).toContain("not a pal's to set");
    expect(calls).toEqual([OTHER]); // nothing more approved
  });

  test("an executer's review approves up front only when asked with --policy first", async () => {
    const { deps, calls, lines, reply } = withPolicy(undefined);
    const exec = actor({ slackId: "U0EXE0007", role: "executer" });
    deps.users.upsert(exec);
    await dispatchCommand(deps, exec, "C1", `rv ${OTHER} --policy first`, { reply });
    expect(lines[0]).toContain("reviewing");
    expect(lines[1]).toBe(`✅ approved ${OTHER}`);
    expect(calls).toEqual([OTHER]);
  });

  test("several PRs share the run's policy, and the note is not eaten", async () => {
    const { deps, calls, lines, reply, sys } = withPolicy(undefined);
    const second = "https://github.com/acme/acme-api/pull/2";
    await dispatchCommand(deps, actor(), "C1", `rv ${OTHER} --policy after ${second} check the migration`, {
      reply,
    });
    expect(calls).toEqual([OTHER, second]); // both approved only after the review
    expect(lines[0]).toContain(OTHER);
    expect(lines[0]).toContain(second);
    expect(sys()).toContain("check the migration");
  });

  test("a note that merely looks like the flag does not stop the review", async () => {
    const { deps, sys, lines, reply } = withPolicy(undefined);
    await dispatchCommand(deps, actor(), "C1", `rv ${OTHER} check the policy:handler code`, { reply });
    expect(sys()).toContain("check the policy:handler code");
    expect(lines.some((l) => l.includes("is not a policy"))).toBe(false);
  });

  test("a policy that is not one is refused rather than quietly ignored", async () => {
    const { deps } = withPolicy(undefined);
    expect(await dispatchCommand(deps, actor(), "C1", `rv ${PR} --policy sometimes`)).toContain(
      "is not a policy",
    );
  });

  test("a blocked review is not approved at all", async () => {
    const { deps, calls, lines, reply } = withPolicy("CHANGES_REQUESTED");
    await dispatchCommand(deps, actor(), "C1", "review-policy acme/report-exports after");

    await dispatchCommand(deps, actor(), "C1", `rv ${PR}`, { reply });
    expect(calls).toEqual([]); // never approved
    expect(lines[lines.length - 1]).toContain("not approving");
    expect(lines[lines.length - 1]).toContain("changes are requested");
  });

  test("the policy is per repo, so others are untouched", async () => {
    const { deps, calls, lines, reply } = withPolicy();
    await dispatchCommand(deps, actor(), "C1", "review-policy acme/report-exports after");
    await dispatchCommand(deps, actor(), "C1", "review-policy acme/acme-api first");

    await dispatchCommand(deps, actor(), "C1", `rv ${OTHER}`, { reply });
    expect(lines[1]).toBe(`✅ approved ${OTHER}`); // still approved up front, after "reviewing"
    expect(calls).toEqual([OTHER]);
  });

  test("admins set and read it, a pal gets neither, junk is refused", async () => {
    const deps = build();
    deps.settings = createSettingsRepo(db);
    const pal = actor({ slackId: "U0PAL0001", role: "pal" });

    expect(await dispatchCommand(deps, pal, "C1", "review-policy acme/x after")).toContain("needs *admin*");
    expect(await dispatchCommand(deps, actor(), "C1", "review-policy notarepo after")).toContain("Which repo?");
    expect(await dispatchCommand(deps, actor(), "C1", "review-policy acme/x sometimes")).toContain(
      "First or after?",
    );

    await dispatchCommand(deps, actor(), "C1", "review-policy acme/x after");
    expect(await dispatchCommand(deps, pal, "C1", "review-policy acme/x")).toContain("needs *admin*");
    expect(await dispatchCommand(deps, actor(), "C1", "review-policy acme/x")).toContain("approve-after");
    expect(await dispatchCommand(deps, actor(), "C1", "review-policy")).toContain("acme/x");

    await dispatchCommand(deps, actor(), "C1", "review-policy acme/x default");
    expect(await dispatchCommand(deps, actor(), "C1", "review-policy acme/x")).toContain("uses the default");
  });

  test("an author on approve-after is reviewed first, whatever the repo is on", async () => {
    const { deps, calls, lines, reply } = withPolicy(undefined);
    deps.github!.author = async (url) => (url === PR ? "app/morcela-agent" : "kai");
    // the API spelling of the same app, so either one sets it
    await dispatchCommand(deps, actor(), "C1", "review-policy author:morcela-agent[bot] after");

    await dispatchCommand(deps, actor(), "C1", `rv ${PR}`, { reply });
    expect(lines[0]).toContain("reviewing"); // no approval up front
    expect(calls).toEqual([PR]); // approved only once the review came back clean

    // someone else's PR is still on the repo's policy (opted in to approve-first here)
    await dispatchCommand(deps, actor(), "C1", "review-policy acme/acme-api first");
    lines.length = 0;
    await dispatchCommand(deps, actor(), "C1", `rv ${OTHER}`, { reply });
    expect(lines[1]).toBe(`✅ approved ${OTHER}`);
  });

  test("an author hold blocks a bare approve and an executer's --policy first", async () => {
    const { deps, calls, reply } = withPolicy(undefined);
    deps.github!.author = async () => "app/morcela-agent";
    await dispatchCommand(deps, actor(), "C1", "review-policy @morcela-agent after");
    const exec = actor({ slackId: "U0EXE0007", role: "executer" });
    deps.users.upsert(exec);

    expect(await dispatchCommand(deps, actor(), "C1", `approve ${PR}`)).toContain("only after a clean review");
    expect(await dispatchCommand(deps, exec, "C1", `rv ${PR} --policy first`, { reply })).toContain("only an admin");
    expect(calls).toEqual([]);
  });

  test("author policies are listed, read back, and reset", async () => {
    const deps = build();
    deps.settings = createSettingsRepo(db);
    await dispatchCommand(deps, actor(), "C1", "review-policy author:app/morcela-agent after");
    expect(deps.settings.get("review_policy_author:morcela-agent")).toBe("approve-after");
    expect(await dispatchCommand(deps, actor(), "C1", "review-policy")).toContain("author `morcela-agent`");
    expect(await dispatchCommand(deps, actor(), "C1", "review-policy author:morcela-agent")).toContain(
      "approve-after",
    );
    expect(await dispatchCommand(deps, actor(), "C1", "review-policy author:-bad-")).toContain("Which author?");
    await dispatchCommand(deps, actor(), "C1", "review-policy author:morcela-agent default");
    expect(await dispatchCommand(deps, actor(), "C1", "review-policy author:morcela-agent")).toContain(
      "uses the default",
    );
  });

  test("a PR url works as the repo argument too", async () => {
    const deps = build();
    deps.settings = createSettingsRepo(db);
    await dispatchCommand(deps, actor(), "C1", `review-policy ${PR} after`);
    expect(deps.settings.get("review_policy:acme/report-exports")).toBe("approve-after");
  });
});

describe("logsource", () => {
  const withSettings = () => {
    const deps = build();
    deps.settings = createSettingsRepo(db);
    return deps;
  };

  test("anyone can see where I look, grafana first by default", async () => {
    const deps = withSettings();
    const pal = actor({ slackId: "U0PAL0001", role: "pal" });
    const out = await dispatchCommand(deps, pal, "C1", "logsource");
    expect(out).toContain("*grafana* → *datadog*");
    expect(out).toContain("Never by hand: *cloudwatch*");
  });

  test("an admin reorders it", async () => {
    const deps = withSettings();
    const out = await dispatchCommand(deps, actor(), "C1", "logsource datadog,grafana");
    expect(out).toContain("*datadog* → *grafana*");
    expect(deps.settings!.get("log_sources")).toBe("datadog,grafana");
  });

  test("default puts it back", async () => {
    const deps = withSettings();
    await dispatchCommand(deps, actor(), "C1", "logsource grafana");
    await dispatchCommand(deps, actor(), "C1", "logsource default");
    expect(deps.settings!.get("log_sources")).toBe("");
    expect(await dispatchCommand(deps, actor(), "C1", "logsource")).toContain("*grafana* → *datadog*");
  });

  test("a backend I cannot reach is refused, not silently dropped", async () => {
    const deps = withSettings();
    const out = await dispatchCommand(deps, actor(), "C1", "logsource grafana,cloudwatch");
    expect(out).toContain("*cloudwatch*");
    expect(out).toContain("Pick from");
    expect(deps.settings!.get("log_sources")).toBeUndefined(); // nothing half-applied
  });

  test("a pal cannot change it", async () => {
    const deps = withSettings();
    const pal = actor({ slackId: "U0PAL0001", role: "pal" });
    expect(await dispatchCommand(deps, pal, "C1", "logsource datadog")).toContain("Only admins");
    expect(deps.settings!.get("log_sources")).toBeUndefined();
  });
});

describe("review-inbox command", () => {
  test("admin sets the channel and starts from now", async () => {
    const deps = build();
    deps.settings = createSettingsRepo(db);
    const out = await dispatchCommand(deps, actor(), "C1", "review-inbox channel <#C0TEST00003|pull-requests>");
    expect(out).toContain("<#C0TEST00003>");
    expect(deps.settings.get("review_inbox_channel")).toBe("C0TEST00003");
    expect(deps.settings.get("review_inbox_cursor")).toBe(new Date(42).toISOString());
  });

  test("a pal links their own GitHub login, not someone else's", async () => {
    const deps = build();
    deps.settings = createSettingsRepo(db);
    const pal = actor({ slackId: "U0PAL0099", role: "pal" });
    await dispatchCommand(deps, pal, "C1", "review-inbox link pal-gh");
    expect(deps.settings.get("github_login:pal-gh")).toBe("U0PAL0099");
    expect(await dispatchCommand(deps, pal, "C1", "review-inbox link other-gh <@U0OTHER01>")).toContain("only an admin");
    expect(await dispatchCommand(deps, pal, "C1", "review-inbox channel <#C123>")).toContain("Only admins");
  });

  test("an admin links someone else", async () => {
    const deps = build();
    deps.settings = createSettingsRepo(db);
    await dispatchCommand(deps, actor(), "C1", "review-inbox link Dev-GH <@U0DEV0001>");
    expect(deps.settings.get("github_login:dev-gh")).toBe("U0DEV0001");
    expect(await dispatchCommand(deps, actor(), "C1", "review-inbox")).toContain("`dev-gh` -> <@U0DEV0001>");
  });
});
