import { describe, expect, test } from "bun:test";
import { createSettingsRepo } from "../../src/infrastructure/db/settingsRepo.ts";
import { createThreadSessionRepo } from "../../src/infrastructure/db/threadSessionRepo.ts";
import { createRunRegistry } from "../../src/application/runRegistry.ts";
import { dispatchCommand, type CommandDeps } from "../../src/application/commands.ts";
import type { TotpPort } from "../../src/application/totp.ts";
import { parseTotpInput, totpCode } from "../../src/domain/totp.ts";
import { OWNER, db, actor, build } from "./commandsFixture.ts";

describe("stop command", () => {
  const tracked = (runs: ReturnType<typeof createRunRegistry>, over: Record<string, unknown> = {}) =>
    runs.track({
      id: "r1",
      key: "C1:900.1",
      channelId: "C1",
      threadTs: "900.1",
      actor: OWNER,
      what: "the long one",
      startedAt: 0,
      ...over,
    });

  test("stops the turn running in this thread", async () => {
    const deps = build();
    const runs = createRunRegistry();
    deps.runs = runs;
    const t = tracked(runs);
    t.running();

    const out = await dispatchCommand(deps, actor(), "C1", "stop", { threadTs: "900.1" });
    expect(out).toContain("stopped");
    expect(out).toContain("the long one");
    expect(t.signal.aborted).toBe(true);
  });

  test("says plainly when there is nothing to stop", async () => {
    // "nothing is running" and "I could not stop it" read very differently when
    // you are watching something misbehave
    const deps = build();
    deps.runs = createRunRegistry();
    expect(await dispatchCommand(deps, actor(), "C1", "stop", { threadTs: "900.1" })).toContain(
      "Nothing is running",
    );
  });

  test("someone else's turn takes an admin", async () => {
    const deps = build();
    const runs = createRunRegistry();
    deps.runs = runs;
    const t = tracked(runs, { actor: "U-other" });
    t.running();

    const pal = actor({ slackId: "U0PAL0007", role: "pal" });
    deps.users.upsert(pal);
    const refused = await dispatchCommand(deps, pal, "C1", "stop", { threadTs: "900.1" });
    expect(refused).toContain("Only they or an admin");
    expect(t.signal.aborted).toBe(false);

    await dispatchCommand(deps, actor(), "C1", "stop", { threadTs: "900.1" });
    expect(t.signal.aborted).toBe(true);
  });

  test("outside a thread there is nothing it could mean", async () => {
    const deps = build();
    deps.runs = createRunRegistry();
    expect(await dispatchCommand(deps, actor(), "C1", "stop")).toContain("inside a thread");
  });
});

describe("session command", () => {
  test("reports, resets, and is only switchable by admins", async () => {
    const deps = build();
    deps.settings = createSettingsRepo(db);
    deps.threadSessions = createThreadSessionRepo(db);
    deps.threadSessionsOn = () => deps.settings!.get("thread_sessions") !== "off";
    const pal = actor({ slackId: "U0PAL0004", role: "pal" });
    deps.users.upsert(pal);

    const inThread = { threadTs: "900.1" };
    expect(await dispatchCommand(deps, actor(), "C1", "session", inThread)).toContain("No session bound");

    deps.threadSessions.claim("C1", "900.1", "sandbox", "sess-1", "900.1", 1, "hash");
    expect(await dispatchCommand(deps, pal, "C1", "session", inThread)).toContain("1 turn in");

    expect(await dispatchCommand(deps, pal, "C1", "session reset", inThread)).toContain("Dropped it");
    expect(deps.threadSessions.find("C1", "900.1", "sandbox")).toBeUndefined();

    expect(await dispatchCommand(deps, pal, "C1", "session off", inThread)).toContain("Only admins");
    expect(await dispatchCommand(deps, actor(), "C1", "session off", inThread)).toContain("off");
    expect(deps.settings.get("thread_sessions")).toBe("off");
    expect(await dispatchCommand(deps, actor(), "C1", "session", inThread)).toContain("off");

    await dispatchCommand(deps, actor(), "C1", "session on", inThread);
    expect(deps.settings.get("thread_sessions")).toBe("");
  });

  test("outside a thread there is nothing to report", async () => {
    const deps = build();
    deps.settings = createSettingsRepo(db);
    deps.threadSessions = createThreadSessionRepo(db);
    expect(await dispatchCommand(deps, actor(), "C1", "session")).toContain("inside a thread");
  });
});

/** RFC 4648 base32, enough to spell a test vector out of its plain bytes. */
const base32 = (text: string): string => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...new TextEncoder().encode(text)].map((b) => b.toString(2).padStart(8, "0")).join("");
  return (bits.match(/.{1,5}/g) ?? []).map((c) => alphabet[parseInt(c.padEnd(5, "0"), 2)]).join("");
};

