/**
 * The GitHub App's credentials, read from files outside the repo so no
 * secret has to sit in `.env`. Contents are never logged: a missing piece is
 * reported by name and path only.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type GithubAppCredentials = { appId: string; privateKey: string; webhookSecretPath?: string; webhookSecret?: string };

export type CredentialSources = {
  appId?: string;
  privateKeyPath: string;
  webhookSecret?: string;
  webhookSecretPath: string;
};

const readText = (path: string): string | undefined => {
  try {
    return existsSync(path) ? readFileSync(path, "utf8").trim() || undefined : undefined;
  } catch {
    return undefined;
  }
};

/** The app id from `app.json` beside the key, when no id was configured. */
const idFromAppJson = (privateKeyPath: string): string | undefined => {
  const raw = readText(join(dirname(privateKeyPath), "app.json"));
  if (!raw) return undefined;
  try {
    const id = (JSON.parse(raw) as { id?: unknown }).id;
    return typeof id === "number" || (typeof id === "string" && id) ? String(id) : undefined;
  } catch {
    return undefined;
  }
};

export const loadGithubAppCredentials = (
  src: CredentialSources,
): { ok: true; creds: GithubAppCredentials } | { ok: false; missing: string[] } => {
  const appId = src.appId ?? idFromAppJson(src.privateKeyPath);
  const privateKey = readText(src.privateKeyPath);
  const secretOk = !!src.webhookSecret || !!readText(src.webhookSecretPath);
  const missing = [
    ...(appId ? [] : ["app id (GITHUB_APP_ID or app.json beside the key)"]),
    ...(privateKey ? [] : [`private key (${src.privateKeyPath})`]),
    ...(secretOk ? [] : [`webhook secret (${src.webhookSecretPath})`]),
  ];
  if (!appId || !privateKey || !secretOk) return { ok: false, missing };
  return {
    ok: true,
    creds: src.webhookSecret
      ? { appId, privateKey, webhookSecret: src.webhookSecret }
      : { appId, privateKey, webhookSecretPath: src.webhookSecretPath },
  };
};

/** The secret now: the variable if set, else the file, re-read so a rotation needs no restart. */
export const webhookSecretOf = (creds: GithubAppCredentials): string =>
  creds.webhookSecret ?? (creds.webhookSecretPath ? readText(creds.webhookSecretPath) ?? "" : "");
