/**
 * Ask the desktop whether we are allowed to drive it.
 *
 * `AXIsProcessTrusted()` asks the system about Accessibility directly. It takes
 * about 50ms and touches nothing. The earlier version scripted System Events,
 * which answers a different question - Automation - and so reported "allowed"
 * while the real UI call was refused.
 *
 * It reports on THIS process. The brain's UI actions run one level further out,
 * inside the CLI the bot spawns, and the system may attribute the permission to
 * that binary instead - which is why a denial names both paths rather than
 * guessing at one.
 *
 * Cached, because the answer only changes when a human changes it (or a package
 * upgrade moves the binary out from under the grant), and re-probed on a TTL so
 * a health check reports something current rather than something from boot.
 */
import { readUiAccess, type UiAccess } from "../../domain/uiAccess.ts";

export type UiAccessReport = {
  access: UiAccess;
  /** When this was last established, epoch ms. */
  checkedAt: number;
};

export type UiAccessProbe = {
  /** The current answer, re-probing when the cached one has gone stale. */
  read: () => Promise<UiAccessReport>;
};

const PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_TTL_MS = 300_000;

const AX_CHECK = 'ObjC.import("ApplicationServices"); $.AXIsProcessTrusted()';

const run = async (): Promise<{ exitCode: number; stdout: string }> => {
  try {
    const proc = Bun.spawn({
      cmd: ["osascript", "-l", "JavaScript", "-e", AX_CHECK],
      stdout: "pipe",
      stderr: "ignore",
      timeout: PROBE_TIMEOUT_MS,
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { exitCode, stdout };
  } catch (err) {
    // No osascript, or it could not be spawned at all. That is "unknown", not
    // "denied" - saying someone forgot a permission they never needed is worse
    // than saying nothing.
    return { exitCode: -1, stdout: err instanceof Error ? err.message : String(err) };
  }
};

export const createUiAccessProbe = (
  ttlMs: number = DEFAULT_TTL_MS,
  now: () => number = () => Date.now(),
): UiAccessProbe => {
  let cached: UiAccessReport | undefined;
  let inFlight: Promise<UiAccessReport> | undefined;

  const probe = async (): Promise<UiAccessReport> => {
    const report = { access: readUiAccess(await run()), checkedAt: now() };
    cached = report;
    return report;
  };

  return {
    read: async () => {
      if (cached && now() - cached.checkedAt < ttlMs) return cached;
      // One probe at a time: a burst of health checks should not become a burst
      // of subprocesses.
      inFlight ??= probe().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
  };
};
