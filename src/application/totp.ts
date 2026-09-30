/**
 * Shared 2FA codes: the storage port and what happens when someone submits a seed.
 *
 * The point is the shared logins - a staging demo account, a vendor portal -
 * where the authenticator lives on one person's phone and everyone else waits on
 * them. Holding the seed here turns that into a command anybody on the team can
 * run. It is deliberately not for personal accounts: a seed is the second factor,
 * so whoever holds it holds half the login.
 *
 * A seed is never typed into a channel. It arrives through a Slack modal, whose
 * input is not a message: not in history, not in search, not in the bot's memory.
 * What comes back out is only ever a code that expires within the minute.
 */
import { normaliseLabel, parseTotpInput, serialiseTotp, type TotpConfig } from "../domain/totp.ts";

/** Storage for shared seeds. The concrete repo encrypts; this shape does not care. */
export type TotpPort = {
  get: (label: string) => TotpConfig | undefined;
  has: (label: string) => boolean;
  /** `uri` is the serialised otpauth form, which carries every parameter. */
  set: (label: string, uri: string, addedBy: string, account?: string) => void;
  /** True when there was one to forget. */
  remove: (label: string) => boolean;
  /** Labels only, never a seed. */
  list: () => { label: string; account?: string; addedBy: string; updatedAt: number }[];
};

/** Button on the "paste the seed" message. Opens the modal. */
export const TOTP_ACTION = "totp_secret_add";
/** Callback id of the modal itself, and the ids inside it. */
export const TOTP_VIEW = "totp_secret_view";
export const TOTP_BLOCK = "totp_secret_block";
export const TOTP_INPUT = "totp_secret_input";

/**
 * What the button carries and the modal hands back. Slack round-trips it for us
 * (`value`, `private_metadata`), so there is no pending-state table to keep,
 * expire or leak - and the seed itself is never part of it.
 */
export type TotpRequest = {
  channelId: string;
  threadTs?: string;
  /** Label the seed is being stored under. */
  label: string;
};

export const encodeTotpRequest = (req: TotpRequest): string => JSON.stringify(req);

export const decodeTotpRequest = (raw: string | undefined): TotpRequest | undefined => {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    const { channelId, threadTs, label } = parsed as Record<string, unknown>;
    if (typeof channelId !== "string" || !channelId) return undefined;
    if (typeof label !== "string" || !label) return undefined;
    return { channelId, label, threadTs: typeof threadTs === "string" && threadTs ? threadTs : undefined };
  } catch {
    return undefined;
  }
};

export type TotpSubmission = {
  slackUserId: string;
  /** An `otpauth://` URI (what a QR decodes to) or the bare base32 seed. */
  secret: string;
  request?: TotpRequest;
};

export type TotpOutcome =
  | { kind: "saved"; label: string; account?: string; request?: TotpRequest }
  /** Rejected without being stored; `error` is safe to show the user. */
  | { kind: "invalid"; error: string }
  | { kind: "no-store" };

export type TotpDeps = {
  totp?: TotpPort;
};

/**
 * Validate and store a submitted seed. Returns what to do next rather than doing
 * it, so the transport owns the confirmation message and the modal's own error
 * rendering - the same split the token modal uses.
 */
export const submitTotpSecret = (deps: TotpDeps, sub: TotpSubmission): TotpOutcome => {
  if (!deps.totp) return { kind: "no-store" };
  const label = normaliseLabel(sub.request?.label ?? "");
  if (!label) return { kind: "invalid", error: "I need a name to file that under" };
  const cfg = parseTotpInput(sub.secret);
  if (!cfg) {
    return {
      kind: "invalid",
      error: /^otpauth:/i.test(sub.secret.trim())
        ? "I can read otpauth://totp/ links only - a counter-based (hotp) one would drift out of sync"
        : "that is not a setup key - paste the otpauth:// link from the QR, or the base32 key printed beside it",
    };
  }
  deps.totp.set(label, serialiseTotp(cfg), sub.slackUserId, cfg.account);
  return { kind: "saved", label, account: cfg.account, request: sub.request };
};
