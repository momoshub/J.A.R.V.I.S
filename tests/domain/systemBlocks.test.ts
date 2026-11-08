import { describe, expect, test } from "bun:test";
import { MAX_BLOCKS, type Block } from "../../src/domain/blockKit.ts";
import { summarizeOrca, type OrcaSnapshot } from "../../src/domain/orcaStatus.ts";
import { describeSystem, type SystemReading, trendOf } from "../../src/domain/systemStatus.ts";
import { LIVE_TABLE_ROWS, systemReport } from "../../src/domain/systemBlocks.ts";

const GB = 1024 ** 3;
const NOW = 1_700_000_000_000;
const reading = (over: Partial<SystemReading> = {}): SystemReading => ({
  at: NOW,
  cores: 10,
  load1: 2,
  load5: 2,
  load15: 2,
  memTotal: 32 * GB,
  memAvailable: 24 * GB,
  memSource: "pressure",
  swapUsed: 400 * 1024 ** 2,
  diskFree: 300 * GB,
  diskTotal: 480 * GB,
  hostUptimeS: 90_000,
  procRss: 180 * 1024 ** 2,
  procUptimeS: 3_600,
  socket: "connected",
  activeRuns: 0,
  ...over,
});

const runtime = { reachable: true, state: "ready", appRunning: true, appPid: 56481, version: "1.4.253" };
const orcaWith = (live: number): Extract<OrcaSnapshot, { kind: "ok" }> => ({
  kind: "ok",
  runtime,
  runs: [{ id: "run_a", objective: "sys command" }],
  tasks: [
    ...Array.from({ length: live }, (_, i) => ({
      id: `t${i}`,
      runId: "run_a",
      title: `worker ${i}`,
      status: i === 0 ? "blocked" : "dispatched",
      createdAt: NOW - (i + 1) * 60_000,
    })),
    { id: "done", runId: "run_a", title: "done", status: "completed" },
  ],
  unreadRuns: 0,
  moreRuns: false,
});

const types = (blocks: readonly Block[]) => blocks.map((b) => b.type);
const fieldTexts = (b: Block | undefined) => ((b?.fields as { text: string }[] | undefined) ?? []).map((f) => f.text);
const ALLOWED = new Set(["header", "section", "context", "divider", "table", "markdown"]);

describe("systemReport", () => {
  test("host only: header verdict, a grid of fields, nothing about Orca", () => {
    const { blocks, text } = systemReport(reading(), { botName: "Jarvis" });
    expect(types(blocks)).toEqual(["header", "section"]);
    expect(blocks[0]).toEqual({
      type: "header",
      text: { type: "plain_text", text: ":large_green_circle: Nothing abnormal", emoji: true },
    });
    const grid = fieldTexts(blocks[1]);
    expect(grid.map((f) => f.split("\n")[0])).toEqual(["*CPU*", "*Memory*", "*Swap*", "*Disk*", "*Host*", "*Jarvis*", "*Turns*"]);
    // The fallback is exactly today's report.
    expect(text).toBe(describeSystem(reading(), { botName: "Jarvis" }));
  });

  test("a problem leads with its reasons, and the trend is a context line", () => {
    const busy = reading({ load1: 25 });
    const trend = trendOf([reading({ at: NOW - 600_000, load1: 5 }), busy]);
    const { blocks } = systemReport(busy, { trend });
    expect(types(blocks)).toEqual(["header", "section", "section", "context"]);
    expect((blocks[0]!.text as { text: string }).text).toContain(":red_circle:");
    expect((blocks[1]!.text as { text: string }).text).toContain("• load is 2.50 per core");
    expect(JSON.stringify(blocks[3])).toContain("over the last 10m");
  });

  test("Orca reachable: divider, runtime, count fields and a live-worker table", () => {
    const orca = summarizeOrca(orcaWith(3), NOW);
    const { blocks, text } = systemReport(reading(), { botName: "Jarvis", orca });
    expect(types(blocks)).toEqual(["header", "section", "divider", "section", "section", "table"]);
    expect((blocks[3]!.text as { text: string }).text).toBe(":large_green_circle: *Orca* ready, app pid 56481, v1.4.253");
    expect(fieldTexts(blocks[4])).toEqual([
      "*Active runs*\n1",
      "*Running*\n2",
      "*Waiting for input*\n1",
      "*Queued*\n0",
      "*Completed*\n1",
      "*Failed*\n0",
    ]);
    const rows = blocks[5]!.rows as { type: string; text: string }[][];
    expect(rows[0]!.map((c) => c.text)).toEqual(["Task", "Run", "Status", "Age"]);
    expect(rows[1]!.map((c) => c.text)).toEqual(["worker 2", "sys command", "running", "3m"]);
    expect(rows.flat().every((c) => c.type === "raw_text" && c.text.length > 0)).toBe(true);
    // The fallback still reads like today's output, with the Orca lines after it.
    expect(text.startsWith(describeSystem(reading(), { botName: "Jarvis" }))).toBe(true);
    expect(text).toContain("*orca* ready, app pid 56481, v1.4.253 - 1 active run: 2 running, 1 waiting for input, 1 completed");
  });

  test("Orca empty: no table, a 'no live workers' note", () => {
    const empty = summarizeOrca({ kind: "ok", runtime, runs: [], tasks: [], unreadRuns: 0, moreRuns: false }, NOW);
    const { blocks } = systemReport(reading(), { orca: empty });
    expect(types(blocks).slice(2)).toEqual(["divider", "section", "section", "context"]);
    expect(JSON.stringify(blocks.at(-1))).toContain("no live workers");
  });

  test("Orca unreachable is one line, and the rest of the report stands", () => {
    const { blocks, text } = systemReport(reading(), { orca: { kind: "unreachable", reason: "timed out" } });
    expect(types(blocks)).toEqual(["header", "section", "divider", "section"]);
    expect((blocks[3]!.text as { text: string }).text).toBe(":black_circle: *Orca* unreachable _(timed out)_");
    expect(text.endsWith("*orca* unreachable (timed out)")).toBe(true);
  });

  test("many workers: the table is capped and the rest are counted", () => {
    const { blocks } = systemReport(reading(), { orca: summarizeOrca(orcaWith(40), NOW) });
    const table = blocks.find((b) => b.type === "table")!;
    expect((table.rows as unknown[]).length).toBe(LIVE_TABLE_ROWS + 1);
    expect(JSON.stringify(blocks.at(-1))).toContain(`+${40 - LIVE_TABLE_ROWS} more live workers`);
  });

  test("only blocks Slack takes in a message, within its limits", () => {
    const busy = reading({ load1: 25, memAvailable: 1 * GB, swapUsed: 9 * GB, diskFree: 1 * GB, socket: "reconnecting" });
    const trend = trendOf([reading({ at: NOW - 60_000 }), busy]);
    const { blocks } = systemReport(busy, { trend, orca: summarizeOrca({ ...orcaWith(40), unreadRuns: 3, moreRuns: true }, NOW) });
    expect(blocks.length).toBeLessThanOrEqual(MAX_BLOCKS);
    expect(blocks.every((b) => ALLOWED.has(b.type))).toBe(true);
    expect(types(blocks)).not.toContain("alert");
    expect(types(blocks).filter((t) => t === "table")).toHaveLength(1);
    for (const b of blocks) {
      if (b.type === "header") expect((b.text as { text: string }).text.length).toBeLessThanOrEqual(150);
      if (b.fields) expect((b.fields as unknown[]).length).toBeLessThanOrEqual(10);
      if (b.type === "context") expect((b.elements as unknown[]).length).toBeLessThanOrEqual(10);
    }
  });
});
