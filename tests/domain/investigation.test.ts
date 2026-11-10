import { describe, expect, test } from "bun:test";
import {
  DEFAULT_LOG_SOURCES,
  DENIED_LOG_SOURCES,
  investigationRules,
  logSourceOrder,
  parseLogSources,
} from "../../src/domain/investigation.ts";

describe("logSourceOrder", () => {
  test("grafana first, then datadog, when nothing is configured", () => {
    expect(logSourceOrder()).toEqual(["grafana", "datadog"]);
    expect(logSourceOrder("")).toEqual([...DEFAULT_LOG_SOURCES]);
  });

  test("configuration decides the order", () => {
    expect(logSourceOrder("datadog,grafana")).toEqual(["datadog", "grafana"]);
    expect(logSourceOrder("grafana")).toEqual(["grafana"]);
  });

  test("tolerates spacing, casing and repeats", () => {
    expect(logSourceOrder(" Grafana , datadog , grafana ")).toEqual(["grafana", "datadog"]);
  });

  test("a backend we cannot reach is never promised", () => {
    expect(parseLogSources("cloudwatch")).toEqual([]);
    expect(parseLogSources("splunk,grafana")).toEqual(["grafana"]);
    // a list of nothing we know falls back rather than leaving the bot sourceless
    expect(logSourceOrder("cloudwatch,splunk")).toEqual([...DEFAULT_LOG_SOURCES]);
  });
});

describe("investigationRules", () => {
  test("states the order and names the tool for each", () => {
    const r = investigationRules(["grafana", "datadog"]);
    expect(r).toContain("1. *grafana*");
    expect(r).toContain("2. *datadog*");
    expect(r).toContain("gcx logs query");
    expect(r).toContain("Start with *grafana*");
    expect(r).toContain("Only move on to datadog");
  });

  test("discovers the datasources rather than assuming loki", () => {
    const r = investigationRules(["grafana"], "/bin/grafana-get.sh");
    expect(r).toContain("ALWAYS start with `gcx datasources list`");
    expect(r).toContain("the type decides how you query it");
    expect(r).toContain("Never assume which is there");
  });

  test("a non-loki datasource is routed through the proxy helper", () => {
    const r = investigationRules(["grafana"], "/bin/grafana-get.sh");
    // gcx logs refuses anything that is not loki, so the escape hatch must be there
    expect(r).toContain("`gcx logs` will refuse it");
    expect(r).toContain("/bin/grafana-get.sh '/api/datasources/proxy/uid/");
    expect(r).toContain("VictoriaLogs takes LogsQL");
  });

  test("without the helper the proxy route is not offered at all", () => {
    const r = investigationRules(["grafana"]);
    expect(r).toContain("gcx datasources list"); // discovery still applies
    expect(r).not.toContain("ANY OTHER type");
    expect(r).not.toContain("{grafanaGet}"); // and no placeholder leaks out
  });

  test("points at the vendor's own investigation skill", () => {
    expect(investigationRules(["grafana"])).toContain("debug-with-grafana");
  });

  test("cloudwatch is refused by hand whatever the order is, and the command is the one allowed path", () => {
    for (const order of [["grafana"], ["datadog"], ["datadog", "grafana"]]) {
      const r = investigationRules(order);
      for (const denied of DENIED_LOG_SOURCES) expect(r).toContain(`NEVER query ${denied} by hand`);
      expect(r).toContain("bills per GB scanned");
      expect(r).toContain("`cloudwatch` command is the only allowed path");
      expect(r).toContain("confirm");
    }
  });

  test("an empty result is not a reason to try the next one", () => {
    expect(investigationRules(["grafana", "datadog"])).toContain("an empty result is an answer");
  });

  test("unreachable and empty must not be reported the same way", () => {
    expect(investigationRules(["grafana"])).toContain("Say which source answered you");
  });

  test("nothing configured says nothing at all", () => {
    expect(investigationRules([])).toBe("");
  });

  test("a single source offers no fallback it cannot make", () => {
    const r = investigationRules(["grafana"]);
    expect(r).toContain("Start with *grafana*");
    expect(r).not.toContain("Only move on to");
  });
});

describe("datadog states where the data is, not how to escalate", () => {
  test("RUM lives only in Datadog, reached through the host's read-only server", () => {
    const out = investigationRules(["datadog"]);
    expect(out).toContain("RUM");
    expect(out).toContain("exists ONLY here, never in Grafana");
    expect(out).toContain("mcp__datadog__");
    expect(out).toContain("ToolSearch");
    expect(out).toContain("execute_code");
    expect(out).not.toContain("an ordinary chat turn does not have them");
  });

  test("escalation is NOT repeated here - one rule covers every source", () => {
    // it used to carry its own "RUN IT YOURSELF" paragraph, and so did the
    // Slack/Notion rule. Three copies of one idea is how the fourth case is
    // missed; `credentialGapRules` now owns it
    const out = investigationRules(["grafana", "datadog"], "/bin/g.sh");
    expect(out).not.toContain("RUN IT YOURSELF");
    expect(out).not.toContain("investigate <the question>");
    expect(out).not.toContain("{prefix}");
  });
});
