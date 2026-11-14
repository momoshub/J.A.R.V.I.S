import { describe, expect, test } from "bun:test";
import {
  mergeDeniedServers,
  parseDenyList,
  WORKER_MCP_DENY_ENV,
  WORKER_MCP_TRIM_ENV,
  WORKER_MCP_TRIM_RULE,
  WORKER_SETTINGS_PATH,
  workerMcpEnv,
} from "../../src/domain/workerMcp.ts";

const ok = (r: ReturnType<typeof mergeDeniedServers>) => {
  if (!r.ok) throw new Error(`expected a merge, got: ${r.error}`);
  return r;
};

describe("parseDenyList", () => {
  test("trims, drops blanks and repeats, and unset is empty", () => {
    expect(parseDenyList(" pg-prod, ,ch-ro,pg-prod,")).toEqual(["pg-prod", "ch-ro"]);
    expect(parseDenyList(undefined)).toEqual([]);
    expect(parseDenyList("")).toEqual([]);
  });
});

describe("workerMcpEnv", () => {
  test("carries the names comma separated (empty for none) and the helper path", () => {
    expect(workerMcpEnv(["a", "b"], "/x/trim.ts")).toEqual({ [WORKER_MCP_DENY_ENV]: "a,b", [WORKER_MCP_TRIM_ENV]: "/x/trim.ts" });
    expect(workerMcpEnv([], "/x/trim.ts")[WORKER_MCP_DENY_ENV]).toBe("");
  });
});

describe("mergeDeniedServers", () => {
  test("a missing or blank file becomes a settings object with the names denied", () => {
    for (const existing of [undefined, "", "  \n"]) {
      const r = ok(mergeDeniedServers(existing, ["pg", "ch"]));
      expect(r.changed).toBe(true);
      expect(r.added).toEqual(["pg", "ch"]);
      expect(JSON.parse(r.text)).toEqual({ deniedMcpServers: [{ serverName: "pg" }, { serverName: "ch" }] });
      expect(r.text.endsWith("\n")).toBe(true);
    }
  });

  test("everything else in the file stays, and an entry already there is neither repeated nor dropped", () => {
    const existing = JSON.stringify({
      permissions: { allow: ["Bash(ls:*)"] },
      deniedMcpServers: [{ serverName: "pg" }, { serverUrl: "https://example.test/*" }],
    });
    const r = ok(mergeDeniedServers(existing, ["pg", "ch"]));
    expect(r.added).toEqual(["ch"]);
    expect(JSON.parse(r.text)).toEqual({
      permissions: { allow: ["Bash(ls:*)"] },
      deniedMcpServers: [{ serverName: "pg" }, { serverUrl: "https://example.test/*" }, { serverName: "ch" }],
    });
  });

  test("running it again changes nothing and hands the same text back", () => {
    const first = ok(mergeDeniedServers(undefined, ["pg", "ch"]));
    const again = ok(mergeDeniedServers(first.text, ["pg", "ch"]));
    expect(again.changed).toBe(false);
    expect(again.added).toEqual([]);
    expect(again.text).toBe(first.text);
  });

  test("a file it cannot read as a settings object is refused, never overwritten", () => {
    expect(mergeDeniedServers("{not json", ["pg"])).toEqual({
      ok: false,
      error: "the settings file is not valid JSON; fix or remove it by hand",
    });
    for (const bad of ["[]", "42", "null", '"x"']) {
      expect(mergeDeniedServers(bad, ["pg"]).ok).toBe(false);
    }
    const r = mergeDeniedServers('{"deniedMcpServers": "pg"}', ["pg"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("`deniedMcpServers`");
  });
});

describe("WORKER_MCP_TRIM_RULE", () => {
  test("says to trim before the launch, names the helper variable and bans the one-step new worktree", () => {
    expect(WORKER_MCP_TRIM_RULE).toContain(`"$${WORKER_MCP_TRIM_ENV}" <folder>`);
    expect(WORKER_MCP_TRIM_RULE).toContain(WORKER_SETTINGS_PATH);
    expect(WORKER_MCP_TRIM_RULE).toContain("before the launch, never after");
    expect(WORKER_MCP_TRIM_RULE).toContain("`--worktree new-child`");
    expect(WORKER_MCP_TRIM_RULE).toContain("`worktree create --agent`");
  });
});
