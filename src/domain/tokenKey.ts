/**
 * Rules for where the token-database key may live, with no IO: what a key
 * looks like, and how to read the outcome of the macOS `security` CLI.
 */
export const KEY_BYTES = 32;

export type TokenKeySource = "file" | "keychain";

/** What one `security` invocation returned. Never carries the arguments. */
export type SecurityResult = { status: number; stdout: string; stderr: string };

/** Runs `security <args>`. Injected so tests never touch a real Keychain. */
export type SecurityRunner = (args: string[]) => SecurityResult;

/** A base64 AES-256 key, or undefined when the text is anything else. */
export const parseKey = (b64: string): Buffer | undefined => {
  const key = Buffer.from(b64.trim(), "base64");
  return key.length === KEY_BYTES ? key : undefined;
};

/**
 * `found` carries the item, `missing` is a clean "no such item" (the only case
 * that may lead to creating one), `unavailable` is everything else - locked,
 * no GUI session, no `security` binary - and says why.
 */
export type KeychainRead =
  | { kind: "found"; value: string }
  | { kind: "missing" }
  | { kind: "unavailable"; cause: string };

// errSecItemNotFound surfaces as exit 44 and this sentence.
const NOT_FOUND_STATUS = 44;

export const classifyRead = (res: SecurityResult): KeychainRead => {
  if (res.status === 0) return { kind: "found", value: res.stdout.trim() };
  if (res.status === NOT_FOUND_STATUS || /could not be found/i.test(res.stderr)) return { kind: "missing" };
  return { kind: "unavailable", cause: causeOf(res, []) };
};

/** One line saying why the Keychain said no, with any secret scrubbed out. */
export const causeOf = (res: SecurityResult, secrets: string[]): string => {
  const raw = res.stderr.trim().split("\n")[0] ?? "";
  const clean = secrets.reduce((text, s) => (s ? text.split(s).join("[redacted]") : text), raw);
  const hint = /interaction is not allowed|locked|authorization/i.test(clean)
    ? " (Keychain locked or no login session - unlock it or log in)"
    : "";
  return `security exited ${res.status}${clean ? `: ${clean}` : ""}${hint}`;
};
