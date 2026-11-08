/**
 * Keys that drive the architecture flow player: Space plays or pauses, the
 * arrows step. Ignored with a modifier held and on Space repeat. Space is left
 * to anything focused that presses or types with it; the arrows only to fields.
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

/** Where Space means something already (press, toggle, type). Arrows only move a caret in fields. */
const OWNS_SPACE = new Set(["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A", "SUMMARY"]);
const OWNS_ARROWS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

export const playerAction = (e: KeyLike): PlayerAction | null => {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  const t = e.target as { tagName?: string; isContentEditable?: boolean; getAttribute?: (n: string) => string | null } | null;
  if (t?.isContentEditable) return null;
  const tag = t?.tagName ?? "";
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    if (OWNS_ARROWS.has(tag)) return null;
    return e.key === "ArrowLeft" ? "prev" : "next";
  }
  if (e.key !== " " || e.repeat) return null;
  // A focused diagram box is a button too: Space selects it there.
  if (OWNS_SPACE.has(tag) || t?.getAttribute?.("role") === "button") return null;
  return "toggle";
};

/** The next index for a step action, clamped to the flow. -1 is "before the first step". */
export const stepIndex = (index: number, action: "prev" | "next", length: number): number =>
  action === "prev" ? Math.max(-1, index - 1) : Math.min(length - 1, index + 1);
