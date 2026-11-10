import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SecurityResult, SecurityRunner } from "../../src/domain/tokenKey.ts";
import { loadKeychainKey, resolveTokenKey } from "../../src/infrastructure/db/tokenKeyStore.ts";

type Fake = {
  run: SecurityRunner;
  calls: string[][];
  stdins: (string | undefined)[];
  item: () => string | undefined;
};

/** An in-memory Keychain. `readFail` / `writeFail` make that verb fail with a given result. */
const fakeKeychain = (
  initial?: string,
  opts: { readFail?: SecurityResult; writeFail?: SecurityResult; corruptWrite?: boolean } = {},
): Fake => {
  let item = initial;
  const calls: string[][] = [];
  const stdins: (string | undefined)[] = [];
  const run: SecurityRunner = (args, stdin) => {
    calls.push(args);
    stdins.push(stdin);
    if (args[0] === "delete-generic-password") {
      item = undefined;
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "find-generic-password") {
      if (opts.readFail) return opts.readFail;
      return item === undefined
        ? { status: 44, stdout: "", stderr: "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain." }
        : { status: 0, stdout: `${item}\n`, stderr: "" };
    }
    if (opts.writeFail) return opts.writeFail;
    const secret = /"-w" "([^"]*)"/.exec(stdin ?? "")?.[1] ?? "";
    item = opts.corruptWrite ? randomBytes(32).toString("base64") : secret;
    return { status: 0, stdout: "", stderr: "" };
  };
  return { run, calls, stdins, item: () => item };
};

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "ev-keystore-"));
  return { keyPath: join(dir, "tokens.key") };
};
const base = { service: "svc", account: "me" };

