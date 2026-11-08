import { describe, expect, test } from "bun:test";
import { createOfflineAlarm, type ChannelMessage, type OfflineAlarmSlack } from "../../src/application/offlineAlarm.ts";
import { offlineNotice, onlineNotice, type AlarmMessage } from "../../src/domain/offlineAlarm.ts";

type Armed = { id: string; postAt: number; text: string };

const fakeSlack = (
  opts: { offline?: () => boolean; recent?: ChannelMessage[]; blindList?: boolean; failUnschedule?: boolean } = {},
) => {
  const armed: Armed[] = [];
  const updates: { ts: string; msg: AlarmMessage }[] = [];
  const calls: string[] = [];
  let next = 0;
  // Async like the real client: a throw inside is a rejection, never a sync throw.
  const net = async <T>(name: string, fn: () => T): Promise<T> => {
    calls.push(name);
    if (opts.offline?.()) throw new Error("ENOTFOUND slack.com");
    return fn();
  };
  const slack: OfflineAlarmSlack = {
    schedule: (_c, postAt, msg) =>
      net("schedule", () => {
        const id = `Q${++next}`;
        armed.push({ id, postAt, text: msg.text });
        return id;
      }),
    scheduled: () =>
      net("scheduled", () => (opts.blindList ? [] : [...armed, { id: "OTHER", postAt: 0, text: "a real reminder" }])),
    unschedule: (_c, id) =>
      net("unschedule", () => {
        if (opts.failUnschedule) throw new Error("message_not_found");
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

  test("a list that cannot see the fresh notice deletes it instead of piling notices up", async () => {
    const lines: string[] = [];
    const s = fakeSlack({ blindList: true });
    const alarm = createOfflineAlarm({ channel: "C1", slack: s.slack, clock: () => 1, log: (l) => lines.push(l) });
    for (let i = 0; i < 5; i++) await alarm.tick();
    expect(s.calls.filter((c) => c === "schedule")).toHaveLength(5);
    expect(s.armed).toHaveLength(0);
    expect(lines[0]).toContain("not in the scheduled list");
  });

  test("a notice Slack is posting right now cannot be cancelled: the same tick still closes what was posted", async () => {
    const beat = 1_000;
    const lines: string[] = [];
    const s = fakeSlack({ failUnschedule: true, recent: [{ ts: "1.1", blocks: offlineNotice(beat).blocks }] });
    s.armed.push({ id: "OLD", postAt: 1, text: offlineNotice(beat).text });
    const alarm = createOfflineAlarm({ channel: "C1", slack: s.slack, clock: () => beat + 60_000, log: (l) => lines.push(l) });
    await alarm.tick();
    expect(lines.some((l) => l.includes("could not cancel OLD"))).toBe(true);
    expect(s.updates.map((u) => u.ts)).toEqual(["1.1"]);
  });

  test("a tick still in flight is not overlapped", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const s = fakeSlack();
    const slow: OfflineAlarmSlack = { ...s.slack, schedule: async (...a) => (await gate, s.slack.schedule(...a)) };
    const alarm = createOfflineAlarm({ channel: "C1", slack: slow, clock: () => 1 });
    const first = alarm.tick();
    await alarm.tick();
    release();
    await first;
    expect(s.calls.filter((c) => c === "schedule")).toHaveLength(1);
  });

  test("disarm cancels every armed notice and nothing else, and ticks stop", async () => {
    const s = fakeSlack();
    const alarm = createOfflineAlarm({ channel: "C1", slack: s.slack, clock: () => 1 });
    await alarm.tick();
    await alarm.disarm();
    await alarm.tick();
    expect(s.armed).toHaveLength(0);
    expect(s.calls.filter((c) => c === "schedule")).toHaveLength(1);
  });

  test("disarm during a tick waits for it, so the notice it was arming does not outlive the stop", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const s = fakeSlack();
    s.armed.push({ id: "OLD", postAt: 1, text: offlineNotice(1).text });
    const slow: OfflineAlarmSlack = { ...s.slack, schedule: async (...a) => (await gate, s.slack.schedule(...a)) };
    const alarm = createOfflineAlarm({ channel: "C1", slack: slow, clock: () => 1 });
    const ticking = alarm.tick();
    const disarming = alarm.disarm();
    release();
    await Promise.all([ticking, disarming]);
    expect(s.armed).toHaveLength(0);
  });

  test("disarm keeps cancelling past one that fails", async () => {
    const lines: string[] = [];
    const s = fakeSlack();
    s.armed.push({ id: "A", postAt: 1, text: offlineNotice(1).text }, { id: "B", postAt: 1, text: offlineNotice(2).text });
    let first = true;
    const flaky: OfflineAlarmSlack = {
      ...s.slack,
      unschedule: async (c, id) => {
        if (first) {
          first = false;
          throw new Error("message_not_found");
        }
        return s.slack.unschedule(c, id);
      },
    };
    await createOfflineAlarm({ channel: "C1", slack: flaky, clock: () => 1, log: (l) => lines.push(l) }).disarm();
    expect(s.armed.map((a) => a.id)).toEqual(["A"]);
    expect(lines[0]).toContain("could not cancel A");
  });

  test("disarm offline only logs", async () => {
    const lines: string[] = [];
    const s = fakeSlack({ offline: () => true });
    await createOfflineAlarm({ channel: "C1", slack: s.slack, clock: () => 1, log: (l) => lines.push(l) }).disarm();
    expect(lines[0]).toContain("could not disarm");
  });

  test("a stalled network cannot hold disarm past its bound", async () => {
    const lines: string[] = [];
    const s = fakeSlack();
    const stalled: OfflineAlarmSlack = { ...s.slack, scheduled: () => new Promise(() => {}) };
    const alarm = createOfflineAlarm({ channel: "C1", slack: stalled, clock: () => 1, disarmWaitMs: 20, log: (l) => lines.push(l) });
    await alarm.disarm();
    expect(lines[0]).toContain("timed out");
  });
});
