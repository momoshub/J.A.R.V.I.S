import { describe, expect, test } from "bun:test";
import {
  DEFAULT_WORKER_ACTIONS,
  endedWorkerOf,
  HOUR_MS,
  isWorkerToken,
  parseTtl,
  parseWorkerTicketArgs,
  WORKER_TTL_DEFAULT_MS,
  WORKER_TTL_MAX_MS,
} from "../../src/domain/workerTicket.ts";
import { redactSecrets } from "../../src/domain/toolVisibility.ts";

describe("parseWorkerTicketArgs", () => {
  test("defaults: the usual actions, 3h, repo lower-cased", () => {
    const r = parseWorkerTicketArgs(["Acme/Repo", "pending"]);
    expect(r).toMatchObject({ ok: true, clamped: false, req: { repo: "acme/repo", dispatchId: "pending", actions: DEFAULT_WORKER_ACTIONS, ttlMs: WORKER_TTL_DEFAULT_MS } });
  });

  test("git and push are the git-auth action; duplicates collapse", () => {
    const r = parseWorkerTicketArgs(["o/r", "ctx_abc", "git", "push", "pr-create"]);
    expect(r.ok && r.req.actions).toEqual(["git-auth", "pr-create"]);
  });

  test("an action beyond the ceiling is refused, never dropped", () => {
    for (const a of ["pr-merge", "review", "pr-close", "labels-remove", "nope"]) {
      const r = parseWorkerTicketArgs(["o/r", "pending", "comment", a]);
      expect(r.ok).toBe(false);
    }
  });

  test("ttl is parsed and capped at 6h, and says so", () => {
    expect(parseWorkerTicketArgs(["o/r", "pending", "--ttl", "90m"])).toMatchObject({ ok: true, req: { ttlMs: 90 * 60_000 } });
    expect(parseWorkerTicketArgs(["o/r", "pending", "--ttl=2h"])).toMatchObject({ ok: true, req: { ttlMs: 2 * HOUR_MS } });
    expect(parseWorkerTicketArgs(["o/r", "pending", "--ttl", "24h"])).toMatchObject({ ok: true, clamped: true, req: { ttlMs: WORKER_TTL_MAX_MS } });
    expect(parseWorkerTicketArgs(["o/r", "pending", "--ttl", "soon"]).ok).toBe(false);
    expect(parseTtl("0h")).toBeUndefined();
  });

  test("bad repo or dispatch id", () => {
    expect(parseWorkerTicketArgs(["nope", "pending"]).ok).toBe(false);
    expect(parseWorkerTicketArgs(["o/r", "run_1"]).ok).toBe(false);
    expect(parseWorkerTicketArgs(["o/r"]).ok).toBe(false);
  });
});

describe("worker tokens", () => {
  test("recognised by prefix; redacted from anything user-visible", () => {
    expect(isWorkerToken("jvwk_abc")).toBe(true);
    expect(isWorkerToken("0123abcd")).toBe(false);
    const token = `jvwk_${"a1".repeat(16)}`;
    expect(redactSecrets(`export JARVIS_RUN_TICKET=${token} now`)).not.toContain(token);
  });

  test("only finished or died ends a worker, not waiting", () => {
    expect(endedWorkerOf("orca worker ctx_a1 finished: done")).toBe("ctx_a1");
    expect(endedWorkerOf("x\norca worker ctx_a1 died: gone")).toBe("ctx_a1");
    expect(endedWorkerOf("orca worker ctx_a1 waiting: input")).toBeUndefined();
    expect(endedWorkerOf("nothing")).toBeUndefined();
  });
});
