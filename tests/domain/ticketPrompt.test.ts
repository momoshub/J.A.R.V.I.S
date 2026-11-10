import { describe, expect, test } from "bun:test";
import {
  canOpenPrs,
  canRaiseTickets,
  describeRepoScope,
  parseRepoScope,
  ticketChatRules,
  ticketPrompt,
} from "../../src/domain/ticketPrompt.ts";

const SOURCES = {
  tracker: "https://notion.so/tracker",
  sop: "https://notion.so/sop",
  pods: "https://notion.so/pods",
  repoScope: parseRepoScope("acme/acme-api"),
};

describe("canRaiseTickets", () => {
  test("needs somewhere to put the ticket", () => {
    expect(canRaiseTickets({})).toBe(false);
    expect(canRaiseTickets({ sop: "x", pods: "y" })).toBe(false); // rules but no tracker
    expect(canRaiseTickets({ tracker: "x" })).toBe(true);
  });
});

describe("ticketPrompt", () => {
  test("reads the team's own pages instead of carrying their rules", () => {
    const p = ticketPrompt("inbox is broken", "Evie", SOURCES);
    expect(p).toContain("READ FIRST, DECIDE SECOND");
    expect(p).toContain("https://notion.so/sop");
    expect(p).toContain("https://notion.so/pods");
    expect(p).toContain("Fetch the tracker's schema too");
    expect(p).toContain("Never invent an option value");
  });

  test("routes from the pod document, including its exceptions", () => {
    const p = ticketPrompt("x", "Evie", SOURCES);
    expect(p).toContain("Route it from the pod document, not from the name of the thing");
    expect(p).toContain("follow the exceptions the document states");
    expect(p).toContain("say which you chose and why");
  });

  test("insists on evidence rather than a restated complaint", () => {
    const p = ticketPrompt("x", "Evie", SOURCES, { channelId: "C1", threadTs: "9.9" });
    expect(p).toContain("channel C1, thread 9.9"); // go read the rest of it
    expect(p).toContain("open any screenshot");
    expect(p).toContain("Expected versus actual");
    expect(p).toContain("never invent detail to fill a field");
  });

  test("is willing to decide it is not a ticket at all", () => {
    expect(ticketPrompt("x", "Evie", SOURCES)).toContain("Decide whether it is even a ticket");
  });

  test("opens a PR only for a genuinely small fix, in a listed repo", () => {
    const p = ticketPrompt("x", "Evie", SOURCES);
    expect(p).toContain("`acme/acme-api` - and nowhere else");
    expect(p).toContain("SMALL means obvious and low risk");
    expect(p).toContain("it is not small");
    expect(p).toContain("Guessing at a fix is worse than not fixing");
    // the reviewer has to be justified, which is the whole complaint about random assignment
    expect(p).toContain("CODEOWNERS for the touched files first");
    expect(p).toContain("Never assign at random");
  });

  test("with no repos configured it must not open a PR at all", () => {
    const p = ticketPrompt("x", "Evie", { ...SOURCES, repoScope: parseRepoScope("") });
    expect(p).toContain("do NOT open a PR");
    expect(p).not.toContain("SMALL means");
  });

  test("reports back short, with the gaps admitted", () => {
    const p = ticketPrompt("x", "Evie", SOURCES);
    expect(p).toContain("Keep it to three lines - this is a status, not the ticket again");
    // a gap still gets said, it just does not get a paragraph
    expect(p).toContain("a gap you could not fill");
    expect(p).toContain("add one more line and stop");
  });
});

describe("people fields", () => {
  test("an engineer never lands in the ops field", () => {
    const p = ticketPrompt("x", "Evie", SOURCES);
    expect(p).toContain("an engineer goes in the engineering field, never in the ops field");
    expect(p).toContain("They are not interchangeable");
    expect(p).toContain("not automatically ops");
  });

  test("it checks who someone is rather than assuming", () => {
    const p = ticketPrompt("x", "Evie", SOURCES);
    expect(p).toContain("their Slack profile title");
    expect(p).toContain("leave it blank and say so");
  });

  test("it reads the schema for the fields the SOP does not mention", () => {
    expect(ticketPrompt("x", "Evie", SOURCES)).toContain("the SOP may only document some of them");
  });
});

describe("the link", () => {
  test("goes into the thread the moment the ticket exists", () => {
    const p = ticketPrompt("x", "Evie", SOURCES);
    expect(p).toContain("post its link into the thread on its own");
    expect(p).toContain("do not save it for the summary at the end");
  });
});

