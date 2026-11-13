import { describe, expect, test } from "bun:test";
import { isSecretEnvName, scrubSecretEnv } from "../../src/domain/turnEnv.ts";

describe("turn environment", () => {
  test("names that look like a credential are secret, ordinary ones are not", () => {
    for (const name of [
      "SLACK_BOT_TOKEN",
      "SLACK_APP_TOKEN",
      "ANTHROPIC_API_KEY",
      "GITHUB_APP_WEBHOOK_SECRET",
      "GITHUB_APP_PRIVATE_KEY_PATH",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "AWS_ACCESS_KEY_ID",
      "GH_TOKEN",
      "DB_PASSWORD",
      "SOME_NEW_SERVICE_TOKEN",
      "TOKEN_KEY_PATH",
    ]) {
      expect(isSecretEnvName(name)).toBe(true);
    }
    for (const name of ["PATH", "HOME", "DASHBOARD_PORT", "SLACK_TRANSPORT", "BOT_NAME", "JARVIS_RUN_TICKET", "JARVIS_SLACK_TICKET", "SSH_AUTH_SOCK", "TOKENIZER_MODE", "MONKEY_PATCH"]) {
      expect(isSecretEnvName(name)).toBe(false);
    }
  });

  test("a scrubbed copy has no secret values and keeps everything else", () => {
    const { env, removed } = scrubSecretEnv({
      PATH: "/usr/bin",
      DASHBOARD_PORT: "2002",
      SLACK_BOT_TOKEN: "xoxb-secret-value",
      SLACK_APP_TOKEN: "xapp-secret-value",
      ANTHROPIC_API_KEY: "sk-ant-api-secret",
      GITHUB_APP_WEBHOOK_SECRET: "hook-secret",
      UNSET_TOKEN: undefined,
    });
    expect(env).toEqual({ PATH: "/usr/bin", DASHBOARD_PORT: "2002" });
    expect(JSON.stringify(env)).not.toContain("secret");
    // names only, sorted, and an unset variable is not reported as withheld
    expect(removed).toEqual(["ANTHROPIC_API_KEY", "GITHUB_APP_WEBHOOK_SECRET", "SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"]);
  });

  test("the CLI's own login always stays, and an instance can keep a named variable", () => {
    const env = { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-login", GRAFANA_TOKEN: "glsa-x", SLACK_BOT_TOKEN: "xoxb-y" };
    expect(scrubSecretEnv(env).env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-login" });
    expect(scrubSecretEnv(env, new Set(["GRAFANA_TOKEN"])).env).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-login",
      GRAFANA_TOKEN: "glsa-x",
    });
  });
});
