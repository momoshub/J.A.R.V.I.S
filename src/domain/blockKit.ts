/**
 * Block Kit in a reply.
 *
 * The model writes prose, and sometimes the thing it has is not prose: a table,
 * a warning that should look like one, a row of cards to browse, a plan with
 * steps. Slack has blocks for each of those, and the streaming API takes them
 * as a `blocks` chunk in the middle of a streamed message - so the reply can
 * carry them where they belong rather than as a description of a table.
 *
 * The model marks them with a fenced code block tagged `blockkit` holding a JSON
 * array of blocks (or `{"blocks": [...]}`). This module pulls those out of the
 * text as it flows past, so the stream sends the prose as text and each fence
 * as blocks, in order. A fence that does not parse is not dropped: it goes out
 * as an ordinary code block, because a malformed table is still information and
 * a silent hole in the reply is not.
 */

export type Block = { type: string } & Record<string, unknown>;

export type Segment =
  | { kind: "text"; text: string }
  /** `fallback`: the fence's own mrkdwn stand-in (`{"text": ..., "blocks": [...]}`). */
  | { kind: "blocks"; blocks: Block[]; fallback?: string };

/** Slack refuses more than 50 blocks in one message or chunk. */
export const MAX_BLOCKS = 50;

/** The fence tags that mean "this is Block Kit JSON, render it". */
const KIT_TAGS = new Set(["blockkit", "block-kit", "blocks"]);

const isBlock = (v: unknown): v is Block =>
  typeof v === "object" && v !== null && !Array.isArray(v) && typeof (v as { type?: unknown }).type === "string";

/**
 * Parse a fence body into blocks - and, for `{"text": ..., "blocks": [...]}`,
 * the mrkdwn that stands in for them in a notification - or undefined when it
 * is not usable Block Kit.
 */
export const parseKit = (raw: string): { blocks: Block[]; fallback?: string } | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  let fallback: string | undefined;
  if (isBlock(value) && value.type !== "blocks") value = [value];
  else if (typeof value === "object" && value !== null && "blocks" in value) {
    const text = (value as { text?: unknown }).text;
    if (typeof text === "string" && text.trim()) fallback = text;
    value = (value as { blocks: unknown }).blocks;
  }
  if (!Array.isArray(value) || value.length === 0 || !value.every(isBlock)) return undefined;
  return { blocks: value.slice(0, MAX_BLOCKS), ...(fallback ? { fallback } : {}) };
};

/** Parse a fence body into blocks, or undefined when it is not usable Block Kit. */
export const parseBlocks = (raw: string): Block[] | undefined => parseKit(raw)?.blocks;

/**
 * A reply that is a Block Kit message with its own mrkdwn fallback, for code
 * (a command) rather than the model. Backticks are escaped so a title holding
 * a fence cannot close this one early; JSON.parse reads them back.
 */
export const blockKitReply = (text: string, blocks: readonly Block[]): string =>
  `\`\`\`blockkit\n${JSON.stringify({ text, blocks: blocks.slice(0, MAX_BLOCKS) }).replace(/`/g, "\\u0060")}\n\`\`\`\n`;

export type BlockKitExtractor = {
  /** Feed a delta, get back the segments that are safe to send now. */
  push: (delta: string) => Segment[];
  /** Emit whatever is still held, at the end of the turn. */
  flush: () => Segment[];
};

export const createBlockKitExtractor = (): BlockKitExtractor => {
  let buf = "";
  let mode: "text" | "code" | "kit" = "text";
  // The newline after a closing kit fence is the fence's own, and it can land
  // in a later delta than the fence did.
  let eatNewline = false;

  const run = (final: boolean): Segment[] => {
    const out: Segment[] = [];
    const text = (t: string): void => {
      if (!t) return;
      const last = out[out.length - 1];
      if (last?.kind === "text") last.text += t;
      else out.push({ kind: "text", text: t });
    };

    for (;;) {
      if (eatNewline) {
        const m = /^[ \t]*(\n|$)/.exec(buf);
        if (m?.[1] === "\n") {
          buf = buf.slice(m[0].length);
          eatNewline = false;
        } else if (m && !final) break;
        else eatNewline = false;
      }
      if (mode === "kit") {
        const end = buf.indexOf("```");
        if (end === -1) {
          if (!final) break;
          // Never closed: show what there was rather than lose it.
          text(`\`\`\`json\n${buf}${buf.endsWith("\n") ? "" : "\n"}\`\`\`\n`);
          buf = "";
          mode = "text";
          break;
        }
        const body = buf.slice(0, end);
        buf = buf.slice(end + 3);
        eatNewline = true;
        mode = "text";
        const kit = parseKit(body);
        if (kit) out.push({ kind: "blocks", ...kit });
        else text(`\`\`\`json\n${body}${body.endsWith("\n") ? "" : "\n"}\`\`\`\n`);
        continue;
      }

      const i = buf.indexOf("```");
      if (i === -1) {
        // A trailing backtick or two could be the start of a fence, so hold it.
        let keep = 0;
        if (!final) while (keep < buf.length && buf[buf.length - 1 - keep] === "`") keep += 1;
        text(buf.slice(0, buf.length - keep));
        buf = buf.slice(buf.length - keep);
        break;
      }

      if (mode === "code") {
        text(buf.slice(0, i + 3));
        buf = buf.slice(i + 3);
        mode = "text";
        continue;
      }

      // An opening fence: its tag decides, so the rest of the line has to be here.
      const nl = buf.indexOf("\n", i + 3);
      if (nl === -1 && !final) {
        text(buf.slice(0, i));
        buf = buf.slice(i);
        break;
      }
      const lineEnd = nl === -1 ? buf.length : nl + 1;
      const rest = buf.slice(i + 3, lineEnd);
      if (KIT_TAGS.has(rest.trim().toLowerCase())) {
        text(buf.slice(0, i));
        buf = buf.slice(lineEnd);
        mode = "kit";
        continue;
      }
      text(buf.slice(0, lineEnd));
      buf = buf.slice(lineEnd);
      // "```x```" on one line opens and closes, so it leaves us in prose.
      if (!rest.includes("```")) mode = "code";
    }
    return out;
  };

  return {
    push: (delta: string) => {
      buf += delta;
      return run(false);
    },
    flush: () => run(true),
  };
};

