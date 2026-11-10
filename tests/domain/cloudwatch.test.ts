import { describe, expect, test } from "bun:test";
import {
  CANCEL_ACTION,
  CODE_ACTION_PREFIX,
  CONFIRM_ACTION,
  COSTLY_RANGE_MS,
  DEFAULT_LIMIT,
  DEFAULT_REGION,
  cloudwatchMode,
  confirmText,
  costWarning,
  estimateOf,
  estimateScanBytes,
  formatResult,
  helpText,
  isCostlyRange,
  parseCloudwatchArgs,
  parseSpan,
  refusal,
  type CloudwatchRequest,
  type QueryResult,
} from "../../src/domain/cloudwatch.ts";
import { hasLiveKit } from "../../src/domain/kitEvents.ts";

const NOW = Date.parse("2026-11-10T10:00:00Z");
const DAY = 86_400_000;
const args = (line: string) => line.split(/\s+/);

describe("role rule", () => {
  test("owner runs, executer and admin confirm, pal is refused", () => {
    expect(cloudwatchMode("owner")).toBe("run");
    expect(cloudwatchMode("admin")).toBe("confirm");
    expect(cloudwatchMode("executer")).toBe("confirm");
    expect(cloudwatchMode("pal")).toBe("refuse");
  });

  test("the refusal names who can", () => {
    const text = refusal("pal");
    expect(text).toContain("*pal*");
    expect(text).toContain("executer");
    expect(text).toContain("admin");
    expect(text).toContain("owner");
  });

  test("the buttons are jv: ids that the kit never treats as an open question", () => {
    expect(CONFIRM_ACTION.startsWith("jv:")).toBe(true);
    expect(CANCEL_ACTION.startsWith(CODE_ACTION_PREFIX)).toBe(true);
    const blocks = [{ type: "actions", elements: [{ type: "button", action_id: CONFIRM_ACTION }, { type: "button", action_id: CANCEL_ACTION }] }];
    expect(hasLiveKit(blocks)).toBe(false);
    // while a model-built jv: button on the same message still is
    expect(hasLiveKit([...blocks, { type: "actions", elements: [{ type: "button", action_id: "jv:ok" }] }])).toBe(true);
  });
});

describe("parseSpan", () => {
  test("minutes, hours, days, weeks", () => {
    expect(parseSpan("15m")).toBe(15 * 60_000);
    expect(parseSpan("2h")).toBe(2 * 3_600_000);
    expect(parseSpan("3d")).toBe(3 * DAY);
    expect(parseSpan("1w")).toBe(7 * DAY);
  });
  test("anything else is not a span", () => {
    for (const bad of ["", "15", "m", "0m", "-1h", "3 days"]) expect(parseSpan(bad)).toBeUndefined();
  });
});

