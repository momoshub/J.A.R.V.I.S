/**
 * Whether the bot is allowed to drive the desktop UI.
 *
 * On macOS this is the Accessibility permission, and it is granted against the
 * *path* of the executable that launched the process - for a launchd agent, the
 * runtime binary rather than anything recognisable. Two things follow:
 *
 * - it is easy to grant to the wrong thing (a terminal, which already has it,
 *   so an interactive test passes while the bot still cannot)
 * - it disappears silently. A package manager that installs into a versioned
 *   directory moves the binary on upgrade, the stored grant stops matching, and
 *   nothing announces it. The bot simply starts refusing UI actions, weeks
 *   later, in a way that points at anything but the upgrade
 *
 * So it is probed and reported rather than assumed. Losing it is not fatal -
 * almost nothing here needs the UI - which is exactly why it has to be visible:
 * a capability that fails quietly and rarely is the one nobody connects to its
 * cause.
 */

/** What a probe concluded. */
export type UiAccess =
  /** The UI responded, so the permission is in place. */
  | "granted"
  /** Refused for permission, specifically. */
  | "denied"
  /** Not a platform with this concept, so there is nothing to report. */
  | "not-applicable"
  /** It failed for some other reason, which is not the same as being refused. */
  | "unknown";

/**
 * macOS refuses assistive access with `-1743`, worded a few different ways
 * across versions. Matched loosely: a false "denied" costs a misleading health
 * line, while a false "granted" is the silence this exists to prevent.
 */
const REFUSED = /-1743|not allowed assistive access|not authori[sz]ed to send apple events|accessibility access/i;

export const readUiAccess = (
  result: { exitCode: number; stderr: string },
  platform: string = process.platform,
): UiAccess => {
  if (platform !== "darwin") return "not-applicable";
  if (result.exitCode === 0) return "granted";
  return REFUSED.test(result.stderr) ? "denied" : "unknown";
};

/** Does this state need somebody to do something? */
export const needsAttention = (access: UiAccess): boolean => access === "denied";

/**
 * One line for a log or a health endpoint. A denial says what to do about it,
 * because by the time anyone reads this they will have forgotten that a grant
 * is attached to a path that can move.
 */
export const describeUiAccess = (access: UiAccess, binaryPath?: string): string => {
  const which = binaryPath ? ` Grant it to ${binaryPath}.` : "";
  switch (access) {
    case "granted":
      return "desktop UI control: allowed";
    case "denied":
      return `desktop UI control: REFUSED - the Accessibility permission is missing or no longer matches this binary (an upgrade moves it).${which}`;
    case "not-applicable":
      return "desktop UI control: not applicable on this platform";
    case "unknown":
      return "desktop UI control: could not be determined - the probe failed for a reason other than permission";
  }
};
