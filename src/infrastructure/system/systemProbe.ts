/**
 * Collect a system reading, and keep a short history of them.
 *
 * Everything here is best-effort: a probe that cannot answer leaves the field
 * undefined rather than guessing or throwing. A status command that falls over
 * because `df` was slow is worse than one that says it could not read the disk.
 *
 * The memory figure is the part that matters. `os.freemem()` is the kernel's
 * free-page count, which on macOS reads around 2GB of 32 on a machine that is
 * completely healthy, because pages that are cached are not "free". Reporting
 * that number means every reading looks like an emergency. `memory_pressure`
 * gives the figure a human would call available (80% where freemem says 6%),
 * and Linux has the same trap with the same fix in `MemAvailable`. The free-page
 * count is only ever the last resort, and the reading says when it was used.
 */
import { freemem, loadavg, cpus, totalmem, uptime } from "node:os";
import { platform } from "node:process";
import type { MemorySource, SystemReading } from "../../domain/systemStatus.ts";

const PROBE_TIMEOUT_MS = 4_000;

export type SystemProbe = {
  readonly read: () => Promise<SystemReading>;
};

export type SystemTracker = SystemProbe & {
  /** Samples oldest-first, for the trend a single snapshot cannot show. */
  readonly history: () => readonly SystemReading[];
  readonly stop: () => void;
};

/** Run a command, returning its stdout or undefined. Never throws. */
const sh = async (cmd: readonly string[]): Promise<string | undefined> => {
  try {
    const proc = Bun.spawn({ cmd: [...cmd], stdout: "pipe", stderr: "ignore", timeout: PROBE_TIMEOUT_MS });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 ? out : undefined;
  } catch {
    return undefined;
  }
};

/** macOS: the percentage a human would call free. */
const macAvailable = async (total: number): Promise<number | undefined> => {
  const out = await sh(["memory_pressure"]);
  const m = out?.match(/free percentage:\s*(\d+)%/i);
  return m?.[1] ? (total * Number(m[1])) / 100 : undefined;
};

/** Linux: MemAvailable, which already accounts for reclaimable cache. */
const linuxAvailable = async (): Promise<number | undefined> => {
  try {
    const text = await Bun.file("/proc/meminfo").text();
    const m = text.match(/^MemAvailable:\s+(\d+) kB/m);
    return m?.[1] ? Number(m[1]) * 1024 : undefined;
  } catch {
    return undefined;
  }
};

const macSwap = async (): Promise<number | undefined> => {
  const out = await sh(["sysctl", "-n", "vm.swapusage"]);
  const m = out?.match(/used\s*=\s*([\d.]+)([KMG])/i);
  if (!m?.[1]) return undefined;
  const scale = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[(m[2] ?? "M").toLowerCase()] ?? 1024 ** 2;
  return Number(m[1]) * scale;
};

const linuxSwap = async (): Promise<number | undefined> => {
  try {
    const text = await Bun.file("/proc/meminfo").text();
    const total = text.match(/^SwapTotal:\s+(\d+) kB/m)?.[1];
    const free = text.match(/^SwapFree:\s+(\d+) kB/m)?.[1];
    return total && free ? (Number(total) - Number(free)) * 1024 : undefined;
  } catch {
    return undefined;
  }
};

/** `df -k <path>`: 1K blocks, used, available. */
const disk = async (path: string): Promise<{ free: number; total: number } | undefined> => {
  const out = await sh(["df", "-k", path]);
  const line = out?.trim().split("\n").at(-1);
  const cols = line?.trim().split(/\s+/) ?? [];
  // Some filesystems print the device on its own line; find the first three
  // numbers rather than trusting a fixed column.
  const nums = cols.filter((c) => /^\d+$/.test(c)).map(Number);
  const [total, , available] = nums;
  return total && available !== undefined ? { free: available * 1024, total: total * 1024 } : undefined;
};

export type SystemProbeOptions = {
  /** Filesystem the disk figure is read for; the data directory matters most. */
  readonly dataDir?: string;
  /** Live runtime facts the host cannot know. */
  readonly socket?: () => string | undefined;
  readonly runs?: () => { active: number; queued?: number } | undefined;
  readonly now?: () => number;
};

export const createSystemProbe = (opts: SystemProbeOptions = {}): SystemProbe => ({
  read: async () => {
    const total = totalmem();
    const [avg1 = 0, avg5 = 0, avg15 = 0] = loadavg();

    let memAvailable: number | undefined;
    let memSource: MemorySource = "free";
    if (platform === "darwin") {
      memAvailable = await macAvailable(total);
      if (memAvailable !== undefined) memSource = "pressure";
    } else if (platform === "linux") {
      memAvailable = await linuxAvailable();
      if (memAvailable !== undefined) memSource = "available";
    }
    if (memAvailable === undefined) memAvailable = freemem();

    const swapUsed = platform === "darwin" ? await macSwap() : platform === "linux" ? await linuxSwap() : undefined;
    const space = opts.dataDir ? await disk(opts.dataDir) : undefined;
    const runs = opts.runs?.();

    return {
      at: (opts.now ?? Date.now)(),
      cores: cpus().length,
      load1: avg1,
      load5: avg5,
      load15: avg15,
      memTotal: total,
      memAvailable,
      memSource,
      swapUsed,
      diskFree: space?.free,
      diskTotal: space?.total,
      hostUptimeS: uptime(),
      procRss: process.memoryUsage().rss,
      procUptimeS: process.uptime(),
      socket: opts.socket?.(),
      activeRuns: runs?.active,
      queuedRuns: runs?.queued,
    };
  },
});

/**
 * Sample on a timer and keep the last `keep` readings.
 *
 * In memory on purpose. The question this answers - "has it been like this for
 * a while, or did it just start" - is about the last hour, not the last month,
 * and a table of samples would be a schema, a migration and a cleanup job for
 * something a ring buffer does in six lines. It resets on restart, which is
 * honest: a restart is exactly when the old numbers stop describing anything.
 */
export const createSystemTracker = (
  probe: SystemProbe,
  intervalMs = 60_000,
  keep = 60,
): SystemTracker => {
  const samples: SystemReading[] = [];

  const sample = async () => {
    try {
      samples.push(await probe.read());
      while (samples.length > keep) samples.shift();
    } catch {
      // A failed sample is a gap in the history, never a crash in the bot.
    }
  };

  const timer = setInterval(() => void sample(), intervalMs);
  timer.unref?.();
  void sample();

  return {
    read: async () => {
      const reading = await probe.read();
      samples.push(reading);
      while (samples.length > keep) samples.shift();
      return reading;
    },
    history: () => samples,
    stop: () => clearInterval(timer),
  };
};
