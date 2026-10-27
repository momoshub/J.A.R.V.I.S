/**
 * How the host is doing, and whether any of it is abnormal.
 *
 * The verdict is the point. "What is the RAM and CPU" is almost never the real
 * question - the real question is "is something wrong", and a wall of numbers
 * leaves the asker to work that out themselves. So a reading is classified, and
 * the classification leads.
 *
 * The one genuinely non-obvious thing here is what "free memory" means. On
 * macOS `vm_stat`'s free-pages figure (and `os.freemem()`, which is the same
 * number) reads catastrophically low on a perfectly healthy machine, because
 * the OS keeps pages cached rather than idle - 2GB "free" of 32GB while
 * `memory_pressure` reports 76% genuinely available. Reporting the first number
 * means crying wolf every single time. Linux has the same trap and the same fix
 * (`MemAvailable` in /proc/meminfo, not `MemFree`). The probe is responsible
 * for getting the honest figure; `memSource` records which one it managed, so a
 * reading taken the unreliable way can say so instead of quietly lying.
 */

/** Where the available-memory figure came from, best first. */
export type MemorySource =
  /** macOS `memory_pressure`: the real number. */
  | "pressure"
  /** Linux `MemAvailable`: also the real number. */
  | "available"
  /** The kernel's free-pages count. Misleading on both, so it is flagged. */
  | "free";

/** One sample of the host and the process running on it. */
export type SystemReading = {
  readonly at: number;
  readonly cores: number;
  readonly load1: number;
  readonly load5: number;
  readonly load15: number;
  readonly memTotal: number;
  /** Memory genuinely available, NOT the kernel's free-page count. */
  readonly memAvailable: number;
  readonly memSource: MemorySource;
  readonly swapUsed?: number;
  readonly diskFree?: number;
  readonly diskTotal?: number;
  readonly hostUptimeS: number;
  /** Resident set of the bot process. */
  readonly procRss: number;
  readonly procUptimeS: number;
  /** Socket state, when the caller knows it. */
  readonly socket?: string;
  readonly activeRuns?: number;
  readonly queuedRuns?: number;
};

export type VerdictLevel = "ok" | "watch" | "problem";

export type Verdict = {
  readonly level: VerdictLevel;
  readonly reasons: readonly string[];
};

/**
 * Thresholds. Load is per core, because "load 8" means nothing without knowing
 * how many cores are under it.
 */
export const LOAD_WATCH = 1.0;
export const LOAD_PROBLEM = 2.0;
export const MEM_WATCH_PCT = 20;
export const MEM_PROBLEM_PCT = 10;
/** Some swap is normal on macOS; this much means real pressure. */
export const SWAP_WATCH = 2 * 1024 ** 3;
export const SWAP_PROBLEM = 8 * 1024 ** 3;
export const DISK_WATCH_PCT = 10;
export const DISK_PROBLEM_PCT = 5;

const worst = (a: VerdictLevel, b: VerdictLevel): VerdictLevel =>
  a === "problem" || b === "problem" ? "problem" : a === "watch" || b === "watch" ? "watch" : "ok";

export const pct = (part: number, whole: number): number => (whole > 0 ? (part / whole) * 100 : 0);

