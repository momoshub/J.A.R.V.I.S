import { describe, expect, test } from "bun:test";
import { playerAction, stepIndex } from "../../web/src/ui/playerKeys.ts";

const ev = (key: string, over: Record<string, unknown> = {}) =>
  ({ key, metaKey: false, ctrlKey: false, altKey: false, target: { tagName: "BODY" }, ...over });

describe("player keys", () => {
  test("space toggles, arrows step", () => {
    expect(playerAction(ev(" "))).toBe("toggle");
    expect(playerAction(ev("ArrowLeft"))).toBe("prev");
    expect(playerAction(ev("ArrowRight"))).toBe("next");
    expect(playerAction(ev("a"))).toBeNull();
  });

  test("holding space does not flicker play and pause", () => {
    expect(playerAction(ev(" ", { repeat: true }))).toBeNull();
    expect(playerAction(ev("ArrowRight", { repeat: true }))).toBe("next");
  });

  test("leaves keys alone with a modifier or where focus wants them", () => {
    expect(playerAction(ev("ArrowLeft", { metaKey: true }))).toBeNull();
    expect(playerAction(ev(" ", { ctrlKey: true }))).toBeNull();
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"]) {
      expect(playerAction(ev(" ", { target: { tagName } }))).toBeNull();
    }
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) {
      expect(playerAction(ev("ArrowRight", { target: { tagName } }))).toBeNull();
    }
    expect(playerAction(ev(" ", { target: { tagName: "DIV", isContentEditable: true } }))).toBeNull();
    expect(playerAction(ev("ArrowLeft", { target: { tagName: "DIV", isContentEditable: true } }))).toBeNull();
    expect(playerAction(ev(" ", { target: { tagName: "g", getAttribute: () => "button" } }))).toBeNull();
  });

  test("arrows still step with a button, link or diagram box focused - none of them use arrows", () => {
    expect(playerAction(ev("ArrowRight", { target: { tagName: "BUTTON" } }))).toBe("next");
    expect(playerAction(ev("ArrowLeft", { target: { tagName: "A" } }))).toBe("prev");
    expect(playerAction(ev("ArrowRight", { target: { tagName: "g", getAttribute: () => "button" } }))).toBe("next");
  });
});

describe("stepIndex", () => {
  test("clamps to before-the-first and the last step", () => {
    expect(stepIndex(-1, "prev", 5)).toBe(-1);
    expect(stepIndex(0, "prev", 5)).toBe(-1);
    expect(stepIndex(-1, "next", 5)).toBe(0);
    expect(stepIndex(4, "next", 5)).toBe(4);
    expect(stepIndex(2, "next", 5)).toBe(3);
  });
});
