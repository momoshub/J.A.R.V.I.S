/**
 * GitHub App client - the app acting as ITSELF, over plain fetch.
 *
 * Not the `gh` CLI: that is the host human's identity, and everything the app
 * writes must arrive under the app's name. Auth is the documented two-step: an
 * RS256 JWT signed with the app's private key, exchanged for an installation
 * token that is cached until shortly before it expires.
 */
import { createSign } from "node:crypto";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const b64url = (input: string | Buffer): string => Buffer.from(input).toString("base64url");

/**
 * The app's JWT: `iat` a minute in the past (clock drift), `exp` nine minutes
 * ahead (GitHub refuses more than ten), `iss` the app id.
 */
export const createAppJwt = (appId: string, privateKeyPem: string, nowMs: number): string => {
  const now = Math.floor(nowMs / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(privateKeyPem).toString("base64url")}`;
};

/** Refresh an installation token this long before GitHub says it expires. */
export const TOKEN_MARGIN_MS = 5 * 60_000;

export type GithubAppClientConfig = {
  appId: string;
  privateKey: string;
  /** Sent as User-Agent, which GitHub requires. */
  userAgent: string;
  fetch?: FetchLike;
  clock?: () => number;
  apiBase?: string;
};

export type GithubAppClient = {
  installationToken: (installationId: number) => Promise<string>;
  /**
   * A token for ONE worker ticket, never cached or shared: limited to `repo`,
   * and to the permissions git needs (metadata read, contents at the level the
   * installation itself holds - asking for more than it has is a 422). Throws
   * plainly when the installation has no contents permission at all.
   */
  mintWorkerToken: (installationId: number, repo: string) => Promise<{ token: string; expiresAt: number }>;
  /** `DELETE /installation/token`: GitHub stops honouring that token now. Never throws on an already-dead one. */
  revokeInstallationToken: (token: string) => Promise<void>;
  /** Add a reaction at `path` (e.g. `repos/o/r/issues/comments/1/reactions`). */
  react: (installationId: number, path: string, content: string) => Promise<void>;
  /** Comment on an issue or PR conversation; returns the comment's url. */
  comment: (installationId: number, repo: string, number: number, body: string) => Promise<string | undefined>;
  /** The installation the app has on `owner/name`; GitHub's error (404 = not installed) is thrown plainly. */
  installationOfRepo: (repo: string) => Promise<number>;
  /** Any REST call as the app's installation; resolves with GitHub's JSON. */
  request: (installationId: number, method: string, path: string, body?: unknown) => Promise<unknown>;
  /** A GitHub account's display name, for matching to Slack. */
  userName: (installationId: number, login: string) => Promise<string | undefined>;
};

export const createGithubAppClient = (config: GithubAppClientConfig): GithubAppClient => {
  const doFetch: FetchLike = config.fetch ?? ((url, init) => fetch(url, init));
  const clock = config.clock ?? Date.now;
  const api = (config.apiBase ?? "https://api.github.com").replace(/\/$/, "");
  const cache = new Map<number, { token: string; expiresAt: number }>();

  const headers = (auth: string): Record<string, string> => ({
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${auth}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": config.userAgent,
    "Content-Type": "application/json",
  });

  const call = async (auth: string, method: string, path: string, body?: unknown): Promise<unknown> => {
    const res = await doFetch(`${api}/${path.replace(/^\//, "")}`, {
      method,
      headers: headers(auth),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`GitHub ${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
    return text ? (JSON.parse(text) as unknown) : undefined;
  };

  const installationToken = async (installationId: number): Promise<string> => {
    const hit = cache.get(installationId);
    if (hit && hit.expiresAt - TOKEN_MARGIN_MS > clock()) return hit.token;
    const jwt = createAppJwt(config.appId, config.privateKey, clock());
    const out = (await call(jwt, "POST", `app/installations/${installationId}/access_tokens`)) as
      | { token?: unknown; expires_at?: unknown }
      | undefined;
    const token = typeof out?.token === "string" ? out.token : "";
    if (!token) throw new Error("GitHub returned no installation token");
    const expiresAt = typeof out?.expires_at === "string" ? Date.parse(out.expires_at) : NaN;
    // An hour is what GitHub issues; assume it if the answer has no usable date.
    cache.set(installationId, { token, expiresAt: Number.isFinite(expiresAt) ? expiresAt : clock() + 60 * 60_000 });
    return token;
  };

  const installationContents = async (installationId: number): Promise<"read" | "write"> => {
    const jwt = createAppJwt(config.appId, config.privateKey, clock());
    const out = (await call(jwt, "GET", `app/installations/${installationId}`)) as { permissions?: { contents?: unknown } } | undefined;
    const level = out?.permissions?.contents;
    if (level === "read" || level === "write") return level;
    throw new Error("the app has no contents permission on this installation, so there is no git token to hand out");
  };

  const mintWorkerToken = async (installationId: number, repo: string): Promise<{ token: string; expiresAt: number }> => {
    const name = repo.split("/")[1];
    if (!name) throw new Error("a worker token needs owner/repo");
    const contents = await installationContents(installationId);
    const jwt = createAppJwt(config.appId, config.privateKey, clock());
    const out = (await call(jwt, "POST", `app/installations/${installationId}/access_tokens`, {
      repositories: [name],
      permissions: { contents, metadata: "read" },
    })) as { token?: unknown; expires_at?: unknown } | undefined;
    const token = typeof out?.token === "string" ? out.token : "";
    if (!token) throw new Error("GitHub returned no installation token");
    const expiresAt = typeof out?.expires_at === "string" ? Date.parse(out.expires_at) : NaN;
    return { token, expiresAt: Number.isFinite(expiresAt) ? expiresAt : clock() + 60 * 60_000 };
  };

  const revokeInstallationToken = async (token: string): Promise<void> => {
    try {
      await call(token, "DELETE", "installation/token");
    } catch (e) {
      // 401 = already expired or revoked: that is the goal.
      if (!/-> 401/.test(e instanceof Error ? e.message : "")) throw e;
    }
  };

  const installs = new Map<string, number>();
  const installationOfRepo = async (repo: string): Promise<number> => {
    const key = repo.toLowerCase();
    const hit = installs.get(key);
    if (hit) return hit;
    const jwt = createAppJwt(config.appId, config.privateKey, clock());
    const out = (await call(jwt, "GET", `repos/${repo}/installation`)) as { id?: unknown } | undefined;
    if (typeof out?.id !== "number") throw new Error(`GitHub returned no installation for ${repo}`);
    installs.set(key, out.id);
    return out.id;
  };

  return {
    installationToken,
    mintWorkerToken,
    revokeInstallationToken,
    installationOfRepo,
    request: async (installationId, method, path, body) => call(await installationToken(installationId), method, path, body),
    react: async (installationId, path, content) => {
      await call(await installationToken(installationId), "POST", path, { content });
    },
    comment: async (installationId, repo, number, body) => {
      const out = (await call(await installationToken(installationId), "POST", `repos/${repo}/issues/${number}/comments`, {
        body,
      })) as { html_url?: unknown } | undefined;
      return typeof out?.html_url === "string" ? out.html_url : undefined;
    },
    userName: async (installationId, login) => {
      try {
        const out = (await call(await installationToken(installationId), "GET", `users/${encodeURIComponent(login)}`)) as
          | { name?: unknown }
          | undefined;
        return typeof out?.name === "string" && out.name ? out.name : undefined;
      } catch {
        return undefined;
      }
    },
  };
};