/** Bytes as a short human string: 1.4GB, 820MB. */
export const human = (bytes: number): string => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = Math.abs(bytes);
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)}${units[i]}`;
};

/** Seconds as a short duration: 3d 4h, 2h 15m, 40s. */
export const duration = (seconds: number): string => {
  const s = Math.max(0, Math.round(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
};

/** Is anything here abnormal, and what. */
export const verdictOf = (r: SystemReading): Verdict => {
  let level: VerdictLevel = "ok";
  const reasons: string[] = [];

  const perCore = r.cores > 0 ? r.load1 / r.cores : r.load1;
  if (perCore >= LOAD_PROBLEM) {
    level = worst(level, "problem");
    reasons.push(`load is ${perCore.toFixed(2)} per core - the machine is saturated`);
  } else if (perCore >= LOAD_WATCH) {
    level = worst(level, "watch");
    reasons.push(`load is ${perCore.toFixed(2)} per core - busy, not yet stuck`);
  }

  const freePct = pct(r.memAvailable, r.memTotal);
  if (freePct < MEM_PROBLEM_PCT) {
    level = worst(level, "problem");
    reasons.push(`only ${freePct.toFixed(0)}% of memory is available`);
  } else if (freePct < MEM_WATCH_PCT) {
    level = worst(level, "watch");
    reasons.push(`${freePct.toFixed(0)}% of memory available`);
  }

  if (r.swapUsed !== undefined) {
    if (r.swapUsed >= SWAP_PROBLEM) {
      level = worst(level, "problem");
      reasons.push(`${human(r.swapUsed)} of swap in use - the machine is paging hard`);
    } else if (r.swapUsed >= SWAP_WATCH) {
      level = worst(level, "watch");
      reasons.push(`${human(r.swapUsed)} of swap in use`);
    }
  }

  if (r.diskFree !== undefined && r.diskTotal !== undefined && r.diskTotal > 0) {
    const diskPct = pct(r.diskFree, r.diskTotal);
    if (diskPct < DISK_PROBLEM_PCT) {
      level = worst(level, "problem");
      reasons.push(`${human(r.diskFree)} of disk left (${diskPct.toFixed(0)}%)`);
    } else if (diskPct < DISK_WATCH_PCT) {
      level = worst(level, "watch");
      reasons.push(`${human(r.diskFree)} of disk left`);
    }
  }

  // A socket that is not listening is the failure that looks like silence:
  // process up, launchd happy, nothing arriving.
  if (r.socket && !/connected|listening/i.test(r.socket)) {
    level = worst(level, "problem");
    reasons.push(`the Slack socket is ${r.socket}`);
  }

  return { level, reasons };
};

/** What a window of samples did, for the part a single snapshot cannot show. */
export type Trend = {
  readonly samples: number;
  readonly spanS: number;
  readonly peakLoadPerCore: number;
  readonly lowestMemPct: number;
  /** Load is meaningfully higher than it was at the start of the window. */
  readonly rising: boolean;
};

export const trendOf = (history: readonly SystemReading[]): Trend | undefined => {
  if (history.length < 2) return undefined;
  const first = history[0]!;
  const last = history[history.length - 1]!;
  let peakLoadPerCore = 0;
  let lowestMemPct = 100;
  for (const r of history) {
    peakLoadPerCore = Math.max(peakLoadPerCore, r.cores > 0 ? r.load1 / r.cores : r.load1);
    lowestMemPct = Math.min(lowestMemPct, pct(r.memAvailable, r.memTotal));
  }
  const startPerCore = first.cores > 0 ? first.load1 / first.cores : first.load1;
  const endPerCore = last.cores > 0 ? last.load1 / last.cores : last.load1;
  return {
    samples: history.length,
    spanS: Math.max(0, (last.at - first.at) / 1000),
    peakLoadPerCore,
    lowestMemPct,
    // A quarter up on where it started, and actually busy - otherwise "rising"
    // fires on noise between two idle samples.
    rising: endPerCore > startPerCore * 1.25 && endPerCore >= LOAD_WATCH / 2,
  };
};

const HEAD: Record<VerdictLevel, string> = {
  ok: ":large_green_circle: nothing abnormal",
  watch: ":large_yellow_circle: worth a look",
  problem: ":red_circle: something is wrong",
};

/** The whole report, as Slack mrkdwn. Verdict first, numbers after. */
export const describeSystem = (
  r: SystemReading,
  opts: { botName?: string; trend?: Trend } = {},
): string => {
  const v = verdictOf(r);
  const memPct = pct(r.memAvailable, r.memTotal);
  const lines: string[] = [HEAD[v.level]];

  if (v.reasons.length > 0) lines.push(...v.reasons.map((x) => `- ${x}`));

  lines.push(
    "",
    `*cpu* load ${r.load1.toFixed(2)} / ${r.load5.toFixed(2)} / ${r.load15.toFixed(2)} over ${r.cores} cores (${(r.load1 / Math.max(1, r.cores)).toFixed(2)} per core)`,
    `*memory* ${human(r.memAvailable)} of ${human(r.memTotal)} available (${memPct.toFixed(0)}%)${
      // Say when the number is the unreliable one rather than presenting it as
      // though it were the real figure.
      r.memSource === "free" ? " - free-page count, which reads low on a healthy machine" : ""
    }`,
  );

  if (r.swapUsed !== undefined) lines.push(`*swap* ${human(r.swapUsed)} in use`);
  if (r.diskFree !== undefined && r.diskTotal !== undefined) {
    lines.push(`*disk* ${human(r.diskFree)} free of ${human(r.diskTotal)} (${pct(r.diskFree, r.diskTotal).toFixed(0)}%)`);
  }
  lines.push(`*host* up ${duration(r.hostUptimeS)}`);
  lines.push(
    `*${opts.botName ?? "me"}* ${human(r.procRss)} resident, up ${duration(r.procUptimeS)}${
      r.socket ? `, socket ${r.socket}` : ""
    }`,
  );
  if (r.activeRuns !== undefined) {
    lines.push(`*turns* ${r.activeRuns} running${r.queuedRuns ? `, ${r.queuedRuns} queued` : ""}`);
  }

  if (opts.trend && opts.trend.samples >= 2) {
    const t = opts.trend;
    lines.push(
      "",
      `_over the last ${duration(t.spanS)}: load peaked at ${t.peakLoadPerCore.toFixed(2)} per core, memory bottomed at ${t.lowestMemPct.toFixed(0)}%${t.rising ? ", and it is climbing" : ""}_`,
    );
  }

  return lines.join("\n");
};
