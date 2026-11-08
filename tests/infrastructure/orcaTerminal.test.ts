import { describe, expect, test } from "bun:test";
import {
  createdHandleOf,
  createOrcaCli,
  createOrcaTerminal,
  isLiveHandle,
  type OrcaRun,
} from "../../src/infrastructure/system/orcaTerminal.ts";

const shown = (handle: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ ok: true, result: { terminal: { handle, orphaned: false, ...extra } } });
const stale = JSON.stringify({ ok: false, error: { code: "terminal_handle_stale" } });

/** A scripted Orca: which handles are live, what `create` issues next, every call made. */
const fakeOrca = (opts: { live?: string[]; next?: string[]; down?: boolean }) => {
  const live = new Set(opts.live ?? []);
  const next = [...(opts.next ?? [])];
  const calls: string[] = [];
  const run: OrcaRun = async (args) => {
    calls.push(args.slice(0, 2).join(" "));
    if (opts.down) return { code: 1, stdout: "" };
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
    expect(isLiveHandle(shown("term_a"), "term_a")).toBe(true);
    expect(isLiveHandle(shown("term_a"), "term_b")).toBe(false);
    expect(isLiveHandle(shown("term_a", { orphaned: true }), "term_a")).toBe(false);
    expect(isLiveHandle(stale, "term_a")).toBe(false);
    expect(isLiveHandle("not json", "term_a")).toBe(false);
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
    expect(orca.calls).toEqual(["terminal show", "terminal create"]);
    // the kept handle is not thrown away: it is still good if Orca was only busy
    expect(saved()).toBe("term_kept");
    tick(1_000);
    await terminal.handle();
    expect(orca.calls.length).toBe(4);
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

  test("returns the exit code and stdout", async () => {
    const run = createOrcaCli("/bin/echo");
    expect(await run(["hello"])).toEqual({ code: 0, stdout: "hello\n" });
  });
});
