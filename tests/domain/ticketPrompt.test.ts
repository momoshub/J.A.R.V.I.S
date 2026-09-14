import { describe, expect, test } from "bun:test";
import { canRaiseTickets, ticketChatRules, ticketPrompt } from "../../src/domain/ticketPrompt.ts";

const SOURCES = {
  tracker: "https://notion.so/tracker",
  sop: "https://notion.so/sop",
  pods: "https://notion.so/pods",
  repos: ["acme/acme-be"],
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
    expect(p).toContain("acme/acme-be - and nowhere else");
    expect(p).toContain("SMALL means obvious and low risk");
    expect(p).toContain("it is not small");
    expect(p).toContain("Guessing at a fix is worse than not fixing");
    // the reviewer has to be justified, which is the whole complaint about random assignment
    expect(p).toContain("CODEOWNERS for the touched files first");
    expect(p).toContain("Never assign at random");
  });

  test("with no repos configured it must not open a PR at all", () => {
    const p = ticketPrompt("x", "Evie", { ...SOURCES, repos: [] });
    expect(p).toContain("do NOT open a PR");
    expect(p).not.toContain("SMALL means");
  });

  test("reports back short, with the gaps admitted", () => {
    const p = ticketPrompt("x", "Evie", SOURCES);
    expect(p).toContain("anything you could not fill in and why");
    expect(p).toContain("an honest gap is fine, a confident invention is not");
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
