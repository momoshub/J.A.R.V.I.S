import { describe, expect, test } from "bun:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { createAppJwt, createGithubAppClient, type FetchLike } from "../../../src/infrastructure/github/appClient.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const NOW = Date.parse("2026-11-07T10:00:00Z");
const part = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as Record<string, unknown>;

describe("createAppJwt", () => {
  test("is an RS256 JWT issued by the app, backdated a minute, valid under ten", () => {
    const jwt = createAppJwt("5656903", privateKey, NOW);
    const [h, p, sig] = jwt.split(".");
    expect(part(h!)).toEqual({ alg: "RS256", typ: "JWT" });
    const payload = part(p!);
    const now = NOW / 1000;
    expect(payload.iss).toBe("5656903");
    expect(payload.iat).toBe(now - 60);
    expect(payload.exp).toBe(now + 540);
    expect((payload.exp as number) - (payload.iat as number)).toBeLessThanOrEqual(600);
    const v = createVerify("RSA-SHA256");
    v.update(`${h}.${p}`);
    expect(v.verify(publicKey, Buffer.from(sig!, "base64url"))).toBe(true);
  });
});

describe("createGithubAppClient", () => {
  const setup = () => {
    const calls: { url: string; method: string; auth: string; body?: string }[] = [];
    let now = NOW;
    const fetchFn: FetchLike = async (url, init) => {
      const headers = init.headers as Record<string, string>;
      calls.push({ url, method: String(init.method), auth: headers.Authorization ?? "", body: init.body as string | undefined });
      if (url.endsWith("/access_tokens")) {
        return Response.json({ token: `ghs_${calls.length}`, expires_at: new Date(now + 60 * 60_000).toISOString() }, { status: 201 });
      }
      if (url.includes("/comments")) return Response.json({ html_url: "https://github.com/o/r/issues/1#c" }, { status: 201 });
      return Response.json({ name: "Dev Person" });
    };
    const client = createGithubAppClient({ appId: "1", privateKey, userAgent: "t", fetch: fetchFn, clock: () => now });
    return { client, calls, advance: (ms: number) => (now += ms) };
  };

  test("exchanges a JWT for an installation token and caches it until near expiry", async () => {
    const { client, calls, advance } = setup();
    const t1 = await client.installationToken(42);
    expect(calls[0]?.url).toBe("https://api.github.com/app/installations/42/access_tokens");
    expect(calls[0]?.auth.split(".").length).toBe(3);
    expect(await client.installationToken(42)).toBe(t1);
    expect(calls.length).toBe(1);
    advance(56 * 60_000);
    expect(await client.installationToken(42)).not.toBe(t1);
    expect(calls.length).toBe(2);
  });

  test("comments and reacts with the installation token", async () => {
    const { client, calls } = setup();
    const url = await client.comment(42, "o/r", 1, "hello");
    expect(url).toBe("https://github.com/o/r/issues/1#c");
    await client.react(42, "repos/o/r/issues/comments/9/reactions", "eyes");
    const comment = calls.find((c) => c.url.endsWith("/repos/o/r/issues/1/comments"));
    expect(comment?.auth).toMatch(/^Bearer ghs_/);
    expect(JSON.parse(comment!.body!)).toEqual({ body: "hello" });
    expect(JSON.parse(calls.at(-1)!.body!)).toEqual({ content: "eyes" });
  });
});