describe("parseCloudwatchArgs", () => {
  const ok = (line: string, defaults = {}) => {
    const r = parseCloudwatchArgs(args(line), NOW, defaults);
    if (!r.ok) throw new Error(r.error);
    return r.request;
  };
  const err = (line: string, defaults = {}) => {
    const r = parseCloudwatchArgs(args(line), NOW, defaults);
    return r.ok ? "" : r.error;
  };

  test("flags first, everything after is the query", () => {
    const r = ok("--group /ecs/be --last 15m fields @message | filter @message like /--x/ | limit 5");
    expect(r.groups).toEqual(["/ecs/be"]);
    expect(r.query).toBe("fields @message | filter @message like /--x/ | limit 5");
    expect(r.endMs).toBe(NOW);
    expect(r.startMs).toBe(NOW - 15 * 60_000);
    expect(r.region).toBe(DEFAULT_REGION);
    expect(r.limit).toBe(DEFAULT_LIMIT);
  });

  test("--flag=value, several groups, region and limit", () => {
    const r = ok("--group=/a,/b -g /c --region=eu-west-1 --limit 10 --last=2h stats count()");
    expect(r.groups).toEqual(["/a", "/b", "/c"]);
    expect(r.region).toBe("eu-west-1");
    expect(r.limit).toBe(10);
    expect(r.endMs - r.startMs).toBe(2 * 3_600_000);
  });

  test("an explicit range", () => {
    const r = ok("--group /g --from 2026-11-10T08:00:00Z --to 2026-11-10T08:30:00Z fields @message");
    expect(r.endMs - r.startMs).toBe(30 * 60_000);
  });

  test("the default range is an hour, and a default group fills a missing one", () => {
    const r = ok("fields @message", { group: "/ecs/default", region: "us-east-1" });
    expect(r.groups).toEqual(["/ecs/default"]);
    expect(r.region).toBe("us-east-1");
    expect(r.endMs - r.startMs).toBe(3_600_000);
  });

  test("Slack's escaped < > & are put back in the query", () => {
    expect(ok("--group /g stats count() by bin(5m) | filter x &gt; 5 and y &lt; 2 &amp;&amp; z").query).toBe(
      "stats count() by bin(5m) | filter x > 5 and y < 2 && z",
    );
  });

  test("mistakes are named, not guessed at", () => {
    expect(err("--group /g")).toContain("Which query");
    expect(err("fields @message")).toContain("Which log group");
    expect(err("--group notagroup fields x")).toContain("not a log group name");
    expect(err("--group /g --last soon fields x")).toContain("--last");
    expect(err("--group /g --bogus 1 fields x")).toContain("--bogus");
    expect(err("--group /g --region mars fields x")).toContain("--region");
    expect(err("--group /g --limit 0 fields x")).toContain("--limit");
    expect(err("--group /g --last 1h --from 2026-11-10T08:00:00Z fields x")).toContain("not both");
    expect(err("--group /g --from 2026-11-10T09:00:00Z --to 2026-11-10T08:00:00Z fields x")).toContain("empty");
    expect(err("--group /g --last 500d fields x")).toContain("longer than any log group keeps");
    expect(err(`--group /g ${"x".repeat(1600)}`)).toContain("the limit is 1500");
    expect(err(`--group ${Array.from({ length: 11 }, (_, i) => `/g${i}`).join(",")} fields x`)).toContain("At most");
  });
});

describe("cost estimate", () => {
  const group = { name: "/g", storedBytes: 365e9, retentionDays: 365 };

  test("scales the stored size by the share of retention the range covers", () => {
    expect(estimateScanBytes([group], 1 * DAY, NOW)).toBe(1e9);
    expect(estimateScanBytes([group], 365 * DAY, NOW)).toBe(365e9);
    // a range longer than retention cannot scan more than is stored
    expect(estimateScanBytes([group], 400 * DAY, NOW)).toBe(365e9);
  });

  test("a young group with long retention is aged, not spread over its retention", () => {
    const young = { name: "/y", storedBytes: 5e9, retentionDays: 30, createdAt: NOW - 5 * DAY };
    expect(estimateScanBytes([young], 1 * DAY, NOW)).toBe(1e9);
  });

  test("sums groups, and a never-expiring group is aged from its creation", () => {
    const young = { name: "/y", storedBytes: 10e9, createdAt: NOW - 10 * DAY };
    expect(estimateScanBytes([group, young], 1 * DAY, NOW)).toBe(1e9 + 1e9);
  });

  test("over 3 weeks is costly, exactly 3 weeks is not", () => {
    expect(isCostlyRange(COSTLY_RANGE_MS)).toBe(false);
    expect(isCostlyRange(COSTLY_RANGE_MS + 1)).toBe(true);
  });

  test("the warning says costly for a long range and shows the size and price", () => {
    const req: CloudwatchRequest = { groups: ["/g"], region: "us-west-2", query: "q", startMs: NOW - 30 * DAY, endMs: NOW, limit: 50 };
    const long = costWarning(estimateOf(req, [group], NOW));
    expect(long).toContain("Costly range");
    expect(long).toContain("30.00 GB");
    expect(long).toContain("$0.15");
    const short = costWarning(estimateOf({ ...req, startMs: NOW - 15 * 60_000 }, [group], NOW));
    expect(short).not.toContain("Costly range");
    expect(short).toContain("under $0.01");
  });
});