describe("repo scope", () => {
  test("a bare name is a whole org, a slashed one is a single repo", () => {
    expect(parseRepoScope("acme")).toEqual({ orgs: ["acme"], repos: [] });
    expect(parseRepoScope("acme/adhoc")).toEqual({ orgs: [], repos: ["acme/adhoc"] });
    expect(parseRepoScope("acme, other/repo")).toEqual({ orgs: ["acme"], repos: ["other/repo"] });
  });

  test("takes a github url and normalises case, without duplicates", () => {
    expect(parseRepoScope("https://github.com/Acme/Adhoc/")).toEqual({ orgs: [], repos: ["acme/adhoc"] });
    expect(parseRepoScope("acme, ACME")).toEqual({ orgs: ["acme"], repos: [] });
  });

  test("malformed entries are dropped, not half-accepted", () => {
    expect(parseRepoScope("a/b/c, !!bad, , /")).toEqual({ orgs: [], repos: [] });
    expect(canOpenPrs(parseRepoScope(""))).toBe(false);
    expect(canOpenPrs(parseRepoScope("acme"))).toBe(true);
  });

  test("an org grant makes the bot verify the repo is really under it", () => {
    const p = ticketPrompt("x", "Evie", { tracker: "t", repoScope: parseRepoScope("acme") });
    expect(p).toContain("every repo in the *acme* org");
    expect(p).toContain("gh repo view <owner>/<repo> --json owner");
    expect(p).toContain("a name that merely looks similar is not good enough");
  });

  test("a plain repo list needs no such check", () => {
    const p = ticketPrompt("x", "Evie", { tracker: "t", repoScope: parseRepoScope("acme/adhoc") });
    expect(p).toContain("`acme/adhoc`");
    expect(p).not.toContain("gh repo view <owner>/<repo> --json owner");
  });

  test("describes itself the same way everywhere", () => {
    expect(describeRepoScope(parseRepoScope(""))).toContain("none");
    expect(describeRepoScope(parseRepoScope("acme, a/b"))).toBe("every repo in the *acme* org, `a/b`");
  });
});

describe("risk", () => {
  test("is measured, not adjectivised", () => {
    const p = ticketPrompt("x", "Evie", SOURCES);
    expect(p).toContain("Measure it, do not adjectivise it");
    expect(p).toContain("go and count");
    expect(p).toContain("blast radius");
  });

  test("is skipped for something trivial", () => {
    expect(ticketPrompt("x", "Evie", SOURCES)).toContain("Skip it for a typo");
  });

  test("a risk that contradicts the priority must be said out loud", () => {
    const p = ticketPrompt("x", "Evie", SOURCES);
    expect(p).toContain("does not match the priority");
    expect(p).toContain("a human should see it");
  });
});

describe("ticketChatRules", () => {
  test("turns a complaint in chat into a ticket", () => {
    const r = ticketChatRules("X/jv", true);
    expect(r).toContain("X/jv ticket");
    expect(r).toContain("more useful than sympathising");
  });

  test("but not a question, an idea, or a duplicate", () => {
    const r = ticketChatRules("X/jv", true);
    expect(r).toContain("Only for an actual defect");
    expect(r).toContain("an idea for a feature is not a bug");
    expect(r).toContain("Do not raise the same thing twice");
    expect(r).toContain("a ticket nobody wanted is worse than a slow one");
  });

  test("silent when there is no tracker to raise into", () => {
    expect(ticketChatRules("X/jv", false)).toBe("");
  });
});

describe("posting, and not apologising for it", () => {
  const p = ticketPrompt("it broke", "Bot", { tracker: "https://notion.so/t" }, { channelId: "C9", threadTs: "1.2" });

  test("it is told HOW to post the link, with its own token", () => {
    // it was told to post the link and never told how; the connector's send
    // tools are denied, so it concluded it had no way to post at all
    expect(p).toContain("chat.postMessage");
    expect(p).toContain("$SLACK_BOT_TOKEN");
    expect(p).toContain('"channel":"C9"');
    expect(p).toContain('"thread_ts":"1.2"');
  });

  test("and that a missing connector tool is not the same as no way to post", () => {
    expect(p).toContain("NOT the same as having no way to post");
  });

  test("its reply is delivered for it, so no apologies and no paste-ready blocks", () => {
    // every run ended with "I couldn't post to the Slack thread... here is the
    // text ready to paste" - posted into the thread, around the text itself
    expect(p).toContain("posted there for you");
    expect(p).toContain('"ready to paste"');
  });

  test("with no channel known it still gets the shape of the call", () => {
    const bare = ticketPrompt("it broke", "Bot", { tracker: "https://notion.so/t" });
    expect(bare).toContain("chat.postMessage");
    expect(bare).not.toContain('"channel":"C9"');
  });
});

describe("when NOT to raise one", () => {
  const rules = ticketChatRules("X/jv", true);

  test("an instruction to fix something is not a report of it", () => {
    // asked to "fix the PII issue yourself, give me a PR", it raised a second
    // ticket for a bug that already had GEN-25537, instead of writing the PR
    expect(rules).toContain("Only for a NEW report");
    expect(rules).toContain("give me a PR");
    expect(rules).toContain("ask for the work, not for a record of it");
  });

  test("dedup cannot rely on memory, because memory is per thread", () => {
    // the first ticket was raised in a DM; this was a channel thread, so the
    // session had no idea it had already filed the same thing
    expect(rules).toContain("do NOT rely on remembering");
    expect(rules).toContain("search the tracker");
    expect(rules).toContain("invisible to you here");
  });
});
