import { describe, expect, test } from "bun:test";
import {
  advanceCursor,
  matchByName,
  newRequests,
  announceRequest,
  normaliseName,
  type ReviewRequest,
} from "../../src/domain/reviewInbox.ts";

const req = (over: Partial<ReviewRequest> = {}): ReviewRequest => ({
  prUrl: "https://github.com/o/r/pull/1",
  repo: "o/r",
  number: 1,
  title: "fix it",
  requester: "dev",
  requestedAt: "2026-11-06T10:00:00Z",
  ...over,
});

describe("review inbox domain", () => {
  test("only requests after the cursor, oldest first, no repeats", () => {
    const a = req({ requestedAt: "2026-11-06T10:05:00Z", prUrl: "https://github.com/o/r/pull/2" });
    const b = req({ requestedAt: "2026-11-06T10:01:00Z" });
    const old = req({ requestedAt: "2026-11-06T09:00:00Z", prUrl: "https://github.com/o/r/pull/3" });
    expect(newRequests([a, b, b, old], "2026-11-06T10:00:00Z")).toEqual([b, a]);
  });

  test("a re-request after the cursor counts again", () => {
    expect(newRequests([req({ requestedAt: "2026-11-06T11:00:00Z" })], "2026-11-06T10:00:00Z")).toHaveLength(1);
  });

  test("the cursor only moves forward", () => {
    expect(advanceCursor("2026-11-06T10:00:00Z", [req({ requestedAt: "2026-11-06T09:00:00Z" })])).toBe(
      "2026-11-06T10:00:00Z",
    );
    expect(advanceCursor("2026-11-06T10:00:00Z", [req({ requestedAt: "2026-11-06T10:02:00Z" })])).toBe(
      "2026-11-06T10:02:00Z",
    );
  });

  test("names match without diacritics or case", () => {
    expect(normaliseName("Trần Văn Minh")).toBe("tran van minh");
    const people = [
      { slackId: "U1", displayName: "Tran Van Minh" },
      { slackId: "U2", displayName: "Someone Else" },
    ];
    expect(matchByName("minh-x", "Trần Văn Minh", people)).toBe("U1");
  });

  test("two people with the same name is no answer", () => {
    const people = [
      { slackId: "U1", displayName: "Sam Example" },
      { slackId: "U2", displayName: "sam example" },
    ];
    expect(matchByName("an", "Sam Example", people)).toBeUndefined();
  });

  test("no name match is no answer", () => {
    expect(matchByName("ghost", undefined, [{ slackId: "U1", displayName: "Kai" }])).toBeUndefined();
  });

  test("the announcement says how to ask for a review and starts none", () => {
    const text = announceRequest(req(), "UDEV", "bot-gh", "X/jv");
    expect(text).toContain("<@UDEV> requested a review from `bot-gh`");
    expect(text).toContain("nothing runs by itself");
    expect(text).toContain("`X/jv quick-review https://github.com/o/r/pull/1`");
    expect(text).toContain("tag me with `review https://github.com/o/r/pull/1`");
  });

  test("a requester with no Slack account is named by their GitHub login", () => {
    expect(announceRequest(req(), undefined, "bot-gh", "X/jv")).toContain("`dev` requested a review");
  });
});
