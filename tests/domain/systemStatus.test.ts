import { describe, expect, test } from "bun:test";
import {
  batteryLine,
  describeSystem,
  duration,
  human,
  type SystemReading,
  trendOf,
  verdictOf,
} from "../../src/domain/systemStatus.ts";

const GB = 1024 ** 3;
const healthy = (over: Partial<SystemReading> = {}): SystemReading => ({
  at: 1_700_000_000_000,
  cores: 10,
  load1: 2,
  load5: 2,
  load15: 2,
  memTotal: 32 * GB,
  memAvailable: 24 * GB,
  memSource: "pressure",
  swapUsed: 400 * 1024 ** 2,
  diskFree: 300 * GB,
  diskTotal: 480 * GB,
  hostUptimeS: 90_000,
  procRss: 180 * 1024 ** 2,
  procUptimeS: 3_600,
  socket: "connected",
  activeRuns: 0,
  ...over,
});

describe("human", () => {
  test("it picks a unit a person can read", () => {
    expect(human(512)).toBe("512B");
    expect(human(1536)).toBe("1.5KB");
    expect(human(32 * GB)).toBe("32GB");
  });
});

describe("duration", () => {
  test("it degrades to the unit that matters", () => {
    expect(duration(45)).toBe("45s");
    expect(duration(3_600)).toBe("1h 0m");
    expect(duration(90_000)).toBe("1d 1h");
  });
});

describe("battery", () => {
  test("low only matters while discharging", () => {
    expect(verdictOf(healthy({ battery: { pct: 15, state: "discharging" } })).level).toBe("watch");
    expect(verdictOf(healthy({ battery: { pct: 5, state: "discharging" } })).level).toBe("problem");
    expect(verdictOf(healthy({ battery: { pct: 5, state: "charging" } })).level).toBe("ok");
    expect(verdictOf(healthy({ battery: { pct: 50, state: "discharging" } })).level).toBe("ok");
  });

  test("the line says the time left only when it means something", () => {
    expect(batteryLine({ pct: 73, state: "discharging", remainingS: 23_340 })).toBe("73%, discharging, 6h 29m left");
    expect(batteryLine({ pct: 41, state: "charging", remainingS: 3_900 })).toBe("41%, charging, 1h 5m to full");
    expect(batteryLine({ pct: 100, state: "charged" })).toBe("100%, charged");
    expect(describeSystem(healthy())).not.toContain("battery");
  });
});

describe("verdictOf", () => {
  test("a healthy machine is ok, with nothing to say about it", () => {
    const v = verdictOf(healthy());
    expect(v.level).toBe("ok");
    expect(v.reasons).toEqual([]);
  });

  test("load is judged per core, not raw", () => {
    // 12 on 10 cores is busy; 12 on 2 cores is a problem. The raw number alone
    // cannot tell those apart, which is why it is never used on its own.
    expect(verdictOf(healthy({ load1: 12, cores: 10 })).level).toBe("watch");
    expect(verdictOf(healthy({ load1: 12, cores: 2 })).level).toBe("problem");
  });

  test("memory is judged on what is available", () => {
    expect(verdictOf(healthy({ memAvailable: 5 * GB })).level).toBe("watch");
    expect(verdictOf(healthy({ memAvailable: 2 * GB })).level).toBe("problem");
  });

  test("a little swap is normal, a lot is not", () => {
    expect(verdictOf(healthy({ swapUsed: 400 * 1024 ** 2 })).level).toBe("ok");
    expect(verdictOf(healthy({ swapUsed: 3 * GB })).level).toBe("watch");
    expect(verdictOf(healthy({ swapUsed: 10 * GB })).level).toBe("problem");
  });

  test("a disk about to fill is a problem", () => {
    expect(verdictOf(healthy({ diskFree: 10 * GB })).level).toBe("problem");
  });

  test("a socket that is not listening is a problem, however healthy the box", () => {
    // this is the failure that looks like silence: process up, nothing arriving
    const v = verdictOf(healthy({ socket: "reconnecting" }));
    expect(v.level).toBe("problem");
    expect(v.reasons.join()).toContain("socket is reconnecting");
  });

  test("the worst finding wins, and every reason is reported", () => {
    const v = verdictOf(healthy({ load1: 30, memAvailable: 1 * GB }));
    expect(v.level).toBe("problem");
    expect(v.reasons.length).toBe(2);
  });
});

describe("describeSystem", () => {
  test("the verdict leads, because that is the actual question", () => {
    expect(describeSystem(healthy()).split("\n")[0]).toContain("nothing abnormal");
    expect(describeSystem(healthy({ memAvailable: 1 * GB })).split("\n")[0]).toContain("something is wrong");
  });

  test("it flags a memory figure that came from the unreliable source", () => {
    // os.freemem() reads ~2GB of 32 on a healthy Mac; saying so beats presenting
    // it as the real number
    const out = describeSystem(healthy({ memSource: "free" }));
    expect(out).toContain("free-page count");
    expect(describeSystem(healthy())).not.toContain("free-page count");
  });

  test("it reports the numbers under the verdict", () => {
    const out = describeSystem(healthy(), { botName: "Bot" });
    expect(out).toContain("*cpu*");
    expect(out).toContain("*memory*");
    expect(out).toContain("*Bot*");
  });
});

describe("trendOf", () => {
  const at = (n: number, load: number, mem = 24 * GB) =>
    healthy({ at: 1_700_000_000_000 + n * 60_000, load1: load, memAvailable: mem });

  test("one sample is not a trend", () => {
    expect(trendOf([at(0, 2)])).toBeUndefined();
  });

  test("it reports the peak and the floor across the window", () => {
    const t = trendOf([at(0, 2), at(1, 25), at(2, 3)]);
    expect(t?.peakLoadPerCore).toBeCloseTo(2.5, 2);
    expect(t?.spanS).toBe(120);
  });

  test("climbing load is called out", () => {
    expect(trendOf([at(0, 2), at(1, 6), at(2, 12)])?.rising).toBe(true);
  });

  test("noise between two idle samples is not climbing", () => {
    // 0.1 to 0.2 per core is a doubling and means nothing
    expect(trendOf([at(0, 1), at(1, 2)])?.rising).toBe(false);
  });
});
