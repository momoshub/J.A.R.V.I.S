/**
 * `sys` as Block Kit: the verdict as a header, the numbers as a grid of
 * fields, the trend as a quiet context line, then Orca - its counts as fields
 * and the live workers as a table.
 *
 * The same report also goes out as mrkdwn `text` (today's plain report plus
 * the Orca lines): the notification and screen-reader fallback, a refused
 * post's stand-in, and - through `readableText` - what the brain reads back
 * when it runs the command. Only blocks Slack takes in a
 * message: header, section, context, divider, table. Never `alert`.
 */
import { type Block, MAX_BLOCKS } from "./blockKit.ts";
import {
  describeOrca,
  orcaCaveat,
  orcaRuntimeLine,
  type OrcaSummary,
} from "./orcaStatus.ts";
import {
  describeSystem,
  duration,
  human,
  pct,
  type SystemReading,
  type Trend,
  type VerdictLevel,
  verdictOf,
} from "./systemStatus.ts";

/** Live workers shown as table rows before "+N more". */
export const LIVE_TABLE_ROWS = 10;

const HEADER: Record<VerdictLevel, string> = {
  ok: ":large_green_circle: Nothing abnormal",
  watch: ":large_yellow_circle: Worth a look",
  problem: ":red_circle: Something is wrong",
};

const mrkdwn = (text: string) => ({ type: "mrkdwn", text });
const section = (text: string): Block => ({ type: "section", text: mrkdwn(text) });
const fields = (items: readonly string[]): Block => ({ type: "section", fields: items.slice(0, 10).map(mrkdwn) });
const context = (text: string): Block => ({ type: "context", elements: [mrkdwn(text)] });
const cell = (text: string) => ({ type: "raw_text", text: text || "-" });
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export type SystemReportOptions = {
  readonly botName?: string;
  readonly trend?: Trend;
  /** Absent when no Orca probe is wired: the section is left out, not shown as down. */
  readonly orca?: OrcaSummary;
};

const hostBlocks = (r: SystemReading, opts: SystemReportOptions): Block[] => {
  const v = verdictOf(r);
  const memPct = pct(r.memAvailable, r.memTotal);
  const blocks: Block[] = [{ type: "header", text: { type: "plain_text", text: HEADER[v.level], emoji: true } }];
  if (v.reasons.length > 0) blocks.push(section(v.reasons.map((x) => `• ${x}`).join("\n")));

  const grid = [
    `*CPU*\nload ${r.load1.toFixed(2)} / ${r.load5.toFixed(2)} / ${r.load15.toFixed(2)}\n${(r.load1 / Math.max(1, r.cores)).toFixed(2)} per core · ${r.cores} cores`,
    `*Memory*\n${human(r.memAvailable)} of ${human(r.memTotal)} available (${memPct.toFixed(0)}%)${
      r.memSource === "free" ? "\n_free-page count, reads low on a healthy machine_" : ""
    }`,
  ];
  if (r.swapUsed !== undefined) grid.push(`*Swap*\n${human(r.swapUsed)} in use`);
  if (r.diskFree !== undefined && r.diskTotal !== undefined) {
    grid.push(`*Disk*\n${human(r.diskFree)} free of ${human(r.diskTotal)} (${pct(r.diskFree, r.diskTotal).toFixed(0)}%)`);
  }
  grid.push(`*Host*\nup ${duration(r.hostUptimeS)}`);
  grid.push(
    `*${opts.botName ?? "Me"}*\n${human(r.procRss)} resident · up ${duration(r.procUptimeS)}${r.socket ? `\nsocket ${r.socket}` : ""}`,
  );
  if (r.activeRuns !== undefined) {
    grid.push(`*Turns*\n${r.activeRuns} running${r.queuedRuns ? `, ${r.queuedRuns} queued` : ""}`);
  }
  blocks.push(fields(grid));

  const t = opts.trend;
  if (t && t.samples >= 2) {
    blocks.push(
      context(
        `${t.rising ? ":chart_with_upwards_trend:" : ":bar_chart:"} over the last ${duration(t.spanS)}: load peaked at ${t.peakLoadPerCore.toFixed(2)} per core, memory bottomed at ${t.lowestMemPct.toFixed(0)}%${t.rising ? ", and it is climbing" : ""}`,
      ),
    );
  }
  return blocks;
};

const orcaBlocks = (s: OrcaSummary): Block[] => {
  if (s.kind === "unreachable") return [section(`:black_circle: *Orca* unreachable _(${s.reason})_`)];
  const up = s.runtime.reachable && s.runtime.state === "ready";
  const blocks: Block[] = [
    section(`${up ? ":large_green_circle:" : ":large_yellow_circle:"} *Orca* ${orcaRuntimeLine(s.runtime)}`),
    fields([
      `*Active runs*\n${s.activeRuns}`,
      `*Running*\n${s.counts.running}`,
      `*Waiting for input*\n${s.counts.waiting}`,
      `*Queued*\n${s.counts.queued}`,
      `*Completed*\n${s.counts.completed}`,
      `*Failed*\n${s.counts.failed}`,
    ]),
  ];
  if (s.live.length > 0) {
    blocks.push({
      type: "table",
      rows: [
        ["Task", "Run", "Status", "Age"].map(cell),
        ...s.live
          .slice(0, LIVE_TABLE_ROWS)
          .map((w) => [
            cell(clip(w.title, 60)),
            cell(clip(w.run, 40)),
            cell(w.status === "waiting" ? "waiting for input" : "running"),
            cell(w.ageS !== undefined ? duration(w.ageS) : "-"),
          ]),
      ],
    });
  }
  const notes = [
    s.live.length === 0 ? "no live workers" : undefined,
    s.live.length > LIVE_TABLE_ROWS ? `+${s.live.length - LIVE_TABLE_ROWS} more live workers` : undefined,
    orcaCaveat(s),
  ].filter(Boolean);
  if (notes.length) blocks.push(context(notes.join(" · ")));
  return blocks;
};

/** The whole `sys` report: Block Kit plus the mrkdwn fallback. */
export const systemReport = (
  r: SystemReading,
  opts: SystemReportOptions = {},
): { text: string; blocks: Block[] } => {
  const plain = describeSystem(r, { botName: opts.botName, trend: opts.trend });
  const text = opts.orca ? `${plain}\n\n${describeOrca(opts.orca).join("\n")}` : plain;
  const blocks = [...hostBlocks(r, opts), ...(opts.orca ? [{ type: "divider" }, ...orcaBlocks(opts.orca)] : [])];
  return { text, blocks: blocks.slice(0, MAX_BLOCKS) };
};