describe("what the Confirm message shows", () => {
  test("query, log group, range, cost warning, who may confirm", () => {
    const req: CloudwatchRequest = { groups: ["/ecs/be"], region: "us-west-2", query: "fields @message | limit 5", startMs: NOW - 3_600_000, endMs: NOW, limit: 50 };
    const text = confirmText("U1", req, estimateOf(req, [{ name: "/ecs/be", storedBytes: 1e12, retentionDays: 365 }], NOW), 900_000);
    expect(text).toContain("<@U1>");
    expect(text).toContain("`/ecs/be`");
    expect(text).toContain("fields @message | limit 5");
    expect(text).toContain("2026-11-10 09:00Z → 2026-11-10 10:00Z");
    expect(text).toContain("bills per GB");
    expect(text).toContain("Only <@U1> or the owner can confirm");
    expect(text).toContain("Expires in 15 min");
  });

  test("the whole query and the row limit are shown, never clipped", () => {
    const query = `fields @message | filter @message like /${"a".repeat(1400)}/`;
    const req: CloudwatchRequest = { groups: ["/g"], region: "r", query, startMs: 0, endMs: 1, limit: 77 };
    const text = confirmText("U1", req, { bytes: 0, usd: 0, costly: false, rangeMs: 1 });
    expect(text).toContain(query);
    expect(text).toContain("up to 77");
  });

  test("a query cannot close its own code fence", () => {
    const req: CloudwatchRequest = { groups: ["/g"], region: "r", query: "a ``` b", startMs: 0, endMs: 1, limit: 1 };
    const text = confirmText("U1", req, { bytes: 0, usd: 0, costly: false, rangeMs: 1 });
    expect(text.match(/```/g)?.length).toBe(2);
  });
});

describe("formatResult", () => {
  const req: CloudwatchRequest = { groups: ["/ecs/be"], region: "us-west-2", query: "q", startMs: NOW - 900_000, endMs: NOW, limit: 50 };
  const result = (rows: QueryResult["rows"]): QueryResult => ({ status: "Complete", rows, bytesScanned: 2e9, recordsMatched: rows.length, recordsScanned: 100 });

  test("a compact answer: header, rows, who ran it", () => {
    const text = formatResult(req, result([[{ field: "@timestamp", value: "t1" }, { field: "@message", value: "boom" }]]), "confirm", "U1");
    expect(text).toContain("CloudWatch complete - 1 row");
    expect(text).toContain("scanned 2.00 GB ($0.01)");
    expect(text).toContain("@timestamp=t1 | @message=boom");
    expect(text).toContain("confirmed by <@U1>");
  });

  test("the owner's run says no confirmation was needed", () => {
    expect(formatResult(req, result([]), "run", "UOWNER")).toContain("run by <@UOWNER> (owner, no confirmation needed)");
    expect(formatResult(req, result([]), "run", "UOWNER")).toContain("_no rows_");
  });

  test("clips cells and rows, caps the body, and says what was left out", () => {
    const rows = Array.from({ length: 40 }, (_, i) => [{ field: "@message", value: `row${i} ${"x".repeat(2000)}` }]);
    const text = formatResult(req, result(rows), "confirm", "U1");
    expect(text.length).toBeLessThan(3600);
    expect(text).toContain("...");
    expect(text).toMatch(/_\d+ more rows not shown - narrow the query or the range_/);
  });

  test("redacts secrets a request line carries", () => {
    const text = formatResult(req, result([[{ field: "@message", value: "Authorization: Bearer sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789" }]]), "confirm", "U1");
    expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
  });

  test("hitting the limit is said, so a full page never reads as the whole answer", () => {
    const rows = Array.from({ length: 3 }, (_, i) => [{ field: "@message", value: `r${i}` }]);
    expect(formatResult({ ...req, limit: 3 }, result(rows), "confirm", "U1")).toContain("hit the limit of 3 rows");
  });

  test("a code fence in a log line cannot break the message", () => {
    const text = formatResult(req, result([[{ field: "@message", value: "```oops```" }]]), "confirm", "U1");
    expect(text.match(/```/g)?.length).toBe(2);
  });
});

test("help explains the roles, the cost guard and the example", () => {
  const text = helpText("X/jv");
  for (const needle of ["owner", "executer", "admin", "Confirm", "3 weeks", "audited", "--group", "--last", "X/jv cloudwatch"]) {
    expect(text).toContain(needle);
  }
});
