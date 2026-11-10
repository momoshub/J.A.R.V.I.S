import { describe, expect, test } from "bun:test";
import { fold, isPerson, matchScore, searchMembers, type SlackMember } from "../../src/domain/slackMembers.ts";

const m = (over: Partial<SlackMember> & { id: string }): SlackMember => ({
  handle: "", realName: "", displayName: "", title: "", email: "", avatar: "", deleted: false, isBot: false, ...over,
});

describe("slack members", () => {
  test("only live humans are people", () => {
    expect(isPerson(m({ id: "U1" }))).toBe(true);
    expect(isPerson(m({ id: "U2", deleted: true }))).toBe(false);
    expect(isPerson(m({ id: "U3", isBot: true }))).toBe(false);
    expect(isPerson(m({ id: "USLACKBOT" }))).toBe(false);
  });

  test("folding drops case and diacritics", () => {
    expect(fold(" Lê Thị Hương ")).toBe("le thi huong");
    expect(fold("Đức")).toBe("duc");
  });

  test("an exact field beats a word start beats a substring", () => {
    const minh = m({ id: "U1", realName: "Minh Trần", handle: "minh", email: "minh@acme.com" });
    expect(matchScore(minh, "minh")).toBe(3);
    expect(matchScore(minh, "@tr")).toBe(2);
    expect(matchScore(minh, "acme")).toBe(2);
    expect(matchScore(minh, "inh")).toBe(1);
    expect(matchScore(minh, "zzz")).toBe(0);
    expect(matchScore(minh, "  ")).toBe(0);
    expect(matchScore(minh, "u1")).toBe(3);
  });

  test("search ranks, skips non-people, and caps", () => {
    const list = [
      m({ id: "U1", realName: "Anna Kim", handle: "anna" }),
      m({ id: "U2", realName: "Hanna Lee", handle: "hanna" }),
      m({ id: "U3", realName: "Anna Bot", handle: "annabot", isBot: true }),
      m({ id: "U4", realName: "Annabel", handle: "annabel", deleted: true }),
      m({ id: "U5", realName: "Ann", handle: "ann" }),
    ];
    expect(searchMembers(list, "ann", 10).map((x) => x.id)).toEqual(["U5", "U1", "U2"]);
    expect(searchMembers(list, "ann", 1).map((x) => x.id)).toEqual(["U5"]);
    expect(searchMembers(list, "", 10)).toEqual([]);
  });
});
