import { describe, expect, test } from "bun:test";
import {
  createdHandleOf,
  createOrcaCli,
  createOrcaTerminal,
  handleState,
  ORCA_CALL_TIMEOUT_MS,
  type OrcaRun,
} from "../../src/infrastructure/system/orcaTerminal.ts";

const shown = (handle: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ ok: true, result: { terminal: { handle, orphaned: false, ...extra } } });
const stale = JSON.stringify({ ok: false, error: { code: "terminal_handle_stale" } });

/** A scripted Orca: which handles are live, what `create` issues next, every call made. */
const fakeOrca = (opts: { live?: string[]; next?: string[]; down?: boolean; silent?: boolean }) => {
  const live = new Set(opts.live ?? []);
  const next = [...(opts.next ?? [])];
  const calls: string[] = [];
  const run: OrcaRun = async (args) => {
    calls.push(args.slice(0, 2).join(" "));
    if (opts.down) return { code: 1, stdout: "" };
    if (opts.silent && args[1] === "show") return { code: -1, stdout: "" };
    if (args[1] === "show") {
      const h = args[3] as string;
      return live.has(h) ? { code: 0, stdout: shown(h) } : { code: 1, stdout: stale };
    }
    const h = next.shift();
    if (!h) return { code: 1, stdout: "" };
    live.add(h);
    return { code: 0, stdout: shown(h) };
  };
  return { run, calls, live };
};

const setup = (orca: ReturnType<typeof fakeOrca>, stored?: string) => {
  let saved = stored;
  let now = 0;
  const terminal = createOrcaTerminal({
    run: orca.run,
    load: () => saved,
    save: (h) => {
      saved = h;
    },
    worktree: "path:/work",
    now: () => now,
    ttlMs: 1_000,
  });
  return { terminal, saved: () => saved, tick: (ms: number) => (now += ms) };
};

describe("orca terminal output", () => {
  test("a handle is live only when Orca shows that exact one, attached", () => {
    expect(handleState(shown("term_a"), "term_a")).toBe("live");
    expect(handleState(shown("term_a"), "term_b")).toBe("gone");
    expect(handleState(shown("term_a", { orphaned: true }), "term_a")).toBe("gone");
    expect(handleState(stale, "term_a")).toBe("gone");
    // no answer at all is not the same as "gone"
    expect(handleState("", "term_a")).toBe("unknown");
    expect(handleState("not json", "term_a")).toBe("unknown");
  });

  test("create's handle is read from result.terminal.handle", () => {
    expect(createdHandleOf(shown("term_new"))).toBe("term_new");
    expect(createdHandleOf(JSON.stringify({ ok: true, result: { terminal: { handle: "pane-1" } } }))).toBeUndefined();
    expect(createdHandleOf(stale)).toBeUndefined();
  });
});

describe("createOrcaTerminal", () => {
  test("creates one terminal, saves it, and reuses it inside the TTL", async () => {
    const orca = fakeOrca({ next: ["term_1"] });
    const { terminal, saved } = setup(orca);
    expect(await terminal.handle()).toBe("term_1");
    expect(saved()).toBe("term_1");
    expect(await terminal.handle()).toBe("term_1");
    expect(orca.calls).toEqual(["terminal create"]);
  });

  test("a handle kept from an earlier start is checked and reused, not replaced", async () => {
    const orca = fakeOrca({ live: ["term_kept"], next: ["term_new"] });
    const { terminal, saved } = setup(orca, "term_kept");
    expect(await terminal.handle()).toBe("term_kept");
    expect(saved()).toBe("term_kept");
    expect(orca.calls).toEqual(["terminal show"]);
  });

  test("after the TTL it checks again and re-creates a terminal that is gone", async () => {
    const orca = fakeOrca({ next: ["term_1", "term_2"] });
    const { terminal, saved, tick } = setup(orca);
    expect(await terminal.handle()).toBe("term_1");
    // Orca restarted: every old handle is stale
    orca.live.clear();
    tick(500);
    expect(await terminal.handle()).toBe("term_1");
    tick(600);
    expect(await terminal.handle()).toBe("term_2");
    expect(saved()).toBe("term_2");
    expect(orca.calls).toEqual(["terminal create", "terminal show", "terminal create"]);
  });

  test("Orca not running is no handle, asked again only after the TTL", async () => {
    const orca = fakeOrca({ down: true });
    const { terminal, saved, tick } = setup(orca, "term_kept");
    expect(await terminal.handle()).toBeUndefined();
    expect(await terminal.handle()).toBeUndefined();
    expect(orca.calls).toEqual(["terminal show"]);
    // the kept handle is not thrown away: it is still good if Orca was only busy
    expect(saved()).toBe("term_kept");
    tick(1_000);
    await terminal.handle();
    expect(orca.calls).toEqual(["terminal show", "terminal show"]);
  });

  test("Orca not running and nothing kept: the create fails and nothing is saved", async () => {
    const orca = fakeOrca({ down: true });
    const { terminal, saved } = setup(orca);
    expect(await terminal.handle()).toBeUndefined();
    expect(orca.calls).toEqual(["terminal create"]);
    expect(saved()).toBeUndefined();
  });

  test("a live terminal that was only slow to answer is not replaced by a second one", async () => {
    const orca = fakeOrca({ live: ["term_kept"], next: ["term_leak"], silent: true });
    const { terminal, saved } = setup(orca, "term_kept");
    expect(await terminal.handle()).toBeUndefined();
    expect(orca.calls).toEqual(["terminal show"]);
    expect(saved()).toBe("term_kept");
  });

  test("losing the terminal is logged once, not on every check", async () => {
    const orca = fakeOrca({ down: true });
    const logs: string[] = [];
    let now = 0;
    const terminal = createOrcaTerminal({
      run: orca.run,
      load: () => undefined,
      save: () => undefined,
      worktree: "path:/work",
      now: () => now,
      ttlMs: 1_000,
      log: (l) => void logs.push(l),
    });
    await terminal.handle();
    now += 1_000;
    await terminal.handle();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("no terminal of my own");
  });

  test("turns that start together share one check and one terminal", async () => {
    const orca = fakeOrca({ next: ["term_1", "term_2"] });
    const { terminal } = setup(orca);
    const all = await Promise.all([terminal.handle(), terminal.handle(), terminal.handle()]);
    expect(all).toEqual(["term_1", "term_1", "term_1"]);
    expect(orca.calls).toEqual(["terminal create"]);
  });

  test("a runner that throws is no handle, not a crash", async () => {
    const { terminal } = setup({
      run: async () => {
        throw new Error("boom");
      },
      calls: [],
      live: new Set(),
    });
    expect(await terminal.handle()).toBeUndefined();
  });
});

describe("createOrcaCli", () => {
  test("a missing binary answers like a runtime that is down", async () => {
    const run = createOrcaCli("/nonexistent/orca-bin");
    expect(await run(["status"])).toEqual({ code: -1, stdout: "" });
  });

  test("a hung orca is stopped at the bound, so it cannot hold a turn", async () => {
    const run = createOrcaCli("/bin/sleep", 100);
    const started = Date.now();
    const r = await run(["5"]);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(r.code).not.toBe(0);
    // and the default bound is short next to a turn
    expect(ORCA_CALL_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });

  test("returns the exit code and stdout", async () => {
    const run = createOrcaCli("/bin/echo");
    expect(await run(["hello"])).toEqual({ code: 0, stdout: "hello\n" });
  });
});
