import { describe, expect, test } from "bun:test";
import {
  buildCommandMenu,
  clip,
  decodeMenuRequest,
  encodeMenuRequest,
  type MenuCommand,
  MENU_OPTION_MAX,
  menuIntro,
  needsArguments,
  QUICK_MAX,
} from "../../src/domain/commandMenu.ts";

const cmd = (name: string, minRole: MenuCommand["minRole"], usage = "", summary = "does a thing"): MenuCommand => ({
  name,
  minRole,
  usage,
  summary,
});

const registry: MenuCommand[] = [
  cmd("help", "pal"),
  cmd("ping", "pal"),
  cmd("whoami", "pal"),
  cmd("review", "executer", "<url> [--policy first|after]"),
  cmd("learn", "admin", "<fact>"),
  cmd("sys", "admin"),
  { ...cmd("forget", "pal", "", "wipes this channel"), destructive: true },
  cmd("adapter", "admin", "[status|check|history|refine [note]|revert <id>|migrate]"),
  cmd("shutdown", "owner"),
];

describe("needsArguments", () => {
  test("no usage means nothing to ask for", () => {
    expect(needsArguments("")).toBe(false);
  });

  test("a required argument needs asking", () => {
    expect(needsArguments("<fact>")).toBe(true);
    expect(needsArguments("<url> [--policy x]")).toBe(true);
  });

  test("an all-optional usage runs on its own", () => {
    expect(needsArguments("[role|here|#channel] [name|default]")).toBe(false);
  });

  test("nested optional groups do not make a command demand arguments", () => {
    // one pass over `[a|b [c]|revert <id>]` leaves `|revert <id>]` behind, and
    // `adapter` - which runs fine bare - would pop an empty box
    expect(needsArguments("[status|check|history|refine [note]|revert <id>|migrate]")).toBe(false);
  });
});

describe("buildCommandMenu", () => {
  test("it only offers what the role may run", () => {
    const names = buildCommandMenu(registry, "pal").groups.flatMap((g) => g.options.map((o) => o.value));
    expect(names).toContain("ping");
    expect(names).not.toContain("learn");
    expect(names).not.toContain("shutdown");
  });

  test("an owner sees everything", () => {
    const names = buildCommandMenu(registry, "owner").groups.flatMap((g) => g.options.map((o) => o.value));
    expect(names).toContain("shutdown");
    expect(names).toContain("ping");
  });

  test("help is not in its own menu", () => {
    const names = buildCommandMenu(registry, "owner").groups.flatMap((g) => g.options.map((o) => o.value));
    expect(names).not.toContain("help");
  });

  test("options are grouped by the role that unlocks them", () => {
    const menu = buildCommandMenu(registry, "owner");
    expect(menu.groups.map((g) => g.label)).toEqual(["Anyone", "Executers", "Admins", "Owner"]);
  });

  test("the label carries the argument shape, the description the summary", () => {
    const menu = buildCommandMenu(registry, "admin");
    const learn = menu.groups.flatMap((g) => g.options).find((o) => o.value === "learn");
    expect(learn?.label).toBe("learn <fact>");
    expect(learn?.description).toBe("does a thing");
  });

  test("quick buttons are the ones that need no typing at all", () => {
    const menu = buildCommandMenu(registry, "admin");
    const names = menu.quick.map((c) => c.name);
    expect(names).toContain("ping");
    expect(names).toContain("sys");
    expect(names).not.toContain("learn");
    expect(menu.quick.length).toBeLessThanOrEqual(QUICK_MAX);
  });

  test("a destructive command is never a one-tap button", () => {
    // a button is one stray tap away from wiping a channel's memory
    const menu = buildCommandMenu(registry, "admin");
    expect(menu.quick.map((c) => c.name)).not.toContain("forget");
    // it is still in the picker, where it gets confirmed
    expect(menu.groups.flatMap((g) => g.options).map((o) => o.value)).toContain("forget");
  });

  test("a registry past Slack's ceiling says how many it left out", () => {
    const many = Array.from({ length: MENU_OPTION_MAX + 7 }, (_, i) => cmd(`c${i}`, "pal"));
    const menu = buildCommandMenu(many, "pal", []);
    expect(menu.groups.flatMap((g) => g.options).length).toBe(MENU_OPTION_MAX);
    expect(menu.omitted).toBe(7);
    expect(menuIntro("X/jv", "/jv", menu)).toContain("7 more");
  });
});

describe("clip", () => {
  test("it keeps Slack's limits without Slack's truncation", () => {
    expect(clip("x".repeat(100)).length).toBe(75);
    expect(clip("short")).toBe("short");
  });
});

describe("the menu request", () => {
  test("it round-trips where the answer goes", () => {
    const req = { channelId: "C1", threadTs: "123.45", command: "learn" };
    expect(decodeMenuRequest(encodeMenuRequest(req))).toEqual(req);
  });

  test("rubbish decodes to nothing rather than throwing", () => {
    expect(decodeMenuRequest("not json")).toBeUndefined();
    expect(decodeMenuRequest(undefined)).toBeUndefined();
    expect(decodeMenuRequest('{"threadTs":"1"}')).toBeUndefined();
  });
});
