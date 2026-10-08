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

  test("cloudwatch is refused whatever the order is", () => {
    for (const order of [["grafana"], ["datadog"], ["datadog", "grafana"]]) {
      const r = investigationRules(order);
      for (const denied of DENIED_LOG_SOURCES) expect(r).toContain(`NEVER query ${denied}`);
      expect(r).toContain("bills per GB scanned");
      expect(r).toContain("let a person decide");
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

describe("datadog is honest about the connector", () => {
  test("it says the tools may simply be absent, and where to go instead", () => {
    // the failure this exists for: told to use Datadog MCP tools it did not
    // have, the bot went hunting through ~/.claude.json for credentials
    const out = investigationRules(["datadog"], undefined, "X/jv");
    expect(out).toContain("do NOT go hunting for API keys");
    expect(out).toContain("X/jv investigate");
    expect(out).toContain("RUM");
  });

  test("with no prefix to offer it drops the pointer rather than printing one", () => {
    const out = investigationRules(["datadog"], undefined);
    expect(out).not.toContain("{prefix}");
    expect(out).not.toContain("investigate <question>");
  });
});
