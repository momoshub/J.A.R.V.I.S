/**
 * The how-to half of the system prompt, read on demand instead of carried.
 *
 * The prompt had grown to ~35KB of rules a turn: how to drive a desktop, how
 * Block Kit events come back, how to set a watch, what to do when a connector
 * is missing. Each matters to one kind of job, yet all of it sat between the
 * persona at the top and the reply being written, and the voice rules - 2KB of
 * it - were the first thing to slide in a long, tool-heavy thread.
 *
 * So a block that is a procedure becomes a guide: its full text is written to
 * a file, and the prompt keeps one line per guide - the rule that must hold
 * even when the guide is never opened, and where to read the rest. The same
 * shape the memory adapter's skills already use.
 *
 * Only for a turn that can read files. A sandboxed turn could never open the
 * file, so it keeps every block inline, exactly as before.
 */
import { createHash } from "node:crypto";

export type GuideSlug = "investigate" | "tickets" | "credential-gap" | "desktop" | "parallel" | "block-kit" | "waiting";

/** A guide: the block it replaces, and the line that stays always on. */
export type PromptGuide = {
  readonly slug: GuideSlug;
  /** The always-on line: the guard that holds unread, then when to read. */
  readonly summary: string;
  /** The full block, verbatim, as it would have been inlined. */
  readonly body: string;
};

/**
 * The always-on lines. Each leads with the rule that must hold even when the
 * guide is never opened - a guard that only lives in an unread file is a guard
 * that does not exist - then says when the rest is worth reading.
 */
export const GUIDE_SUMMARIES: Readonly<Record<GuideSlug, string>> = {
  // the source order is a setting, so the real line comes from `investigateSummary`
  investigate:
    "logs, metrics, traces, RUM - try the configured sources in order, NEVER cloudwatch. Read before any lookup into why something broke",
  tickets:
    "a NEW report of the product misbehaving is raised as a ticket with the `ticket` command, after searching the tracker for a duplicate. Read before raising one",
  "credential-gap":
    "a 403, \"private\", an empty page or a missing `mcp__` tool means the wrong credential for this turn, not impossible: run the host command that has it (`read`, `investigate`, `ticket`, `note`) yourself, never hunt for keys. Read when something will not open",
  desktop:
    "driving a Mac app or Brave on the real screen - only through the desktop helper, never osascript, one session at a time. Read before touching the screen",
  parallel:
    "a message with several independent asks is split and run in parallel as Orca workers, each answer posted as it lands, and every worker you start gets a `watch worker <dispatchId>` when you can set watches, and a `blocked` task is a worker that stopped without reporting, never success. Read before spawning any background agent",
  "block-kit":
    "a question with a fixed set of answers is asked with `jv:` buttons, never lettered options in text. Read before posting buttons, selects or a modal, or when a turn starts with [block kit event]",
  waiting:
    "you cannot wait - never say you will do something once X finishes, set a `watch` instead (`watch worker <dispatchId>` after every Orca worker you start); `tell` steers another thread without posting anything in Slack. Read for the watch and tell syntax",
};

/**
 * The two lines that name Orca, as an agent below owner reads them: `orca` is
 * denied there (`ORCA_DENY`), so they point at the Agent tool instead.
 */
export const AGENT_GUIDE_SUMMARIES: Readonly<Record<"parallel" | "waiting", string>> = {
  parallel:
    "a message with several independent asks is split and run in parallel as Agent tool agents (`run_in_background: true`) in your own process, each answer posted as it lands, never `orca` - it is the owner's. Read before spawning any background agent",
  waiting:
    "you cannot wait - never say you will do something once X finishes, set a `watch` instead; `tell` steers another thread without posting anything in Slack. Read for the watch and tell syntax",
};

/** Order the index lists them in. */
export const GUIDE_ORDER: readonly GuideSlug[] = [
  "investigate",
  "tickets",
  "credential-gap",
  "desktop",
  "parallel",
  "block-kit",
  "waiting",
];

/**
 * The file a guide is written to. Named by its content, so turns under
 * different roles (whose blocks differ) never overwrite each other's file, and
 * a rule change lands in a new file rather than under a live reader.
 */
export const guideFile = (guide: PromptGuide): string =>
  `${guide.slug}-${createHash("sha256").update(guide.body).digest("hex").slice(0, 10)}.md`;

/**
 * The investigate line names the sources in their configured order - it is a
 * setting (`log_sources`), so a fixed "grafana first" would contradict the
 * guide on an instance that changed it.
 */
export const investigateSummary = (order: readonly string[]): string =>
  order.length === 0
    ? GUIDE_SUMMARIES.investigate
    : `logs, metrics, traces, RUM - ${order.length > 1 ? `${order.join(", then ")}, each only when the one before has nothing` : order[0]}, NEVER cloudwatch. Read before any lookup into why something broke`;

/** A block becomes a guide only when this turn would have rendered it at all. */
export const asGuide = (slug: GuideSlug, block: string, summary?: string): PromptGuide | undefined =>
  block.trim() ? { slug, summary: summary ?? GUIDE_SUMMARIES[slug], body: block.trim() } : undefined;

/** The always-on index that replaces the inlined blocks. */
export const renderGuideIndex = (guides: readonly PromptGuide[], dir: string): string => {
  if (guides.length === 0) return "";
  const lines = guides
    .map((g) => `- *${g.slug}* - ${g.summary}\n  read: ${dir}/${guideFile(g)}`)
    .join("\n");
  return `\n\nHow-to guides (the line here always holds; open the file only when the job is actually that one, and then follow it):\n${lines}`;
};

/**
 * The index with stand-in paths, for the session fingerprint: a guided turn's
 * always-on lines are rules too, so changing one must reopen live threads.
 */
export const guideIndexForFingerprint = (logSources: readonly string[] = [], orca = true): string =>
  renderGuideIndex(
    GUIDE_ORDER.map((slug) => ({
      slug,
      summary:
        slug === "investigate"
          ? investigateSummary(logSources)
          : !orca && (slug === "parallel" || slug === "waiting")
            ? AGENT_GUIDE_SUMMARIES[slug]
            : GUIDE_SUMMARIES[slug],
      body: slug,
    })),
    "/fp/guides",
  );
