import { describe, expect, test } from "bun:test";
import { linkThread, reportsCover } from "../../src/domain/bugReport.ts";

describe("bug report thread link", () => {
  test("a message link is read as its channel and Slack ts", () => {
    expect(linkThread("https://acme.slack.com/archives/C123/p1700000000123456")).toEqual({
      channelId: "C123",
      threadTs: "1700000000.123456",
    });
  });

  test("a reply link points at the thread root in thread_ts, not at the reply", () => {
    expect(linkThread("https://acme.slack.com/archives/C123/p1700000099000200?thread_ts=1700000000.123456&cid=C123")).toEqual({
      channelId: "C123",
      threadTs: "1700000000.123456",
    });
  });

  test("a link that is not a message link has no thread", () => {
    expect(linkThread("https://example.com/x")).toBeUndefined();
  });

  test("reports cover only the same channel and thread, never an empty thread", () => {
    const reports = [{ threadLink: "https://acme.slack.com/archives/C123/p1700000000123456" }];
    expect(reportsCover(reports, "C123", "1700000000.123456")).toBe(true);
    expect(reportsCover(reports, "C123", "1700000000.999999")).toBe(false);
    expect(reportsCover(reports, "C999", "1700000000.123456")).toBe(false);
    expect(reportsCover(reports, "C123", "")).toBe(false);
    expect(reportsCover([], "C123", "1700000000.123456")).toBe(false);
  });
});
