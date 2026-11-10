import { describe, expect, test } from "bun:test";
import { createCloudwatchCli, type AwsRun } from "../../src/infrastructure/aws/cloudwatchCli.ts";
import type { CloudwatchRequest } from "../../src/domain/cloudwatch.ts";

const request: CloudwatchRequest = { groups: ["/ecs/be", "/ecs/be2"], region: "us-west-2", query: "fields @message | filter @message like /$(rm -rf ~)/", startMs: 1_000_500, endMs: 2_000_100, limit: 50 };
const ok = (obj: unknown) => ({ code: 0, stdout: JSON.stringify(obj), stderr: "" });

const rig = (handler: (args: readonly string[]) => { code: number; stdout: string; stderr: string }) => {
  const calls: string[][] = [];
  const run: AwsRun = async (args) => {
    calls.push([...args]);
    return handler(args);
  };
  let t = 0;
  const cli = createCloudwatchCli({ run, sleep: async () => void (t += 2000), now: () => t, timeoutMs: 10_000, pollMs: 2000 });
  return { cli, calls };
};

describe("describeGroups", () => {
  test("keeps the exact name, with size, retention and creation", async () => {
    const { cli, calls } = rig(() =>
      ok({ logGroups: [{ logGroupName: "/ecs/be", storedBytes: 5, retentionInDays: 365, creationTime: 10 }, { logGroupName: "/ecs/be-v2-other", storedBytes: 9 }] }),
    );
    expect(await cli.describeGroups(["/ecs/be"], "us-west-2")).toEqual([{ name: "/ecs/be", storedBytes: 5, retentionDays: 365, createdAt: 10 }]);
    expect(calls[0]).toEqual(["--region", "us-west-2", "logs", "describe-log-groups", "--log-group-name-prefix", "/ecs/be", "--output", "json"]);
  });

  test("a name AWS does not know is left out; a never-expiring group has no retention", async () => {
    const { cli } = rig((args) => (args.includes("/a") ? ok({ logGroups: [{ logGroupName: "/a", storedBytes: 1 }] }) : ok({ logGroups: [] })));
    expect(await cli.describeGroups(["/a", "/missing"], "r")).toEqual([{ name: "/a", storedBytes: 1 }]);
  });

  test("an aws failure becomes an error with the last line of stderr", async () => {
    const { cli } = rig(() => ({ code: 255, stdout: "", stderr: "noise\nAn error occurred (AccessDeniedException): no" }));
    await expect(cli.describeGroups(["/a"], "r")).rejects.toThrow("describe-log-groups failed: An error occurred (AccessDeniedException): no");
  });
});

describe("runQuery", () => {
  test("starts with an argv array (no shell), polls until complete, drops @ptr, returns the stats", async () => {
    let polls = 0;
    const { cli, calls } = rig((args) => {
      if (args.includes("start-query")) return ok({ queryId: "q1" });
      polls += 1;
      return polls < 3
        ? ok({ status: "Running", results: [] })
        : ok({
            status: "Complete",
            results: [[{ field: "@timestamp", value: "t" }, { field: "@message", value: "m" }, { field: "@ptr", value: "p" }]],
            statistics: { bytesScanned: 7, recordsMatched: 1, recordsScanned: 9 },
          });
    });
    const res = await cli.runQuery(request);
    expect(res).toEqual({ status: "Complete", rows: [[{ field: "@timestamp", value: "t" }, { field: "@message", value: "m" }]], bytesScanned: 7, recordsMatched: 1, recordsScanned: 9 });
    expect(polls).toBe(3);
    const start = calls[0] ?? [];
    expect(start).toContain("--log-group-names");
    expect(start.slice(start.indexOf("--log-group-names") + 1, start.indexOf("--log-group-names") + 3)).toEqual(["/ecs/be", "/ecs/be2"]);
    // the query is one argv element, untouched
    expect(start[start.indexOf("--query-string") + 1]).toBe(request.query);
    expect(start[start.indexOf("--start-time") + 1]).toBe("1000");
    expect(start[start.indexOf("--end-time") + 1]).toBe("2001");
    expect(start[start.indexOf("--limit") + 1]).toBe("50");
  });

  test("a query that runs too long is stopped - the scan is billed while it runs", async () => {
    const { cli, calls } = rig((args) => (args.includes("start-query") ? ok({ queryId: "q9" }) : args.includes("stop-query") ? ok({ success: true }) : ok({ status: "Running", results: [] })));
    await expect(cli.runQuery(request)).rejects.toThrow("ran past 10s and was stopped");
    expect(calls.some((c) => c.includes("stop-query") && c.includes("q9"))).toBe(true);
  });

  test("an aborted query is stopped too", async () => {
    const abort = new AbortController();
    abort.abort();
    const { cli, calls } = rig((args) => (args.includes("start-query") ? ok({ queryId: "q2" }) : args.includes("stop-query") ? ok({}) : ok({ status: "Running", results: [] })));
    await expect(cli.runQuery(request, abort.signal)).rejects.toThrow("stopped");
    expect(calls.some((c) => c.includes("stop-query"))).toBe(true);
  });

  test("a failed status is returned, not thrown, so the answer can say so", async () => {
    const { cli } = rig((args) => (args.includes("start-query") ? ok({ queryId: "q3" }) : ok({ status: "Failed", results: [] })));
    expect((await cli.runQuery(request)).status).toBe("Failed");
  });

  test("garbage from aws is an error, not a crash", async () => {
    const { cli } = rig(() => ({ code: 0, stdout: "not json", stderr: "" }));
    await expect(cli.runQuery(request)).rejects.toThrow("not JSON");
  });
});
