import { describe, expect, test } from "bun:test";
import {
  advanceCursor,
  matchByName,
  newRequests,
  normaliseName,
  reviewLine,
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
    expect(normaliseName("Sam Example")).toBe("sam example");
    const people = [
      { slackId: "U1", displayName: "Sam Example" },
      { slackId: "U2", displayName: "Someone Else" },
    ];
    expect(matchByName("thien-x", "Sam Example", people)).toBe("U1");
  });

  test("two people with the same name is no answer", () => {
    const people = [
      { slackId: "U1", displayName: "Pat Example" },
      { slackId: "U2", displayName: "pat example" },
    ];
    expect(matchByName("an", "Pat Example", people)).toBeUndefined();
  });

  test("no name match is no answer", () => {
    expect(matchByName("ghost", undefined, [{ slackId: "U1", displayName: "Kai" }])).toBeUndefined();
  });

  test("the review always waits for a clean review before approving", () => {
    expect(reviewLine("u", false)).toBe("review u --policy after");
    // A pal review already approves only after, and a pal may not pass --policy.
    expect(reviewLine("u", true)).toBe("review u");
  });
});
