/**
 * CloudWatch Logs through the host's `aws` CLI (`CloudwatchPort`).
 *
 * The bot calls it itself, outside any model turn: a turn's own `aws logs` is
 * denied (`ALWAYS_DISALLOW`), and this is the one guarded path. Arguments are
 * an argv array, never a shell line, so a query containing quotes, `$(...)` or
 * `;` is just a string. Credentials are whatever the host's `aws` already uses.
 */
import type { CloudwatchPort } from "../../application/cloudwatch.ts";
import type { GroupInfo, QueryResult } from "../../domain/cloudwatch.ts";
import { logAndIgnore } from "../../application/ignoredError.ts";

export type AwsRun = (args: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

/** How long a query may run before it is stopped, and how often it is polled. */
export const QUERY_TIMEOUT_MS = 3 * 60_000;
export const POLL_MS = 2_000;

/** Run `aws` with an argv array and collect its output. */
export const runAws: AwsRun = async (args) => {
  const proc = Bun.spawn(["aws", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
};

const record = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

const parseJson = (text: string, what: string): Record<string, unknown> => {
  try {
    return record(JSON.parse(text));
  } catch {
    throw new Error(`aws ${what} returned something that is not JSON`);
  }
};

const failure = (what: string, stderr: string): Error =>
  new Error(`aws ${what} failed: ${stderr.trim().split("\n").slice(-1)[0]?.slice(0, 300) || "no message"}`);

export type CloudwatchCliDeps = {
  run?: AwsRun;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  pollMs?: number;
};

export const createCloudwatchCli = (deps: CloudwatchCliDeps = {}): CloudwatchPort => {
  const run = deps.run ?? runAws;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? QUERY_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? POLL_MS;

  const call = async (region: string, args: readonly string[], what: string): Promise<Record<string, unknown>> => {
    const res = await run(["--region", region, ...args, "--output", "json"]);
    if (res.code !== 0) throw failure(what, res.stderr);
    return parseJson(res.stdout, what);
  };

  return {
    describeGroups: async (names, region) => {
      const found: GroupInfo[] = [];
      for (const name of names) {
        const out = await call(region, ["logs", "describe-log-groups", "--log-group-name-prefix", name], "describe-log-groups");
        const groups = Array.isArray(out.logGroups) ? out.logGroups : [];
        const hit = groups.map(record).find((g) => g.logGroupName === name);
        if (hit) {
          found.push({
            name,
            storedBytes: num(hit.storedBytes),
            ...(num(hit.retentionInDays) > 0 ? { retentionDays: num(hit.retentionInDays) } : {}),
            ...(num(hit.creationTime) > 0 ? { createdAt: num(hit.creationTime) } : {}),
          });
        }
      }
      return found;
    },

    runQuery: async (req, signal): Promise<QueryResult> => {
      const started = await call(
        req.region,
        [
          "logs", "start-query",
          "--log-group-names", ...req.groups,
          "--start-time", String(Math.floor(req.startMs / 1000)),
          "--end-time", String(Math.ceil(req.endMs / 1000)),
          "--query-string", req.query,
          "--limit", String(req.limit),
        ],
        "start-query",
      );
      const queryId = typeof started.queryId === "string" ? started.queryId : "";
      if (!queryId) throw new Error("aws start-query gave no query id");

      const deadline = now() + timeoutMs;
      for (;;) {
        const out = await call(req.region, ["logs", "get-query-results", "--query-id", queryId], "get-query-results");
        const status = typeof out.status === "string" ? out.status : "Unknown";
        if (status !== "Running" && status !== "Scheduled") {
          const stats = record(out.statistics);
          const rows = (Array.isArray(out.results) ? out.results : []).map((row) =>
            (Array.isArray(row) ? row : [])
              .map(record)
              .filter((c) => c.field !== "@ptr")
              .map((c) => ({ field: String(c.field ?? ""), value: String(c.value ?? "") })),
          );
          return {
            status,
            rows,
            bytesScanned: num(stats.bytesScanned),
            recordsMatched: num(stats.recordsMatched),
            recordsScanned: num(stats.recordsScanned),
          };
        }
        if (signal?.aborted || now() >= deadline) {
          // Stop the scan: it is billed for as long as it runs.
          await run(["--region", req.region, "logs", "stop-query", "--query-id", queryId, "--output", "json"]).catch(logAndIgnore("stop cloudwatch query"));
          throw new Error(signal?.aborted ? "the query was stopped" : `the query ran past ${Math.round(timeoutMs / 1000)}s and was stopped`);
        }
        await sleep(pollMs);
      }
    },
  };
};