describe("2fa", () => {
  /**
   * RFC 6238's seed, so an expected code can be written down rather than guessed.
   * Built from the ASCII digits it encodes so a secret scanner does not read a
   * public test vector as a leaked key.
   */
  const RFC_VECTOR = base32("12345678901234567890");
  const SEED = `otpauth://totp/acme:demo%40acme.io?secret=${RFC_VECTOR}&issuer=acme`;

  const fakeTotp = (): TotpPort => {
    const rows = new Map<string, { uri: string; account?: string; addedBy: string; updatedAt: number }>();
    return {
      get: (label) => {
        const row = rows.get(label);
        return row ? parseTotpInput(row.uri) : undefined;
      },
      has: (label) => rows.has(label),
      set: (label, uri, addedBy, account) => {
        rows.set(label, { uri, account, addedBy, updatedAt: 0 });
      },
      remove: (label) => rows.delete(label),
      list: () =>
        [...rows.entries()].map(([label, r]) => ({
          label,
          account: r.account,
          addedBy: r.addedBy,
          updatedAt: r.updatedAt,
        })),
    };
  };

  const withTotp = (at: number): CommandDeps & { totp: TotpPort } => {
    const deps = { ...build(), totp: fakeTotp(), clock: () => at };
    return deps as CommandDeps & { totp: TotpPort };
  };

  test("says so plainly when there is no store wired up", async () => {
    const deps = build();
    expect(await dispatchCommand(deps, actor(), "C1", "2fa demo")).toContain("not wired up");
  });

  test("a pal cannot reach it at all", async () => {
    const deps = withTotp(0);
    const out = await dispatchCommand(deps, actor({ slackId: "U3", role: "pal" }), "C1", "2fa demo");
    expect(out).not.toContain("not wired up");
    expect(out.toLowerCase()).toContain("executer");
  });

  test("an empty store points at add rather than at nothing", async () => {
    const deps = withTotp(0);
    expect(await dispatchCommand(deps, actor(), "C1", "2fa")).toContain("2fa add");
  });

  test("only an admin may add a key", async () => {
    const deps = withTotp(0);
    const out = await dispatchCommand(deps, actor({ slackId: "U3", role: "executer" }), "C1", "2fa add demo");
    expect(out).toContain("Only admins");
    expect(deps.totp.list()).toHaveLength(0);
  });

  test("add never takes the key as command text - it offers the box", async () => {
    const deps = withTotp(0);
    const out = await dispatchCommand(deps, actor(), "C1", `2fa add demo ${SEED}`);
    expect(out).toContain("setup key");
    expect(out).not.toContain("GEZDGNBV");
    expect(deps.totp.list()).toHaveLength(0);
  });

  test("a code, with the account and the time left", async () => {
    const deps = withTotp(45_000);
    deps.totp.set("demo", SEED, OWNER, "demo@acme.io");
    const out = await dispatchCommand(deps, actor(), "C1", "2fa demo");
    const expected = totpCode(parseTotpInput(SEED)!, 45_000);
    expect(out).toContain(expected);
    expect(out).toContain("demo@acme.io");
    expect(out).toContain("15s");
  });

  test("hands over the next code when this one is about to expire", async () => {
    const deps = withTotp(58_000);
    deps.totp.set("demo", SEED, OWNER);
    const out = await dispatchCommand(deps, actor(), "C1", "2fa demo");
    expect(out).toContain(totpCode(parseTotpInput(SEED)!, 60_000));
    expect(out).toContain("next one");
  });

  test("the label is matched however it was typed", async () => {
    const deps = withTotp(45_000);
    deps.totp.set("shared-demo", SEED, OWNER);
    expect(await dispatchCommand(deps, actor(), "C1", "2fa  Shared Demo ")).toContain(
      totpCode(parseTotpInput(SEED)!, 45_000),
    );
  });

  test("an unknown label says what is actually held", async () => {
    const deps = withTotp(0);
    deps.totp.set("demo", SEED, OWNER);
    const out = await dispatchCommand(deps, actor(), "C1", "2fa nope");
    expect(out).toContain("No setup key");
    expect(out).toContain("demo");
  });

  test("list shows who added each one, and never the secret", async () => {
    const deps = withTotp(0);
    deps.totp.set("demo", SEED, OWNER, "demo@acme.io");
    const out = await dispatchCommand(deps, actor(), "C1", "2fa list");
    expect(out).toContain("demo");
    expect(out).toContain(OWNER);
    expect(out).not.toContain("GEZDGNBV");
  });

  test("remove is admin-only, and says when there was nothing to forget", async () => {
    const deps = withTotp(0);
    deps.totp.set("demo", SEED, OWNER);
    expect(await dispatchCommand(deps, actor({ slackId: "U3", role: "executer" }), "C1", "2fa remove demo")).toContain(
      "Only admins",
    );
    expect(deps.totp.has("demo")).toBe(true);
    expect(await dispatchCommand(deps, actor(), "C1", "2fa remove demo")).toContain("Forgotten");
    expect(await dispatchCommand(deps, actor(), "C1", "2fa remove demo")).toContain("had no setup key");
  });

  test("otp and totp reach the same command", async () => {
    const deps = withTotp(45_000);
    deps.totp.set("demo", SEED, OWNER);
    const expected = totpCode(parseTotpInput(SEED)!, 45_000);
    expect(await dispatchCommand(deps, actor(), "C1", "otp demo")).toContain(expected);
    expect(await dispatchCommand(deps, actor(), "C1", "totp demo")).toContain(expected);
  });
});