/** Split a whole reply into text and block segments. */
export const splitBlockKit = (text: string): Segment[] => {
  const x = createBlockKitExtractor();
  const segs = [...x.push(text), ...x.flush()];
  const merged: Segment[] = [];
  for (const s of segs) {
    const last = merged[merged.length - 1];
    if (s.kind === "text" && last?.kind === "text") last.text += s.text;
    else merged.push(s.kind === "text" ? { ...s } : s);
  }
  return merged;
};

/**
 * A plain (non-streamed) post of a reply that may hold Block Kit: prose goes in
 * `markdown` blocks around the fences, and `text` keeps the prose - plus each
 * fence's own `text`, in place - as the notification and screen-reader
 * fallback. `plain` is set when every fence carried its own text: the whole
 * reply as mrkdwn, for when Slack refuses the blocks. Undefined when there are
 * no blocks, so the ordinary text post stays exactly as it was.
 */
export const toBlockMessage = (
  text: string,
  fallback: (prose: string) => string = (p) => p,
): { text: string; blocks: Block[]; plain?: string } | undefined => {
  const segs = splitBlockKit(text);
  if (!segs.some((s) => s.kind === "blocks")) return undefined;
  const covered = segs.every((s) => s.kind === "text" || !!s.fallback);
  const blocks: Block[] = [];
  const prose: string[] = [];
  for (const s of segs) {
    if (s.kind === "blocks") {
      blocks.push(...s.blocks);
      if (s.fallback) prose.push(s.fallback.trim());
      continue;
    }
    const t = s.text.trim();
    if (!t) continue;
    prose.push(t);
    blocks.push({ type: "markdown", text: t });
  }
  const plainText = fallback(prose.join("\n\n")) || " ";
  // Every fence brought its own words, so a post whose blocks Slack refuses
  // can go out as those words rather than as the raw JSON.
  return { text: plainText, blocks: blocks.slice(0, MAX_BLOCKS), ...(covered ? { plain: plainText } : {}) };
};

/**
 * A reply as words for a reader that sees text, not blocks (the brain reading
 * a command's result): a code-made Block Kit reply becomes its own text,
 * anything else is returned unchanged.
 */
export const readableText = (text: string): string => toBlockMessage(text)?.plain ?? text;

/** The prompt half: what the model may use, and when not to. */
export const BLOCK_KIT_RULES = `Block Kit (rich layouts, use sparingly):
- when the content is genuinely structured - a table of numbers, a warning that must stand out, options to browse, a step plan - you may render it as real Slack blocks: a fenced code block tagged blockkit, holding a JSON array of blocks
- the prose stays outside the fence as normal text. The fence is rendered in place, mid-reply, and it streams like the rest
- blocks that work in a message: "table" ({"type":"table","rows":[[{"type":"raw_text","text":"..."}, ...], ...]}, first row is the header, max 100 rows x 20 cells), "carousel" of up to 10 "card" ({"type":"card","title":{"type":"mrkdwn","text":"..."},"subtitle":{...},"body":{...},"actions":[buttons with a url]}, title/subtitle max 150 chars, body 200), "plan" ({"type":"plan","title":"...","tasks":[{"type":"task_card","task_id":"a","title":"...","status":"pending|in_progress|complete|error"}]}), "markdown", "section", "context", "divider", "header", "image"
- never "alert": Slack refuses it in messages
- max 50 blocks, valid JSON only, no comments. A fence that does not parse is shown as code instead
- a normal chat answer is still plain text. Blocks are for when a table or card is clearly the better answer, never for decoration`;
