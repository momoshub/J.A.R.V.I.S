/**
 * Time-based one-time passwords (RFC 6238) - the six digits an authenticator app
 * shows, worked out from a shared secret and the clock.
 *
 * A 2FA QR code is not an image the bot needs to keep: it encodes an `otpauth://`
 * URI, and that URI is the whole of the credential. So the unit here is the URI
 * (or the bare base32 secret printed beside it), parsed once into a config that
 * any later code generation is derived from.
 *
 * Pure: no storage, no clock of its own, no Slack. The caller passes the moment,
 * which is what makes "is this the code the server expects" testable at all.
 */
import { createHmac } from "node:crypto";

export type TotpAlgorithm = "SHA1" | "SHA256" | "SHA512";

export type TotpConfig = {
  /** Normalised base32: upper case, no padding, no spaces. */
  secret: string;
  digits: number;
  /** Seconds one code is valid for. */
  period: number;
  algorithm: TotpAlgorithm;
  /** What the QR called the account, e.g. `someone@example.com`. */
  account?: string;
  /** Who issued it, e.g. `GitHub`. */
  issuer?: string;
};

export const DEFAULT_DIGITS = 6;
export const DEFAULT_PERIOD = 30;
export const DEFAULT_ALGORITHM: TotpAlgorithm = "SHA1";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/** Shortest secret worth accepting: 80 bits, the RFC 4226 floor. */
const MIN_SECRET_CHARS = 16;

/**
 * Strip what people paste around a secret. Authenticator apps print it in
 * space-separated groups, some sites lower-case it, and a copied value often
 * carries `=` padding - all of which are the same secret.
 */
const normaliseSecret = (raw: string): string => raw.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();

/** Is this a usable base32 secret? Shape only - whether the server agrees is its business. */
export const isTotpSecret = (raw: string | undefined): boolean => {
  const s = normaliseSecret(raw ?? "");
  return s.length >= MIN_SECRET_CHARS && /^[A-Z2-7]+$/.test(s);
};

const decodeBase32 = (secret: string): Buffer => {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of secret) {
    const idx = BASE32.indexOf(char);
    if (idx < 0) throw new Error("secret is not base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
};

const asAlgorithm = (raw: string | null): TotpAlgorithm => {
  const v = (raw ?? "").toUpperCase();
  return v === "SHA256" || v === "SHA512" ? v : DEFAULT_ALGORITHM;
};

/** A positive integer parameter, or the default when it is missing or nonsense. */
const asCount = (raw: string | null, fallback: number, max: number): number => {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 && n <= max ? n : fallback;
};

/**
 * Parse the `otpauth://totp/...` URI a 2FA QR code carries.
 *
 * Undefined rather than a throw for anything that is not one: the caller offers
 * the user a second reading (a bare secret), and a wrong guess about which of
 * the two they pasted should not be an error.
 *
 * `otpauth://hotp/` is rejected on purpose - it is counter-based, so a code
 * generated from it here would silently desynchronise the real authenticator.
 */
export const parseOtpauth = (raw: string): TotpConfig | undefined => {
  const text = raw.trim();
  if (!/^otpauth:\/\//i.test(text)) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.host.toLowerCase() !== "totp") return undefined;
  const secret = normaliseSecret(url.searchParams.get("secret") ?? "");
  if (!isTotpSecret(secret)) return undefined;

  // The path is `/Issuer:account` or just `/account`, percent-encoded.
  const path = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const sep = path.indexOf(":");
  const pathIssuer = sep > 0 ? path.slice(0, sep) : undefined;
  const account = (sep > 0 ? path.slice(sep + 1) : path).trim() || undefined;

  return {
    secret,
    digits: asCount(url.searchParams.get("digits"), DEFAULT_DIGITS, 10),
    period: asCount(url.searchParams.get("period"), DEFAULT_PERIOD, 300),
    algorithm: asAlgorithm(url.searchParams.get("algorithm")),
    account,
    issuer: (url.searchParams.get("issuer") ?? pathIssuer)?.trim() || undefined,
  };
};

/**
 * What someone pasted, as a config: either a whole `otpauth://` URI (what a QR
 * decodes to) or the bare base32 secret a site prints next to the QR.
 */
export const parseTotpInput = (raw: string): TotpConfig | undefined => {
  const text = (raw ?? "").trim();
  if (!text) return undefined;
  const uri = parseOtpauth(text);
  if (uri) return uri;
  if (/^otpauth:/i.test(text)) return undefined; // a URI we could not read is not a secret
  const secret = normaliseSecret(text);
  if (!isTotpSecret(secret)) return undefined;
  return { secret, digits: DEFAULT_DIGITS, period: DEFAULT_PERIOD, algorithm: DEFAULT_ALGORITHM };
};

/** The config as a single storable string - the URI form, so nothing is lost. */
export const serialiseTotp = (cfg: TotpConfig): string => {
  const path = cfg.issuer && cfg.account ? `${cfg.issuer}:${cfg.account}` : (cfg.account ?? "account");
  const params = new URLSearchParams({
    secret: cfg.secret,
    algorithm: cfg.algorithm,
    digits: String(cfg.digits),
    period: String(cfg.period),
  });
  if (cfg.issuer) params.set("issuer", cfg.issuer);
  return `otpauth://totp/${encodeURIComponent(path)}?${params.toString()}`;
};

/** The code valid at `atMs`, zero-padded to `digits`. */
export const totpCode = (cfg: TotpConfig, atMs: number): string => {
  const counter = Math.floor(atMs / 1000 / cfg.period);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const mac = createHmac(cfg.algorithm.toLowerCase(), decodeBase32(cfg.secret)).update(buf).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) | ((mac[offset + 1]! & 0xff) << 16) | ((mac[offset + 2]! & 0xff) << 8) | (mac[offset + 3]! & 0xff);
  return String(binary % 10 ** cfg.digits).padStart(cfg.digits, "0");
};

/** Seconds this code has left. Told to the user, since a 2s code is worth waiting out. */
export const secondsLeft = (cfg: TotpConfig, atMs: number): number =>
  cfg.period - (Math.floor(atMs / 1000) % cfg.period);

/**
 * A label is how a stored secret is asked for later, so it is folded to one
 * predictable shape rather than trusting whatever case someone typed.
 */
export const normaliseLabel = (raw: string): string => raw.trim().toLowerCase().replace(/\s+/g, "-");
