import { describe, expect, test } from "bun:test";
import { dispatchCommand } from "../../src/application/commands.ts";
import { createWorkerTickets } from "../../src/application/workerTickets.ts";
import { actor, build } from "./commandsFixture.ts";

const admin = () => actor({ slackId: "U0ADMIN0001", role: "admin" });
const tokenOf = (out: string): string => out.match(/JARVIS_RUN_TICKET=(jvwk_\w+)/)?.[1] ?? "";

describe("the worker-ticket command", () => {
  test("mints for the caller's own repo, returns the token only in its result, and never posts", async () => {
    const tickets = createWorkerTickets(() => 1000);
    const deps = { ...build(), workerTickets: tickets };
    const out = await dispatchCommand(deps, admin(), "C1", "worker-ticket o/r pending push pr-create --ttl 2h");
    const token = tokenOf(out);
    expect(token).toStartWith("jvwk_");
    expect(out).toContain("git-auth, pr-create");
    expect(out).toContain("worker-ticket bind");
    expect(tickets.redeem(token, { action: "pr-create", repo: "o/r" })).toMatchObject({ ok: false, reason: "pending" });
  });

  test("bind makes it usable, for the minter only", async () => {
    const tickets = createWorkerTickets(() => 1000);
    const deps = { ...build(), workerTickets: tickets };
    const out = await dispatchCommand(deps, admin(), "C1", "worker-ticket o/r pending");
    const token = tokenOf(out);
    const id = out.match(/Worker ticket (\w{8})/)?.[1] ?? "";
    expect(await dispatchCommand(deps, actor({ slackId: "U0OTHER0001", role: "admin" }), "C1", `worker-ticket bind ${id} ctx_w1`)).toContain("someone else");
    expect(await dispatchCommand(deps, admin(), "C1", `worker-ticket bind ${id} ctx_w1`)).toContain("bound to ctx_w1");
    expect(tickets.redeem(token, { action: "git-auth", repo: "o/r" }).ok).toBe(true);
    expect(await dispatchCommand(deps, admin(), "C1", "worker-ticket revoke ctx_w1")).toContain("Revoked 1");
    expect(tickets.redeem(token, { action: "git-auth", repo: "o/r" })).toMatchObject({ ok: false, reason: "revoked" });
  });

  test("a dispatch id binds at once", async () => {
    const tickets = createWorkerTickets(() => 1000);
    const deps = { ...build(), workerTickets: tickets };
    const token = tokenOf(await dispatchCommand(deps, admin(), "C1", "wticket o/r ctx_w2 comment"));
    expect(tickets.redeem(token, { action: "comment", repo: "o/r" })).toMatchObject({ ok: true, dispatchId: "ctx_w2" });
    expect(tickets.redeem(token, { action: "pr-create", repo: "o/r" })).toMatchObject({ ok: false, reason: "action" });
  });

  test("pal and executer cannot mint; a bad action is refused", async () => {
    const deps = { ...build(), workerTickets: createWorkerTickets(() => 1) };
    for (const role of ["pal", "executer"] as const) {
      expect(tokenOf(await dispatchCommand(deps, actor({ role }), "C1", "worker-ticket o/r pending"))).toBe("");
    }
    expect(await dispatchCommand(deps, admin(), "C1", "worker-ticket o/r pending pr-merge")).toContain("may not get");
  });

  test("typed by a person (a reply is wired) it posts no token at all", async () => {
    const tickets = createWorkerTickets(() => 1);
    const deps = { ...build(), workerTickets: tickets };
    const said: string[] = [];
    const out = await dispatchCommand(deps, admin(), "C1", "worker-ticket o/r pending", { reply: async (t) => void said.push(t) });
    expect(tokenOf(out)).toBe("");
    expect(out).toContain("never into a thread");
  });

  test("the command log never keeps the token", async () => {
    const logged: { result: string; args: string }[] = [];
    const deps = {
      ...build(),
      workerTickets: createWorkerTickets(() => 1),
      commandLog: { add: (e: { result: string; args: string }) => void logged.push(e) } as never,
    };
    const out = await dispatchCommand(deps, admin(), "C1", "worker-ticket o/r pending");
    const token = tokenOf(out);
    expect(token).not.toBe("");
    expect(JSON.stringify(logged)).not.toContain(token);
  });
});
