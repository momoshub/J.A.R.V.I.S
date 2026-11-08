import { describe, expect, test } from "bun:test";
import {
  isArmedNotice,
  OFFLINE_ALARM_LEAD_MS,
  OFFLINE_ALARM_TICK_MS,
  offlineNotice,
  onlineNotice,
  openOfflineBeat,
  outageLength,
} from "../../src/domain/offlineAlarm.ts";

describe("offline notice", () => {
  test("carries its heartbeat in the block id, so a new process can close it", () => {
    const n = offlineNotice(1_700_000_000_000);
    expect(openOfflineBeat(n.blocks)).toBe(1_700_000_000_000);
    expect(isArmedNotice(n.text)).toBe(true);
    expect(n.text).toContain("<!date^1700000000^");
  });

  test("once closed it is no longer open", () => {
    expect(openOfflineBeat(onlineNotice(1_000, 301_000).blocks)).toBeUndefined();
    expect(isArmedNotice(onlineNotice(1_000, 301_000).text)).toBe(false);
  });

  test("matches the text as the scheduled list returns it, emoji as shortcodes", () => {
    expect(isArmedNotice(":electric_plug: Jarvis is offline - the host lost its connection.")).toBe(true);
  });

  test("anything else is not ours", () => {
    expect(openOfflineBeat(undefined)).toBeUndefined();
    expect(openOfflineBeat([{ type: "section", block_id: "abc" }, { type: "divider" }])).toBeUndefined();
    expect(openOfflineBeat([{ block_id: "jv-offline:nope" }])).toBeUndefined();
    expect(isArmedNotice("hello")).toBe(false);
    expect(isArmedNotice(undefined)).toBe(false);
  });

  test("the back-online edit says how long it was gone", () => {
    expect(onlineNotice(0, 5 * 60_000).text).toContain("about 5 min");
  });
});

describe("outageLength", () => {
  test("rounds up and never says zero", () => {
    expect(outageLength(0)).toBe("1 min");
    expect(outageLength(61_000)).toBe("2 min");
    expect(outageLength(60 * 60_000)).toBe("1 h");
    expect(outageLength(72 * 60_000)).toBe("1 h 12 min");
  });
});

describe("alarm timing", () => {
  test("the lead stays clear of Slack's ~5 min window where a cancel is ignored", () => {
    // Inside it chat.deleteScheduledMessage answers ok and the notice posts anyway.
    expect(OFFLINE_ALARM_LEAD_MS - OFFLINE_ALARM_TICK_MS).toBeGreaterThan(5 * 60_000);
  });
});
