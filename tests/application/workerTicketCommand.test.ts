import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { dispatchCommand } from "../../src/application/commands.ts";
import { actor, build } from "./commandsFixture.ts";
import { ticketRig, TICKET_DIR } from "./workerTicketFixture.ts";

const admin = () => actor({ slackId: "U0ADMIN0001", role: "admin" });
const fileOf = (out: string): string => out.match(/JARVIS_RUN_TICKET_FILE=(\S+)/)?.[1] ?? "";
const idOfFile = (file: string): string => file.slice(TICKET_DIR.length + 1);
/** The brain's run bridge is the only caller that sets this. */
const brain = { fromBrainRun: true };
const setup = () => {
  const rig = ticketRig();
  return { rig, deps: { ...build(), workerTickets: rig.tickets } };
};

describe("the worker-ticket command", () => {
  test("mints through the run bridge and returns a file path, never the token", async () => {
    const { rig, deps } = setup();
    const out = await dispatchCommand(deps, admin(), "C1", "worker-ticket o/r pending comment pr-create --ttl 2h", brain);
    const file = fileOf(out);
    const token = rig.tokenOf(idOfFile(file));
    expect(token).toStartWith("jvwk_");
    expect(out).not.toContain(token);
    expect(out).not.toContain("jvwk_");
    expect(out).toContain("comment, pr-create");
    expect(out).toContain("worker-ticket bind");
    expect(rig.tickets.redeem(token, { action: "pr-create", repo: "o/r" })).toMatchObject({ ok: false, reason: "pending" });
  });

  test("the default grant has no git or push: the worker pushes with the one-shot human credential", async () => {
    const { rig, deps } = setup();
    const out = await dispatchCommand(deps, admin(), "C1", "worker-ticket o/r ctx_w1", brain);
    const token = rig.tokenOf(idOfFile(fileOf(out)));
    expect(out).toContain("pr-create, comment, pr-edit");
    expect(rig.tickets.redeem(token, { action: "git-auth", repo: "o/r" })).toMatchObject({ ok: false, reason: "action" });
    const opt = await dispatchCommand(deps, admin(), "C1", "worker-ticket o/r ctx_w2 push", brain);
    expect(rig.tickets.redeem(rig.tokenOf(idOfFile(fileOf(opt))), { action: "git-auth", repo: "o/r" }).ok).toBe(true);
  });

  test("bind makes it usable, for the minter only", async () => {
    const { rig, deps } = setup();
    const out = await dispatchCommand(deps, admin(), "C1", "worker-ticket o/r pending", brain);
    const token = rig.tokenOf(idOfFile(fileOf(out)));
    const id = out.match(/Worker ticket (\w{8})/)?.[1] ?? "";
    const call = { action: "comment", repo: "o/r" };
    expect(await dispatchCommand(deps, actor({ slackId: "U0OTHER0001", role: "admin" }), "C1", `worker-ticket bind ${id} ctx_w1`, brain)).toContain("someone else");
    expect(await dispatchCommand(deps, admin(), "C1", `worker-ticket bind ${id} ctx_w1`, brain)).toContain("bound to ctx_w1");
    expect(rig.tickets.redeem(token, call).ok).toBe(true);
    expect(await dispatchCommand(deps, admin(), "C1", "worker-ticket revoke ctx_w1", brain)).toContain("Revoked 1");
    expect(rig.tickets.redeem(token, call)).toMatchObject({ ok: false, reason: "revoked" });
    expect(rig.files.size).toBe(0);
  });

  test("a dispatch id binds at once", async () => {
    const { rig, deps } = setup();
    const token = rig.tokenOf(idOfFile(fileOf(await dispatchCommand(deps, admin(), "C1", "wticket o/r ctx_w2 comment", brain))));
    expect(rig.tickets.redeem(token, { action: "comment", repo: "o/r" })).toMatchObject({ ok: true, dispatchId: "ctx_w2" });
    expect(rig.tickets.redeem(token, { action: "pr-create", repo: "o/r" })).toMatchObject({ ok: false, reason: "action" });
  });

  test("pal and executer cannot mint; a bad action is refused", async () => {
    const { rig, deps } = setup();
    for (const role of ["pal", "executer"] as const) {
      await dispatchCommand(deps, actor({ role }), "C1", "worker-ticket o/r pending", brain);
    }
    expect(rig.files.size).toBe(0);
    expect(await dispatchCommand(deps, admin(), "C1", "worker-ticket o/r pending pr-merge", brain)).toContain("may not get");
  });

  test("every path that is not the brain's run bridge is refused and mints nothing", async () => {
    const { rig, deps } = setup();
    const said: string[] = [];
    const line = "worker-ticket o/r pending";
    const attempts: Array<Parameters<typeof dispatchCommand>[4]> = [
      { reply: async (t) => void said.push(t), threadTs: "1.1" }, // typed in a thread
      undefined, // a schedule, an errand or the command menu passes no marker
      { preApproved: true }, // a human's approve click
      { slash: "jv", prefix: "jv" }, // a slash command
      { fromBrainRun: "yes" as never }, // truthy but not the marker
    ];
    for (const opts of attempts) {
      const out = await dispatchCommand(deps, admin(), "C1", line, opts);
      expect(out).toContain("only mint a worker ticket for my own turn");
      expect(out).not.toContain("JARVIS_RUN_TICKET_FILE");
    }
    expect(rig.files.size).toBe(0);
    expect(said).toEqual([]);
  });

  test("revoke stays available to the person who minted it, wherever they type it", async () => {
    const { rig, deps } = setup();
    await dispatchCommand(deps, admin(), "C1", "worker-ticket o/r ctx_w5", brain);
    expect(await dispatchCommand(deps, admin(), "C1", "worker-ticket revoke ctx_w5")).toContain("Revoked 1");
    expect(rig.files.size).toBe(0);
  });

  test("the command log never keeps the token", async () => {
    const logged: { result: string; args: string }[] = [];
    const rig = ticketRig();
    const deps = {
      ...build(),
      workerTickets: rig.tickets,
      commandLog: { add: (e: { result: string; args: string }) => void logged.push(e) } as never,
    };
    const out = await dispatchCommand(deps, admin(), "C1", "worker-ticket o/r pending", brain);
    const token = rig.tokenOf(idOfFile(fileOf(out)));
    expect(token).not.toBe("");
    expect(JSON.stringify(logged)).not.toContain(token);
  });
});

describe("who may set the run-bridge marker", () => {
  test("only the composition root's /api/commands/run handler does, after redeeming a turn ticket", async () => {
    const hits: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else if (p.endsWith(".ts") && (await Bun.file(p).text()).match(/fromBrainRun\s*:\s*true/)) hits.push(p.replace(/^.*\/src\//, "src/"));
      }
    };
    await walk(join(import.meta.dir, "../../src"));
    expect(hits).toEqual(["src/index.ts"]);
    const index = await Bun.file(join(import.meta.dir, "../../src/index.ts")).text();
    const at = index.indexOf("fromBrainRun: true");
    expect(index.lastIndexOf("commandTickets.redeem(ticket)", at)).toBeGreaterThan(index.lastIndexOf("runCommand: async", at));
  });
});
