/**
 * The envelope every stored credential lives in: AES-256-GCM under a key kept
 * beside the database in its own 0600 file (or, on macOS, a Keychain item: see
 * `tokenKeyStore.ts`).
 *
 * Extracted from the token repo because a second kind of secret (TOTP seeds)
 * needs exactly the same treatment, and two copies of a crypto helper is one
 * copy too many - a fix to one of them would not reach the other.
 *
 * The database is committed like the main one; the key is not, so what lands in
 * git is ciphertext rather than live credentials, and a copy taken from anywhere
 * but the host opens nothing. It is not protection against someone who already
 * has the host.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { KEY_BYTES } from "../../domain/tokenKey.ts";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

/**
 * The key beside the database, minted on first use. Returned raw so the caller
 * holds it in memory only; it is never logged and never leaves this process.
 */
export const loadOrCreateKey = (path: string): Buffer => {
  if (existsSync(path)) {
    const key = Buffer.from(readFileSync(path, "utf8").trim(), "base64");
    if (key.length === KEY_BYTES) return key;
    throw new Error(`token key at ${path} is not a ${KEY_BYTES}-byte base64 key`);
  }
  mkdirSync(dirname(path), { recursive: true });
  const key = randomBytes(KEY_BYTES);
  writeFileSync(path, key.toString("base64"), { mode: 0o600 });
  chmodSync(path, 0o600);
  return key;
};

/** `iv.ciphertext.tag`, each base64. Self-describing, so nothing else is stored. */
export const seal = (plain: string, key: Buffer): string => {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, body, cipher.getAuthTag()].map((b) => b.toString("base64")).join(".");
};

/**
 * Undefined rather than a throw when a row will not open: a key that was rotated
 * or a row that was tampered with should read as "nothing on file", which sends
 * the user back through the normal ask, not as a crash mid-command.
 */
export const unseal = (sealed: string, key: Buffer): string | undefined => {
  const [iv, body, tag] = sealed.split(".");
  if (!iv || !body || !tag) return undefined;
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return undefined;
  }
};
