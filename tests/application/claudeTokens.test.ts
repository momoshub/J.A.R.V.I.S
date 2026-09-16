import { describe, expect, test } from "bun:test";
import {
  decodeRequest,
  encodeRequest,
  submitClaudeToken,
  tokenFor,
  type ClaudeTokenPort,
} from "../../src/application/claudeTokens.ts";
import { isClaudeToken, tokenHint, TOKEN_PREFIX } from "../../src/domain/claudeToken.ts";
import {
  createClaudeTokenRepo,
  loadOrCreateKey,
  openTokenDatabase,
} from "../../src/infrastructure/db/claudeTokenRepo.ts";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const TOKEN = `${TOKEN_PREFIX}${"a".repeat(48)}`;

describe("isClaudeToken", () => {
  test("accepts a real setup token", () => {
    expect(isClaudeToken(TOKEN)).toBe(true);
    expect(isClaudeToken(`  ${TOKEN}  `)).toBe(true);
  });

  test("refuses an API key, a stub, and anything with whitespace in it", () => {
    // an api key is a different credential with different billing - storing one
    // here would bill the wrong thing and never be noticed
    expect(isClaudeToken("sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(false);
    expect(isClaudeToken(`${TOKEN_PREFIX}short`)).toBe(false);
    expect(isClaudeToken(`${TOKEN_PREFIX}aaaa bbbb${"c".repeat(40)}`)).toBe(false);
    expect(isClaudeToken(undefined)).toBe(false);
    expect(isClaudeToken("")).toBe(false);
  });
});

test("tokenHint shows four characters and nothing more", () => {
  const hint = tokenHint(TOKEN);
  expect(hint).toBe("…aaaa");
  expect(hint).not.toContain(TOKEN_PREFIX);
});

describe("the request a button carries", () => {
  test("round-trips what the blocked command needs to resume", () => {
    const req = { channelId: "C1", threadTs: "123.45", line: "review https://github.com/o/r/pull/1" };
    expect(decodeRequest(encodeRequest(req))).toEqual(req);
  });

  test("survives junk, so a bad payload still lets the token be saved", () => {
    expect(decodeRequest(undefined)).toBeUndefined();
    expect(decodeRequest("not json")).toBeUndefined();
    expect(decodeRequest("{}")).toBeUndefined(); // no channel = nothing to resume
    expect(decodeRequest('{"channelId":"C1"}')).toEqual({ channelId: "C1", threadTs: undefined, line: undefined });
  });
});

const memoryStore = (): ClaudeTokenPort => {
  const map = new Map<string, string>();
  return {
    get: (id) => map.get(id),
    has: (id) => map.has(id),
    set: (id, t) => {
      map.set(id, t);
    },
    remove: (id) => {
      map.delete(id);
    },
    count: () => map.size,
  };
};

describe("submitClaudeToken", () => {
  test("stores a good token and hands back what to resume", () => {
    const claudeTokens = memoryStore();
    const request = { channelId: "C1", line: "review x" };
    const out = submitClaudeToken({ claudeTokens }, { slackUserId: "U1", token: ` ${TOKEN} `, request });
    expect(out).toEqual({ kind: "saved", request });
    expect(claudeTokens.get("U1")).toBe(TOKEN); // trimmed
  });

  test("refuses an API key by name, and stores nothing", () => {
    const claudeTokens = memoryStore();
    const out = submitClaudeToken({ claudeTokens }, { slackUserId: "U1", token: "sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" });
    expect(out.kind).toBe("invalid");
    expect(out.kind === "invalid" && out.error).toContain("API key");
    expect(claudeTokens.count()).toBe(0);
  });

  test("refuses junk without pretending it worked", () => {
    const claudeTokens = memoryStore();
    const out = submitClaudeToken({ claudeTokens }, { slackUserId: "U1", token: "hello" });
    expect(out.kind).toBe("invalid");
    expect(claudeTokens.count()).toBe(0);
  });

  test("says so when there is nowhere to store it", () => {
    expect(submitClaudeToken({}, { slackUserId: "U1", token: TOKEN })).toEqual({ kind: "no-store" });
  });
});

test("tokenFor is the speaker's own token, or nothing", () => {
  const claudeTokens = memoryStore();
  claudeTokens.set("U1", TOKEN);
  expect(tokenFor({ claudeTokens }, { slackId: "U1" })).toBe(TOKEN);
  expect(tokenFor({ claudeTokens }, { slackId: "U2" })).toBeUndefined();
  expect(tokenFor({}, { slackId: "U1" })).toBeUndefined();
  expect(tokenFor({ claudeTokens })).toBeUndefined();
});

describe("the token repository", () => {
  const repo = (key = randomBytes(32)) => ({
    store: createClaudeTokenRepo(openTokenDatabase(":memory:"), key, () => 1000),
    key,
  });

  test("round-trips a token through encryption", () => {
    const { store } = repo();
    store.set("U1", TOKEN);
    expect(store.get("U1")).toBe(TOKEN);
    expect(store.has("U1")).toBe(true);
    expect(store.count()).toBe(1);
  });

  test("what is written to disk is not the token", () => {
    const db = openTokenDatabase(":memory:");
    createClaudeTokenRepo(db, randomBytes(32)).set("U1", TOKEN);
    const row = db.query<{ sealed: string }, []>("SELECT sealed FROM claude_tokens").get();
    expect(row?.sealed).toBeDefined();
    expect(row!.sealed).not.toContain(TOKEN);
    expect(row!.sealed).not.toContain(TOKEN_PREFIX);
  });

  test("a row that will not open reads as no token, rather than throwing", () => {
    // what a rotated or lost key looks like, mid-review
    const db = openTokenDatabase(":memory:");
    createClaudeTokenRepo(db, randomBytes(32)).set("U1", TOKEN);
    const other = createClaudeTokenRepo(db, randomBytes(32));
    expect(other.get("U1")).toBeUndefined();
    expect(other.has("U1")).toBe(false);
  });

  test("a replaced token overwrites, and remove forgets", () => {
    const { store } = repo();
    const second = `${TOKEN_PREFIX}${"b".repeat(48)}`;
    store.set("U1", TOKEN);
    store.set("U1", second);
    expect(store.get("U1")).toBe(second);
    store.remove("U1");
    expect(store.get("U1")).toBeUndefined();
    expect(store.count()).toBe(0);
  });

  test("the key file is created 0600 and reused on the next boot", () => {
    const dir = mkdtempSync(join(tmpdir(), "ev-token-"));
    const path = join(dir, "tokens.key");
    const first = loadOrCreateKey(path);
    expect(first).toHaveLength(32);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadOrCreateKey(path).toString("base64")).toBe(first.toString("base64"));
    // and it is the key itself on disk, not anything derived at read time
    expect(readFileSync(path, "utf8").trim()).toBe(first.toString("base64"));
  });
});
