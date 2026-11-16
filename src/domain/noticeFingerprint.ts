/**
 * A fingerprint of an approval notice as it is shown: what each block says and
 * which buttons it carries (id, label, value).
 *
 * A notice that keeps live buttons is a trigger, so a press is honoured only on
 * the message exactly as the bot last rendered it. Checking that the fact is
 * still quoted is not enough: a rewrite can keep the fact and relabel the
 * button. The bot stores this when it posts or rewrites the notice, and compares
 * it with the blocks Slack hands back on a press.
 *
 * Slack echoes blocks with extra fields (`block_id`, `verbatim`, `action_ts`)
 * and may escape the quote marker, so only the fields the bot writes are read,
 * whitespace is dropped, and `&gt;` is read as `>`. Slack also hands an emoji
 * back as its shortcode (the notice's 🧠 returns as `:brain:`), so emoji are
 * dropped in both forms. A `<` is never softened: a live link in place of an
 * escaped one is a different message.
 *
 * Pure: blocks in, hex digest out.
 */
import { createHash } from "node:crypto";

type Loose = Record<string, unknown>;

const isRecord = (v: unknown): v is Loose => typeof v === "object" && v !== null && !Array.isArray(v);

/** An emoji as the bot writes it (unicode) or as Slack echoes it (`:shortcode:`). */
const EMOJI = /:[a-z0-9_+'-]+:|[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{FE0F}\u{200D}]/gu;

/** Text with every emoji dropped, so what the bot wrote and what Slack echoes compare equal. */
export const withoutEmoji = (text: string): string => text.replace(EMOJI, "");

const canon = (text: unknown): string =>
  typeof text === "string" ? withoutEmoji(text.replaceAll("&gt;", ">")).replace(/\s+/g, "") : "";

const textOf = (v: unknown): string => (isRecord(v) ? canon(v.text) : "");

const describe = (block: unknown): unknown => {
  if (!isRecord(block)) return ["?"];
  const type = typeof block.type === "string" ? block.type : "?";
  if (type === "section") return [type, textOf(block.text)];
  if (type === "actions") {
    const elements = Array.isArray(block.elements) ? block.elements : [];
    return [
      type,
      elements.map((e) =>
        isRecord(e)
          ? [e.type, e.action_id, textOf(e.text), e.value]
          : ["?"],
      ),
    ];
  }
  // Anything else (the signature footer) counts by its place only: it carries no decision.
  return [type];
};

/** Digest of the blocks' shown text and buttons, in order. Empty input still digests, to a value no real notice has. */
export const noticeFingerprint = (blocks: readonly unknown[]): string =>
  createHash("sha256").update(JSON.stringify(blocks.map(describe))).digest("hex");
