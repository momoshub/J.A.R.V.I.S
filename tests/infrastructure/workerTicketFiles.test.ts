import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkerTicketFiles } from "../../src/infrastructure/system/workerTicketFiles.ts";

describe("worker ticket files", () => {
  test("the token is written 0600 in a 0700 dir, by path, and removed when the ticket ends", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "wt-")), "worker-tickets");
    const files = createWorkerTicketFiles(dir);
    const path = files.write("abcd1234", "jvwk_secret");
    expect(path).toBe(join(dir, "abcd1234"));
    expect(readFileSync(path, "utf8").trim()).toBe("jvwk_secret");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    files.remove("abcd1234");
    expect(existsSync(path)).toBe(false);
    files.remove("abcd1234");
  });
});
