import { describe, expect, test } from "bun:test";
import { closePrompt } from "../../src/domain/closePrompt.ts";

const req = {
  ref: "GEN-25532",
  why: "safe as deployed, the allowlist covers it",
  tracker: "https://notion.so/tracker",
  askedBy: "U1",
};

describe("closePrompt", () => {
  test("it carries the ticket, the tracker and the reason", () => {
    const p = closePrompt(req, "Bot");
    expect(p).toContain("GEN-25532");
    expect(p).toContain("https://notion.so/tracker");
    expect(p).toContain("safe as deployed");
  });

  test("the status is chosen from the tracker, not assumed", () => {
    // every tracker names its own closing states; asking a human to type
    // "Prod Deployed 🙌" exactly is how a close silently fails
    const p = closePrompt(req, "Bot");
    expect(p).toContain("Do not assume them");
    expect(p).toContain("list the closing values it does have");
  });

  test("it refuses a page outside the tracker", () => {
    expect(closePrompt(req, "Bot")).toContain("closing someone else's page");
  });

  test("it changes ONE property and adds a note, never revising the page", () => {
    const p = closePrompt(req, "Bot");
    expect(p).toContain("Set ONLY the Status");
    expect(p).toContain("You are adding a note, not revising their work");
    expect(p).toContain("delete or archive anything");
  });

  test("a close for 'safe as it stands' must record the residual risk", () => {
    // the S2S allowlist lives on the box and not in the repo, so a redeploy
    // removes it - that is the sentence worth keeping
    const p = closePrompt(req, "Bot");
    expect(p).toContain("residual risk");
    expect(p).toContain("what would have to change for this to matter again");
  });

  test("it never invents a reason", () => {
    expect(closePrompt(req, "Bot")).toContain("invent a reason");
  });

  test("its reply is delivered, so no paste-ready blocks", () => {
    expect(closePrompt(req, "Bot")).toContain("posted into the thread for you");
  });
});
