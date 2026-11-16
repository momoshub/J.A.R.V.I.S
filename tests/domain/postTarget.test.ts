import { describe, expect, test } from "bun:test";
import { parsePostTarget } from "../../src/domain/slackLinks.ts";

describe("parsePostTarget", () => {
  test("channel mention, id and #id are the channel's top level", () => {
    expect(parsePostTarget("<#C0TEST00002|infra>")).toEqual({ kind: "channel", channel: "C0TEST00002" });
    expect(parsePostTarget("<#C0TEST00002>")).toEqual({ kind: "channel", channel: "C0TEST00002" });
    expect(parsePostTarget("C0TEST00002")).toEqual({ kind: "channel", channel: "C0TEST00002" });
    expect(parsePostTarget("#G0TEST00001")).toEqual({ kind: "channel", channel: "G0TEST00001" });
  });
  test("#name is a name to look up, lowercased", () => {
    expect(parsePostTarget("#Infra-team")).toEqual({ kind: "name", name: "infra-team" });
  });
  test("a message link is its thread; a reply link uses thread_ts", () => {
    const base = "https://team.slack.com/archives/C0TEST00001/p1787122692303399";
    expect(parsePostTarget(`<${base}>`)).toEqual({ kind: "thread", channel: "C0TEST00001", threadTs: "1787122692.303399" });
    expect(parsePostTarget(`${base}?thread_ts=1787000000.000100&amp;cid=C0TEST00001`)).toEqual({
      kind: "thread",
      channel: "C0TEST00001",
      threadTs: "1787000000.000100",
    });
  });
  test("a bare word, a non-slack link and junk are no target", () => {
    expect(parsePostTarget("infra")).toBeUndefined();
    expect(parsePostTarget("hello")).toBeUndefined();
    expect(parsePostTarget("https://example.com/x")).toBeUndefined();
    expect(parsePostTarget("#")).toBeUndefined();
    expect(parsePostTarget("<#lowercase|x>")).toBeUndefined();
  });
});
