/**
 * The colour theme: follow the system, or force light or dark.
 *
 * The page only ever reads `<html data-theme="light|dark">`, the RESOLVED
 * value, so the CSS has one dark block. `index.html` resolves it inline before
 * first paint (no light flash on a dark page); this module owns the toggle and
 * keeps "system" in step with the OS while the page is open. Both use
 * `THEME_KEY` - a test holds `index.html` to it.
 */
export type ThemePref = "system" | "light" | "dark";
export type Theme = "light" | "dark";

export const THEME_KEY = "dashboard.theme";
const PREFS: readonly ThemePref[] = ["system", "light", "dark"];

type Store = Pick<Storage, "getItem" | "setItem">;

export const readTheme = (store: Store | undefined): ThemePref => {
  try {
    const v = store?.getItem(THEME_KEY);
    return PREFS.includes(v as ThemePref) ? (v as ThemePref) : "system";
  } catch {
    return "system";
  }
};

export const writeTheme = (store: Store | undefined, pref: ThemePref): void => {
  try {
    store?.setItem(THEME_KEY, pref);
  } catch {
    // Not remembered; the choice still holds for this visit.
  }
};

export const resolveTheme = (pref: ThemePref, systemDark: boolean): Theme =>
  pref === "system" ? (systemDark ? "dark" : "light") : pref;

/** The toggle cycles system -> light -> dark -> system. */
export const nextTheme = (pref: ThemePref): ThemePref => PREFS[(PREFS.indexOf(pref) + 1) % PREFS.length] ?? "system";

export const THEME_LABEL: Record<ThemePref, string> = {
  system: "Theme: follows the system",
  light: "Theme: light",
  dark: "Theme: dark",
};
