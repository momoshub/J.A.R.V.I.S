/**
 * `orca ... --json` stdout, trimmed from real output of Orca 1.4.253
 * (`status`, `orchestration run-list --full`, `orchestration task-list --run
 * <id> --full --brief`), so the parsers are tested against what the CLI says.
 */

export const STATUS_READY = JSON.stringify({
  id: "local-status",
  ok: true,
  result: {
    target: { kind: "local" },
    app: { running: true, pid: 56481, desktopWindowStatus: "available" },
    runtime: {
      state: "ready",
      reachable: true,
      connectionState: "connected",
      runtimeId: "37d8f3e6-c591-47f1-bd32-5f5118f1ba27",
      appVersion: "1.4.253",
      capabilities: ["runtime.status.compat.v1"],
    },
    graph: { state: "ready" },
  },
});

export const STATUS_DOWN = JSON.stringify({
  id: "local-status",
  ok: true,
  result: {
    target: { kind: "local" },
    app: { running: false },
    runtime: { state: "not_running", reachable: false },
    graph: { state: "unknown" },
  },
});

export const runList = (
  runs: readonly { id: string; objective: string; created_at?: string }[],
  nextCursor: string | null = null,
): string =>
  JSON.stringify({
    id: "395f0997-e131-4126-ab2f-d0affd00f21c",
    ok: true,
    result: {
      runs: runs.map((r) => ({
        coordinator_handle: "term_b8b1052b-81cf-49d9-92db-3e19bf1bbb92",
        consumer_generation: 1,
        legacy: 0,
        created_at: "2026-11-08T09:57:36Z",
        updated_at: "2026-11-08T09:57:36Z",
        ...r,
      })),
      nextCursor,
    },
    _meta: { runtimeId: "37d8f3e6-c591-47f1-bd32-5f5118f1ba27" },
  });

export const taskList = (
  runId: string,
  tasks: readonly { id: string; task_title: string; status: string; created_at?: string }[],
): string =>
  JSON.stringify({
    id: "cdc23abc-c996-4899-86bc-3a68ce3f0224",
    ok: true,
    result: {
      runId,
      legacyReadOnly: false,
      tasks: tasks.map((t) => ({
        run_id: runId,
        parent_id: null,
        display_name: t.task_title,
        spec: "# Task: something long enough to be capped by --brief…",
        deps: "[]",
        result: null,
        created_at: "2026-11-08 09:57:36",
        completed_at: null,
        assignee_handle: "term_c3df2705-e8fd-4d33-968c-7a54225d909b",
        dispatch_id: "ctx_0211d8cc641b",
        spec_truncated: true,
        ...t,
      })),
      count: tasks.length,
    },
  });

export const RUN_NOT_FOUND = JSON.stringify({
  ok: false,
  error: { code: "run_not_found", message: "Run run_nonexist was not found." },
});
