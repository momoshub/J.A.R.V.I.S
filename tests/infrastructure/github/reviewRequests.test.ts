import { describe, expect, test } from "bun:test";
import { latestRequestOf } from "../../../src/infrastructure/github/reviewRequests.ts";

describe("latestRequestOf", () => {
  test("the latest request of me, with who asked", () => {
    const events = [
      { event: "review_requested", created_at: "2026-11-01T00:00:00Z", actor: { login: "a" }, requested_reviewer: { login: "Me" } },
      { event: "review_requested", created_at: "2026-11-02T00:00:00Z", actor: { login: "b" }, requested_reviewer: { login: "other" } },
      { event: "commented", created_at: "2026-11-03T00:00:00Z", actor: { login: "c" } },
      { event: "review_requested", created_at: "2026-11-04T00:00:00Z", actor: { login: "d" }, requested_reviewer: { login: "me" } },
    ];
    expect(latestRequestOf(events, "me")).toEqual({ requester: "d", requestedAt: "2026-11-04T00:00:00Z" });
  });

  test("a team request or none is nothing", () => {
    expect(latestRequestOf([{ event: "review_requested", created_at: "x", actor: { login: "a" } }], "me")).toBeUndefined();
  });
});
