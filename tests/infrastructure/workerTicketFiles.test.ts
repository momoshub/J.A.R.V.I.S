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

  test("with a base URL the file's second line says where the bot listens; without one it has the token only", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "wt-")), "worker-tickets");
    const withUrl = createWorkerTicketFiles(dir, "http://127.0.0.1:2002").write("aaaa1111", "jvwk_a");
    expect(readFileSync(withUrl, "utf8")).toBe("jvwk_a\nhttp://127.0.0.1:2002\n");
    const plain = createWorkerTicketFiles(dir).write("bbbb2222", "jvwk_b");
    expect(readFileSync(plain, "utf8")).toBe("jvwk_b\n");
  });
});
