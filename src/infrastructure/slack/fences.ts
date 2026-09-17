/**
 * Streaming fence normaliser.
 *
 * Slack's streaming renderer is stricter about ``` than Markdown is: it takes
 * the whole remainder of the opening line as the language tag, and it only
 * recognises a closing fence that starts its own line. So a model that writes
 * "```// a comment" loses that comment, and one that writes "});```" never
 * closes the block - everything after it is swallowed into the code card.
 *
 * This rewrites the text as it flows past so every ``` sits alone on its line,
 * keeping a real language tag ("```ts") and demoting anything else to content.
 * It holds back only what it must (a partial fence marker, the opening line
 * while it decides on a language), so streaming still feels live.
 */

/** A plausible language tag: one bare word, nothing that reads like prose or code. */
const LANG = /^[A-Za-z0-9_+#.-]{1,20}$/;

export type FenceNormalizer = {
  /** Feed a delta, get back the text that is safe to send now (may be ""). */
  push: (delta: string) => string;
  /** Emit whatever is still held back, at the end of the turn. */
  flush: () => string;
};

export const createFenceNormalizer = (): FenceNormalizer => {
  let buf = "";
  let out = "";
  let inFence = false;
  let awaitLang = false;
  let atLineStart = true;
  // A closing fence supplies its own newline, so the model's next one is a dupe.
  let skipNewline = false;
  let eatNewline = false;

  const emit = (text: string): void => {
    if (!text) return;
    out += text;
    atLineStart = text.endsWith("\n");
  };

  const run = (final: boolean): string => {
    out = "";
    for (;;) {
      if (awaitLang) {
        const nl = buf.indexOf("\n");
        if (nl === -1 && !final) break;
        const line = nl === -1 ? buf : buf.slice(0, nl);
        buf = nl === -1 ? "" : buf.slice(nl + 1);
        awaitLang = false;
        const tag = line.trim();
        if (!tag) {
          emit("\n");
        } else if (LANG.test(tag)) {
          emit(`${tag}\n`);
        } else {
          // Not a language - it is content, so close the opening line and
          // push it back through as the first line inside the block.
          emit("\n");
          buf = `${line}\n${buf}`;
        }
        continue;
      }

      // A newline right after a closing fence is the model's own spacing, and we
      // already wrote one. It can land in a later delta, so the flag has to wait.
      if (eatNewline && buf) {
        if (buf.startsWith("\n")) buf = buf.slice(1);
        eatNewline = false;
      }

      if (skipNewline) {
        if (!buf) break;
        skipNewline = false;
        if (buf.startsWith("\n")) buf = buf.slice(1);
        continue;
      }

      const i = buf.indexOf("```");
      if (i === -1) {
        // A trailing backtick or two could be the start of a fence, so hold it.
        let keep = 0;
        if (!final) while (keep < buf.length && buf[buf.length - 1 - keep] === "`") keep += 1;
        emit(buf.slice(0, buf.length - keep));
        buf = buf.slice(buf.length - keep);
        break;
      }

      emit(buf.slice(0, i));
      buf = buf.slice(i + 3);
      if (!atLineStart) emit("\n");
      emit("```");
      if (inFence) {
        inFence = false;
        emit("\n");
        eatNewline = true;
      } else {
        inFence = true;
        awaitLang = true;
      }
    }
    return out;
  };

  return {
    push: (delta: string) => {
      buf += delta;
      return run(false);
    },
    flush: () => {
      let text = run(true);
      // An unterminated block would eat the end of the message.
      if (inFence) {
        inFence = false;
        text += atLineStart ? "```\n" : "\n```\n";
      }
      return text;
    },
  };
};
