/**
 * Whether the sidebar is collapsed, kept per browser.
 *
 * Storage is passed in so this stays pure and testable, and every read or
 * write survives a storage that throws (private mode, a full quota): the
 * sidebar then simply starts expanded rather than taking the page down.
 */
export const SIDEBAR_KEY = "dashboard.sidebar.collapsed";

type Store = Pick<Storage, "getItem" | "setItem">;

export const readCollapsed = (store: Store | undefined): boolean => {
  try {
    return store?.getItem(SIDEBAR_KEY) === "1";
  } catch {
    return false;
  }
};

export const writeCollapsed = (store: Store | undefined, collapsed: boolean): void => {
  try {
    store?.setItem(SIDEBAR_KEY, collapsed ? "1" : "0");
  } catch {
    // Not remembered this time; the toggle still works for the session.
  }
};

/** Ctrl/Cmd + B, the shortcut editors use for a sidebar. Not on key repeat, mid-IME, or while typing. */
type KeyLike = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  target: unknown;
};

export const isToggleShortcut = (e: KeyLike): boolean => {
  if (e.repeat || e.isComposing) return false;
  if (e.key.toLowerCase() !== "b" || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return false;
  const t = e.target as { tagName?: string; isContentEditable?: boolean } | null;
  if (t?.isContentEditable) return false;
  return t?.tagName !== "INPUT" && t?.tagName !== "TEXTAREA" && t?.tagName !== "SELECT";
};
