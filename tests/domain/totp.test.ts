/**
 * The 2FA maths, against the RFC 6238 vectors - a code that is merely plausible
 * is worthless, since the only thing that matters is the server agreeing.
 */
import { describe, expect, it } from "bun:test";
import {
  isTotpSecret,
  normaliseLabel,
  parseOtpauth,
  parseTotpInput,
  secondsLeft,
  serialiseTotp,
  totpCode,
} from "../../src/domain/totp.ts";

/** RFC 6238 appendix B: the ASCII seed "12345678901234567890", in base32. */
const RFC = { secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", digits: 8, period: 30, algorithm: "SHA1" } as const;

describe("totpCode", () => {
  it("matches the RFC 6238 vectors", () => {
    expect(totpCode(RFC, 59_000)).toBe("94287082");
    expect(totpCode(RFC, 1_111_111_109_000)).toBe("07081804");
    expect(totpCode(RFC, 1_234_567_890_000)).toBe("89005924");
    expect(totpCode(RFC, 2_000_000_000_000)).toBe("69279037");
  });

  it("pads a code that comes out short", () => {
    const code = totpCode({ ...RFC, digits: 6 }, 59_000);
    expect(code).toHaveLength(6);
    expect(code).toBe("287082");
  });

  it("holds one code for the whole period and changes at the boundary", () => {
    const cfg = { ...RFC, digits: 6 };
    expect(totpCode(cfg, 30_000)).toBe(totpCode(cfg, 59_999));
    expect(totpCode(cfg, 60_000)).not.toBe(totpCode(cfg, 59_999));
  });
});

describe("secondsLeft", () => {
  it("counts down to the next boundary", () => {
    expect(secondsLeft(RFC, 30_000)).toBe(30);
    expect(secondsLeft(RFC, 45_000)).toBe(15);
    expect(secondsLeft(RFC, 59_000)).toBe(1);
  });
});

describe("parseOtpauth", () => {
  it("reads the account, issuer and parameters a QR encodes", () => {
    const cfg = parseOtpauth(
      "otpauth://totp/acme:demo%40acme.io?secret=GEZDGNBVGY3TQOJQ&issuer=acme&algorithm=SHA256&digits=8&period=60",
    );
    expect(cfg).toEqual({
      secret: "GEZDGNBVGY3TQOJQ",
      digits: 8,
      period: 60,
      algorithm: "SHA256",
      account: "demo@acme.io",
      issuer: "acme",
    });
  });

  it("falls back to the defaults when the parameters are missing or nonsense", () => {
    const cfg = parseOtpauth("otpauth://totp/demo?secret=GEZDGNBVGY3TQOJQ&digits=nope&period=0&algorithm=MD5");
    expect(cfg).toMatchObject({ digits: 6, period: 30, algorithm: "SHA1", account: "demo", issuer: undefined });
  });

  it("refuses hotp, which is counter-based and would desynchronise the real app", () => {
    expect(parseOtpauth("otpauth://hotp/demo?secret=GEZDGNBVGY3TQOJQ&counter=1")).toBeUndefined();
  });

  it("refuses anything that is not a readable otpauth uri with a usable secret", () => {
    expect(parseOtpauth("https://example.com")).toBeUndefined();
    expect(parseOtpauth("otpauth://totp/demo?secret=0189")).toBeUndefined();
    expect(parseOtpauth("otpauth://totp/demo")).toBeUndefined();
  });
});

describe("parseTotpInput", () => {
  it("takes the bare base32 secret a site prints beside the QR", () => {
    expect(parseTotpInput("gezd gnbv gy3t qojq")).toEqual({
      secret: "GEZDGNBVGY3TQOJQ",
      digits: 6,
      period: 30,
      algorithm: "SHA1",
    });
  });

  it("prefers the uri reading when given one", () => {
    expect(parseTotpInput("otpauth://totp/demo?secret=GEZDGNBVGY3TQOJQ&period=60")?.period).toBe(60);
  });

  it("does not fall back to the secret reading for a uri it could not read", () => {
    expect(parseTotpInput("otpauth://hotp/demo?secret=GEZDGNBVGY3TQOJQ")).toBeUndefined();
  });

  it("refuses an empty or too-short paste", () => {
    expect(parseTotpInput("")).toBeUndefined();
    expect(parseTotpInput("GEZDGNBV")).toBeUndefined();
  });
});

describe("serialiseTotp", () => {
  it("round-trips a config through the uri form without losing anything", () => {
    const cfg = parseOtpauth(
      "otpauth://totp/acme:demo%40acme.io?secret=GEZDGNBVGY3TQOJQ&issuer=acme&algorithm=SHA512&digits=7&period=45",
    );
    expect(parseOtpauth(serialiseTotp(cfg!))).toEqual(cfg!);
  });
});

describe("isTotpSecret and normaliseLabel", () => {
  it("accepts a padded, spaced, lower-case secret and rejects a short or non-base32 one", () => {
    expect(isTotpSecret("gezd-gnbv gy3t qojq==")).toBe(true);
    expect(isTotpSecret("GEZDGNBVGY3TQOJ1")).toBe(false);
    expect(isTotpSecret(undefined)).toBe(false);
  });

  it("folds a label to one predictable shape", () => {
    expect(normaliseLabel("  Demo   Acme ")).toBe("demo-acme");
  });
});
