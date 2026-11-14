import { describe, expect, test } from "bun:test";
import {
  mergeDeniedServers,
  orcaRepoPaths,
  parseDenyList,
  WORKER_CHECKOUT_TRIM_RULE,
  WORKER_HOME_ENV,
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
  test("carries the names comma separated (empty for none), the helper path and the worker home", () => {
    expect(workerMcpEnv(["a", "b"], "/x/trim.ts", "/w/home")).toEqual({
      [WORKER_MCP_DENY_ENV]: "a,b",
      [WORKER_MCP_TRIM_ENV]: "/x/trim.ts",
      [WORKER_HOME_ENV]: "/w/home",
    });
    expect(workerMcpEnv([], "/x/trim.ts", "/w/home")[WORKER_MCP_DENY_ENV]).toBe("");
  });
});

describe("orcaRepoPaths", () => {
  test("reads the paths out of `orca repo list --json` and tolerates any other shape", () => {
    expect(orcaRepoPaths({ ok: true, result: { repos: [{ path: "/a" }, { id: "x" }, { path: "/b" }] } })).toEqual(["/a", "/b"]);
    for (const bad of [null, "x", {}, { result: {} }, { result: { repos: "no" } }]) expect(orcaRepoPaths(bad)).toEqual([]);
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
  test("starts workers in the worker home, trimmed before the launch, never in a folder a person works in", () => {
    expect(WORKER_MCP_TRIM_RULE).toContain(`"$${WORKER_MCP_TRIM_ENV}"\` with no argument`);
    expect(WORKER_MCP_TRIM_RULE).toContain(`--worktree path:$${WORKER_HOME_ENV}`);
    expect(WORKER_MCP_TRIM_RULE).toContain("never in `~/Workspaces`");
    expect(WORKER_MCP_TRIM_RULE).toContain(WORKER_SETTINGS_PATH);
    expect(WORKER_MCP_TRIM_RULE).toContain("before the launch, never after");
  });

  test("a worker that is not inside the repository gets absolute paths and cuts its own worktree", () => {
    expect(WORKER_MCP_TRIM_RULE).toContain("absolute paths in its brief");
    expect(WORKER_MCP_TRIM_RULE).toContain("git worktree add <abs path>");
  });
});

describe("WORKER_CHECKOUT_TRIM_RULE", () => {
  test("trims the checkout before the launch and bans the one-step new worktree", () => {
    expect(WORKER_CHECKOUT_TRIM_RULE).toContain(`"$${WORKER_MCP_TRIM_ENV}" <worktree path>`);
    expect(WORKER_CHECKOUT_TRIM_RULE).toContain("before the launch, never after");
    expect(WORKER_CHECKOUT_TRIM_RULE).toContain("`--worktree new-child`");
    expect(WORKER_CHECKOUT_TRIM_RULE).toContain("`worktree create --agent`");
  });
});
