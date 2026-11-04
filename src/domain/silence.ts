/**
 * A reply whose only content is that it is not replying.
 *
 * The follow rules ask for a truly empty reply when there is nothing to add,
 * and the model still sometimes writes the decision down instead: "(empty
 * reply - nothing to add here)" landed in a channel thread as a real message.
 * A prompt rule the model can ignore is not a guarantee, so the boundary drops
 * these too. Kept deliberately narrow - short, and nothing but a silence
 * phrase - so a real answer that happens to mention one is never swallowed.
 */
const SILENCE =
  /^(?:empty reply|no reply(?: needed| required)?|no response(?: needed| required)?|nothing (?:to add|further|more to add)|staying (?:quiet|silent)|silence|(?:a )?reaction is enough|not for me)\b/;

/** Longest note still treated as a placeholder rather than an answer. */
const MAX_NOTE = 80;

export const isSilenceNote = (text: string): boolean => {
  const t = text.trim();
  if (!t || t.length > MAX_NOTE) return false;
  const bare = t
    .replace(/^[\s([_*~`"']+|[\s)\]_*~`"'.!]+$/g, "")
    .toLowerCase();
  return SILENCE.test(bare);
};
