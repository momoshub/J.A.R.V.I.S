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

describe("createGithubAppClient: actions", () => {
  const setup = (installStatus = 200) => {
    const calls: { url: string; method: string; auth: string; body?: string }[] = [];
    const fetchFn: FetchLike = async (url, init) => {
      const headers = init.headers as Record<string, string>;
      calls.push({ url, method: String(init.method), auth: headers.Authorization ?? "", body: init.body as string | undefined });
      if (url.endsWith("/installation")) {
        return installStatus === 200
          ? Response.json({ id: 77 })
          : new Response('{"message":"Not Found"}', { status: installStatus });
      }
      if (url.endsWith("/access_tokens")) {
        return Response.json({ token: "ghs_x", expires_at: new Date(NOW + 3_600_000).toISOString() }, { status: 201 });
      }
      if (url.endsWith("/pulls")) return Response.json({ html_url: "https://github.com/o/r/pull/9", number: 9 }, { status: 201 });
      return new Response('{"message":"Resource not accessible by integration"}', { status: 403 });
    };
    return { calls, client: createGithubAppClient({ appId: "1", privateKey, userAgent: "t", fetch: fetchFn, clock: () => NOW }) };
  };

  test("finds a repo's installation with the app JWT, once", async () => {
    const { client, calls } = setup();
    expect(await client.installationOfRepo("acme/acme-api")).toBe(77);
    expect(await client.installationOfRepo("Acme/acme-api")).toBe(77);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.github.com/repos/acme/acme-api/installation");
    expect(calls[0]?.auth.split(".")).toHaveLength(3);
  });

  test("an app that is not installed says GitHub's own 404", async () => {
    const { client } = setup(404);
    await expect(client.installationOfRepo("x/y")).rejects.toThrow("404");
  });

  test("request sends the method, path and body under the installation token and returns the JSON", async () => {
    const { client, calls } = setup();
    const out = await client.request(77, "POST", "repos/o/r/pulls", { title: "T" });
    expect(out).toEqual({ html_url: "https://github.com/o/r/pull/9", number: 9 });
    const call = calls.at(-1);
    expect(call).toMatchObject({ method: "POST", url: "https://api.github.com/repos/o/r/pulls", auth: "Bearer ghs_x" });
    expect(JSON.parse(call!.body!)).toEqual({ title: "T" });
  });

  test("a missing permission comes back as GitHub's message", async () => {
    const { client } = setup();
    await expect(client.request(77, "PUT", "repos/o/r/pulls/1/merge", {})).rejects.toThrow("Resource not accessible by integration");
  });
});
