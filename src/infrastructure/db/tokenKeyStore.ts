/**
 * Where the token-database key is kept: a 0600 file (default) or one macOS
 * Keychain item, reached through the `security` CLI.
 *
 * Keychain mode never loses a key and never mints one over ciphertext it could
 * not open: a missing item is only replaced from the old key file, or - with no
 * file - freshly minted when the token database holds no rows at all.
 */
import { randomBytes } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import {
  KEY_BYTES,
  causeOf,
  classifyRead,
  parseKey,
  type SecurityRunner,
} from "../../domain/tokenKey.ts";
import { loadOrCreateKey } from "./secretBox.ts";

/** The real runner. A missing binary (Linux) reads as exit 127, not a throw. */
export const runSecurity: SecurityRunner = (args) => {
  try {
    const res = Bun.spawnSync(["security", ...args], { stdout: "pipe", stderr: "pipe" });
    return { status: res.exitCode, stdout: res.stdout.toString(), stderr: res.stderr.toString() };
  } catch (err) {
    return { status: 127, stdout: "", stderr: err instanceof Error ? err.message : "security not runnable" };
  }
};

export type TokenKeyOutcome =
  | { kind: "key"; key: Buffer; note?: string }
  /** The Keychain could not be reached; per-user tokens stay off, boot goes on. */
  | { kind: "unavailable"; cause: string };

export type KeychainKeyOptions = {
  security: SecurityRunner;
  service: string;
  account: string;
  /** The old key file: migrated into the Keychain, then removed. */
  keyPath: string;
  /** Whether the token database already holds any sealed row. */
  hasSealedRows: () => boolean;
};

/**
 * Throws only for states that must stop the boot: a malformed item, a
 * read-back mismatch, or ciphertext on disk with no key to open it.
 */
export const loadKeychainKey = (opts: KeychainKeyOptions): TokenKeyOutcome => {
  const { security, service, account, keyPath } = opts;
  const read = classifyRead(security(["find-generic-password", "-s", service, "-a", account, "-w"]));
  if (read.kind === "unavailable") return { kind: "unavailable", cause: read.cause };
  if (read.kind === "found") {
    const key = parseKey(read.value);
    if (!key) throw new Error(`Keychain item ${service} is not a ${KEY_BYTES}-byte base64 key`);
    return { kind: "key", key };
  }

  // Item missing. The file key, if there is one, is the key the database is under.
  const fromFile = existsSync(keyPath);
  if (!fromFile && opts.hasSealedRows()) {
    throw new Error(
      `Keychain item ${service} is missing and ${keyPath} does not exist, but the token database has rows: ` +
        "refusing to mint a new key over existing ciphertext. Restore the key (Keychain item or file) and retry.",
    );
  }
  const key = fromFile ? loadOrCreateKey(keyPath) : randomBytes(KEY_BYTES);
  const b64 = key.toString("base64");
  const add = security(["add-generic-password", "-U", "-s", service, "-a", account, "-w", b64]);
  if (add.status !== 0) return { kind: "unavailable", cause: causeOf(add, [b64]) };
  const back = classifyRead(security(["find-generic-password", "-s", service, "-a", account, "-w"]));
  const stored = back.kind === "found" ? parseKey(back.value) : undefined;
  if (!stored || !stored.equals(key)) {
    throw new Error(
      `Keychain item ${service} did not read back identical after writing${fromFile ? `; ${keyPath} was kept` : ""}`,
    );
  }
  if (fromFile) {
    unlinkSync(keyPath);
    return { kind: "key", key, note: `moved the token key from ${keyPath} into the Keychain (${service})` };
  }
  return { kind: "key", key, note: `created a token key in the Keychain (${service})` };
};

export type ResolveTokenKeyOptions = KeychainKeyOptions & { source: "file" | "keychain" };

/** File mode is the unchanged `loadOrCreateKey`; keychain mode is above. */
export const resolveTokenKey = (opts: ResolveTokenKeyOptions): TokenKeyOutcome =>
  opts.source === "file" ? { kind: "key", key: loadOrCreateKey(opts.keyPath) } : loadKeychainKey(opts);
