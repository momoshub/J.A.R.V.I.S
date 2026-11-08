import { describe, expect, test } from "bun:test";
import { conversationLabel, labelMentions, mentionedIds, userLabel } from "../../src/domain/slackNames.ts";

describe("slack names", () => {
  test("a person is always name and id, never a bare id", () => {
    expect(userLabel("U1", "Kai")).toBe("Kai (U1)");
    expect(userLabel("U1", "U1")).toBe("unknown (U1)");
    expect(userLabel("U1", " ")).toBe("unknown (U1)");
    expect(userLabel("U1")).toBe("unknown (U1)");
    expect(userLabel("")).toBe("unknown");
  });

  test("a channel is #name (id), a DM is the person, a group DM says so", () => {
    expect(conversationLabel("C0TEAM00001", { kind: "channel", name: "team-chat" })).toBe("#team-chat (C0TEAM00001)");
    expect(conversationLabel("G1", { kind: "group", name: "#secret" })).toBe("#secret (G1)");
    expect(conversationLabel("D1", { kind: "im", userId: "U1" }, "Kai")).toBe("@Kai (D1)");
    expect(conversationLabel("D1", { kind: "im", userId: "U1" }, "U1")).toBe("DM (D1)");
    expect(conversationLabel("G2", { kind: "mpim", name: "mpdm-a--b-1" })).toBe("group DM (G2)");
    expect(conversationLabel("C9")).toBe("unknown (C9)");
    expect(conversationLabel("C9", { kind: "channel" })).toBe("unknown (C9)");
  });

  test("mentions in a message become name and id", () => {
    const text = "ping <@U1> and <@W2|bob>, again <@U1>";
    expect(mentionedIds(text)).toEqual(["U1", "W2"]);
    expect(labelMentions(text, { U1: "Kai (U1)" })).toBe("ping @Kai (U1) and @unknown (W2), again @Kai (U1)");
    expect(labelMentions("no mentions", {})).toBe("no mentions");
  });
});
