import { describe, expect, test } from "bun:test";
import { createOfflineAlarm, type ChannelMessage, type OfflineAlarmSlack } from "../../src/application/offlineAlarm.ts";
import { offlineNotice, onlineNotice, type AlarmMessage } from "../../src/domain/offlineAlarm.ts";

type Armed = { id: string; postAt: number; text: string };

const fakeSlack = (opts: { offline?: () => boolean; recent?: ChannelMessage[] } = {}) => {
  const armed: Armed[] = [];
  const updates: { ts: string; msg: AlarmMessage }[] = [];
  const calls: string[] = [];
  let next = 0;
  const net = <T>(name: string, fn: () => T): Promise<T> => {
    calls.push(name);
    return opts.offline?.() ? Promise.reject(new Error("ENOTFOUND slack.com")) : Promise.resolve(fn());
  };
  const slack: OfflineAlarmSlack = {
    schedule: (_c, postAt, msg) =>
      net("schedule", () => {
        const id = `Q${++next}`;
        armed.push({ id, postAt, text: msg.text });
        return id;
      }),
    scheduled: () => net("scheduled", () => [...armed, { id: "OTHER", postAt: 0, text: "a real reminder" }]),
    unschedule: (_c, id) =>
      net("unschedule", () => {
        const i = armed.findIndex((a) => a.id === id);
        if (i >= 0) armed.splice(i, 1);
      }),
    recent: () => net("recent", () => opts.recent ?? []),
    update: (_c, ts, msg) => net("update", () => void updates.push({ ts, msg })),
  };
  return { slack, armed, updates, calls };
};

describe("offline alarm", () => {
  test("keeps exactly one notice armed, a lead ahead of now", async () => {
    let now = 1_000_000;
    const s = fakeSlack();
    const alarm = createOfflineAlarm({ channel: "C1", slack: s.slack, clock: () => now, leadMs: 180_000 });
    await alarm.tick();
    now += 60_000;
    await alarm.tick();
    expect(s.armed).toHaveLength(1);
    expect(s.armed[0]?.postAt).toBe(Math.floor((now + 180_000) / 1000));
  });

  test("arms the new one before cancelling the old, so nothing is ever unarmed", async () => {
    const s = fakeSlack();
    const alarm = createOfflineAlarm({ channel: "C1", slack: s.slack, clock: () => 1 });
    await alarm.tick();
    expect(s.calls.indexOf("schedule")).toBeLessThan(s.calls.indexOf("scheduled"));
  });

  test("cancels a notice a previous process left armed, and leaves other scheduled messages alone", async () => {
    const s = fakeSlack();
    s.armed.push({ id: "OLD", postAt: 1, text: offlineNotice(1).text });
    await createOfflineAlarm({ channel: "C1", slack: s.slack, clock: () => 5_000 }).tick();
    expect(s.armed.map((a) => a.id)).toEqual(["Q1"]);
    expect(s.calls.filter((c) => c === "unschedule")).toHaveLength(1);
  });

  test("offline: the tick fails quietly and the armed notice stands", async () => {
    let offline = false;
    const lines: string[] = [];
    const s = fakeSlack({ offline: () => offline });
    const alarm = createOfflineAlarm({ channel: "C1", slack: s.slack, clock: () => 1, log: (l) => lines.push(l) });
    await alarm.tick();
    offline = true;
    await alarm.tick();
    await alarm.tick();
    expect(s.armed).toHaveLength(1);
    expect(lines.filter((l) => l.includes("tick failed"))).toHaveLength(1);
    offline = false;
    await alarm.tick();
    expect(lines.some((l) => l.includes("back online"))).toBe(true);
  });

  test("back online: the notice Slack posted is edited to say how long it was down", async () => {
    const beat = 10 * 60_000;
    const s = fakeSlack({
      recent: [
        { ts: "1.1", blocks: offlineNotice(beat).blocks },
        { ts: "2.2", blocks: onlineNotice(1, 2).blocks },
        { ts: "3.3" },
      ],
    });
    await createOfflineAlarm({ channel: "C1", slack: s.slack, clock: () => beat + 7 * 60_000 }).tick();
    expect(s.updates.map((u) => u.ts)).toEqual(["1.1"]);
    expect(s.updates[0]?.msg.text).toContain("about 7 min");
  });
});
