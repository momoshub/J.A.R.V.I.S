import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGhCli } from "../../../src/infrastructure/github/ghCli.ts";

const dir = mkdtempSync(join(tmpdir(), "ghcli-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A `gh` that answers from a script: `user` for the account, `view` for the PR, and records the rest. */
const fakeGh = (name: string, view: string, opts: { exit?: number; err?: string } = {}) => {
  const bin = join(dir, name);
  const log = join(dir, `${name}.log`);
  writeFileSync(
    bin,
    `#!/bin/sh
echo "$@" >> '${log}'
case "$1 $2" in
  "api user") echo '{"login":"Kai-At-Acme","name":"Kai"}';;
  "pr view") cat <<'EOF2'
${view}
EOF2
;;
  *) ${opts.err ? `echo '${opts.err}' >&2;` : ""} exit ${opts.exit ?? 0};;
esac
`,
  );
  chmodSync(bin, 0o755);
  return { bin, log };
};

const URL = "https://github.com/o/r/pull/1";

describe("gh snapshot", () => {
  test("reads state, CI, the decision and our own latest review (login compared without case)", async () => {
    const { bin } = fakeGh(
      "gh1",
      JSON.stringify({
        state: "OPEN",
        reviewDecision: "CHANGES_REQUESTED",
        statusCheckRollup: [
          { name: "checks", status: "COMPLETED", conclusion: "FAILURE" },
          { name: "e2e", status: "IN_PROGRESS", conclusion: "" },
        ],
        latestReviews: [
          { author: { login: "someone" }, state: "APPROVED" },
          { author: { login: "kai-at-acme" }, state: "CHANGES_REQUESTED" },
        ],
      }),
    );
    const snap = await createGhCli({ binPath: bin }).snapshot?.(URL);
    expect(snap).toEqual({
      state: "OPEN",
      ci: { verdict: "red", failed: ["checks"] },
      decision: "CHANGES_REQUESTED",
      mine: "CHANGES_REQUESTED",
    });
  });

  test("no checks and no reviews is green with no review of ours", async () => {
    const { bin } = fakeGh("gh2", JSON.stringify({ state: "MERGED", reviewDecision: "", statusCheckRollup: [], latestReviews: [] }));
    const snap = await createGhCli({ binPath: bin }).snapshot?.(URL);
    expect(snap).toEqual({ state: "MERGED", ci: { verdict: "green", failed: [] }, decision: undefined, mine: undefined });
  });

  test("gh failing, or printing something that is not a PR, is undefined and never throws", async () => {
    const failing = join(dir, "gh3");
    writeFileSync(failing, "#!/bin/sh\nexit 1\n");
    chmodSync(failing, 0o755);
    expect(await createGhCli({ binPath: failing }).snapshot?.(URL)).toBeUndefined();
    const { bin } = fakeGh("gh4", "not json");
    expect(await createGhCli({ binPath: bin }).snapshot?.(URL)).toBeUndefined();
    const { bin: bin2 } = fakeGh("gh5", JSON.stringify({ state: "WEIRD" }));
    expect(await createGhCli({ binPath: bin2 }).snapshot?.(URL)).toBeUndefined();
  });
});

describe("gh requestChanges", () => {
  test("submits a request-changes review with the body", async () => {
    const { bin, log } = fakeGh("gh6", "{}");
    const res = await createGhCli({ binPath: bin }).requestChanges?.(URL, "requested changes: CI is red");
    expect(res).toEqual({ ok: true });
    expect(await Bun.file(log).text()).toContain(`pr review ${URL} --request-changes --body requested changes: CI is red`);
  });

  test("a refusal comes back as a reportable error", async () => {
    const { bin } = fakeGh("gh7", "{}", { exit: 1, err: "GraphQL: not allowed" });
    const res = await createGhCli({ binPath: bin }).requestChanges?.(URL, "x");
    expect(res).toEqual({ ok: false, error: "GraphQL: not allowed" });
  });
});