describe("keychain key source", () => {
  test("an existing item is used as is, and the file is not consulted", () => {
    const key = randomBytes(32);
    const kc = fakeKeychain(key.toString("base64"));
    const out = loadKeychainKey({ ...base, ...setup(), security: kc.run, hasSealedRows: () => true });
    expect(out.kind === "key" && out.key.equals(key)).toBe(true);
    expect(kc.calls).toHaveLength(1);
    expect(kc.calls[0]).toEqual(["find-generic-password", "-s", "svc", "-a", "me", "-w"]);
  });

  test("a malformed item aborts the boot", () => {
    const kc = fakeKeychain("bm90IGEga2V5");
    expect(() => loadKeychainKey({ ...base, ...setup(), security: kc.run, hasSealedRows: () => false })).toThrow(
      /not a 32-byte/,
    );
  });

  test("item missing, file present: copied in, read back equal, file deleted", () => {
    const { keyPath } = setup();
    const key = randomBytes(32);
    writeFileSync(keyPath, key.toString("base64"));
    const kc = fakeKeychain();
    const out = loadKeychainKey({ ...base, keyPath, security: kc.run, hasSealedRows: () => true });
    expect(out.kind === "key" && out.key.equals(key)).toBe(true);
    expect(kc.item()).toBe(key.toString("base64"));
    expect(existsSync(keyPath)).toBe(false);
    expect(kc.stdins.some((s) => s?.includes("add-generic-password") && s.includes('"-U"'))).toBe(true);
    // the key travels on stdin only, never in an argument list
    expect(kc.calls.flat().some((a) => a.includes(key.toString("base64")))).toBe(false);
  });

  test("read-back mismatch aborts, removes the bad item and keeps the file", () => {
    const { keyPath } = setup();
    const key = randomBytes(32);
    writeFileSync(keyPath, key.toString("base64"));
    const kc = fakeKeychain(undefined, { corruptWrite: true });
    expect(() => loadKeychainKey({ ...base, keyPath, security: kc.run, hasSealedRows: () => true })).toThrow(
      /did not read back identical/,
    );
    expect(readFileSync(keyPath, "utf8")).toBe(key.toString("base64"));
    expect(kc.item()).toBeUndefined();
  });

  test("an item and a leftover file holding the same key: the migration is finished", () => {
    const { keyPath } = setup();
    const key = randomBytes(32);
    writeFileSync(keyPath, key.toString("base64"));
    const kc = fakeKeychain(key.toString("base64"));
    const out = loadKeychainKey({ ...base, keyPath, security: kc.run, hasSealedRows: () => true });
    expect(out.kind === "key" && out.key.equals(key)).toBe(true);
    expect(existsSync(keyPath)).toBe(false);
  });

  test("an item and a file holding different keys abort the boot and touch neither", () => {
    const { keyPath } = setup();
    const fileKey = randomBytes(32).toString("base64");
    writeFileSync(keyPath, fileKey);
    const item = randomBytes(32).toString("base64");
    const kc = fakeKeychain(item);
    expect(() => loadKeychainKey({ ...base, keyPath, security: kc.run, hasSealedRows: () => true })).toThrow(
      /different keys/,
    );
    expect(readFileSync(keyPath, "utf8")).toBe(fileKey);
    expect(kc.item()).toBe(item);
  });

  test("a write that exits 0 but lands nothing is unavailable, not a mint", () => {
    const kc = fakeKeychain();
    const silent: SecurityRunner = (args, stdin) => (args[0] === "-i" ? { status: 0, stdout: "", stderr: "" } : kc.run(args, stdin));
    expect(loadKeychainKey({ ...base, ...setup(), security: silent, hasSealedRows: () => false }).kind).toBe(
      "unavailable",
    );
  });

  test("item missing, no file, empty database: a fresh key is minted into the Keychain", () => {
    const kc = fakeKeychain();
    const out = loadKeychainKey({ ...base, ...setup(), security: kc.run, hasSealedRows: () => false });
    expect(out.kind).toBe("key");
    if (out.kind === "key") {
      expect(out.key).toHaveLength(32);
      expect(kc.item()).toBe(out.key.toString("base64"));
    }
  });

  test("item missing, no file, rows exist: fails loudly and writes nothing", () => {
    const kc = fakeKeychain();
    expect(() => loadKeychainKey({ ...base, ...setup(), security: kc.run, hasSealedRows: () => true })).toThrow(
      /refusing to mint/,
    );
    expect(kc.item()).toBeUndefined();
    expect(kc.calls.every((c) => c[0] === "find-generic-password")).toBe(true);
  });

  test("a locked Keychain is unavailable (not a throw), names the cause, and creates nothing", () => {
    const { keyPath } = setup();
    writeFileSync(keyPath, randomBytes(32).toString("base64"));
    const kc = fakeKeychain(undefined, {
      readFail: { status: 36, stdout: "", stderr: "security: User interaction is not allowed." },
    });
    const out = loadKeychainKey({ ...base, keyPath, security: kc.run, hasSealedRows: () => true });
    expect(out.kind).toBe("unavailable");
    if (out.kind === "unavailable") expect(out.cause).toMatch(/locked or no login session/);
    expect(kc.calls).toHaveLength(1);
    expect(existsSync(keyPath)).toBe(true);
  });

  test("a failed write is unavailable, keeps the file, and never echoes the secret", () => {
    const { keyPath } = setup();
    const key = randomBytes(32);
    const b64 = key.toString("base64");
    writeFileSync(keyPath, b64);
    const kc = fakeKeychain(undefined, { writeFail: { status: 1, stdout: "", stderr: `denied ${b64}` } });
    const out = loadKeychainKey({ ...base, keyPath, security: kc.run, hasSealedRows: () => true });
    expect(out.kind).toBe("unavailable");
    if (out.kind === "unavailable") expect(out.cause).not.toContain(b64);
    expect(existsSync(keyPath)).toBe(true);
  });

  test("no `security` binary (exit 127) reads as unavailable", () => {
    const kc = fakeKeychain(undefined, { readFail: { status: 127, stdout: "", stderr: "spawn security ENOENT" } });
    expect(loadKeychainKey({ ...base, ...setup(), security: kc.run, hasSealedRows: () => false }).kind).toBe(
      "unavailable",
    );
  });
});

describe("resolveTokenKey", () => {
  test("file mode never calls security and creates the key file", () => {
    const { keyPath } = setup();
    const kc = fakeKeychain();
    const out = resolveTokenKey({ ...base, keyPath, source: "file", security: kc.run, hasSealedRows: () => true });
    expect(out.kind).toBe("key");
    expect(kc.calls).toHaveLength(0);
    expect(existsSync(keyPath)).toBe(true);
  });

  test("keychain mode goes through the Keychain", () => {
    const kc = fakeKeychain();
    const { keyPath } = setup();
    resolveTokenKey({ ...base, keyPath, source: "keychain", security: kc.run, hasSealedRows: () => false });
    expect(kc.item()).toBeDefined();
    expect(existsSync(keyPath)).toBe(false);
  });
});
