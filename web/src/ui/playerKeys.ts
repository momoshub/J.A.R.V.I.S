/**
 * Keys that drive the architecture flow player: Space plays or pauses, the
 * arrows step. Ignored with a modifier held, on key repeat for Space, and
 * whenever focus is somewhere that wants those keys itself.
 */
export type PlayerAction = "toggle" | "prev" | "next";

type KeyLike = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  repeat?: boolean;
  target: unknown;
};

const OWNS_KEYS = new Set(["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A", "SUMMARY"]);

export const playerAction = (e: KeyLike): PlayerAction | null => {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  const t = e.target as { tagName?: string; isContentEditable?: boolean; getAttribute?: (n: string) => string | null } | null;
  if (t?.isContentEditable) return null;
  if (t?.tagName && OWNS_KEYS.has(t.tagName)) return null;
  // A focused diagram box is a button too: Space/Enter select it there.
  if (t?.getAttribute?.("role") === "button") return null;
  if (e.key === "ArrowLeft") return "prev";
  if (e.key === "ArrowRight") return "next";
  if (e.key === " " && !e.repeat) return "toggle";
  return null;
};

/** The next index for a step action, clamped to the flow. -1 is "before the first step". */
export const stepIndex = (index: number, action: "prev" | "next", length: number): number =>
  action === "prev" ? Math.max(-1, index - 1) : Math.min(length - 1, index + 1);
