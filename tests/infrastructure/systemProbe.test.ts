import { describe, expect, test } from "bun:test";
import { parseLinuxBattery, parsePmsetBattery } from "../../src/infrastructure/system/systemProbe.ts";

const pmset = (line: string) => `Now drawing from 'Battery Power'\n -InternalBattery-0 (id=21495907)\t${line}\n`;

describe("parsePmsetBattery", () => {
  test("discharging, with the time left", () => {
    expect(parsePmsetBattery(pmset("73%; discharging; 6:29 remaining present: true"))).toEqual({
      pct: 73,
      state: "discharging",
      remainingS: 6 * 3600 + 29 * 60,
    });
  });

  test("charging and finishing charge are both charging", () => {
    expect(parsePmsetBattery(pmset("41%; charging; 1:05 remaining present: true"))?.state).toBe("charging");
    expect(parsePmsetBattery(pmset("97%; finishing charge; 0:10 remaining present: true"))?.state).toBe("charging");
  });

  test("charged, held on AC, and no estimate yet", () => {
    expect(parsePmsetBattery(pmset("100%; charged; 0:00 remaining present: true"))).toEqual({ pct: 100, state: "charged" });
    expect(parsePmsetBattery(pmset("80%; AC attached; not charging present: true"))).toEqual({
      pct: 80,
      state: "not charging",
    });
    expect(parsePmsetBattery(pmset("60%; discharging; (no estimate) present: true"))).toEqual({
      pct: 60,
      state: "discharging",
    });
  });

  test("a desktop Mac has no battery line, so no reading", () => {
    expect(parsePmsetBattery("Now drawing from 'AC Power'\n")).toBeUndefined();
  });
});

describe("parseLinuxBattery", () => {
  test("sysfs capacity and status", () => {
    expect(parseLinuxBattery("55\n", "Discharging\n")).toEqual({ pct: 55, state: "discharging" });
    expect(parseLinuxBattery("100\n", "Full\n")).toEqual({ pct: 100, state: "charged" });
    expect(parseLinuxBattery("", "Charging")).toBeUndefined();
  });
});
