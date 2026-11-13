/**
 * Which environment variables an agent turn may inherit.
 *
 * A turn is a `claude -p` process whose Bash tool is driven by a model that
 * reads untrusted text (messages, web pages, files). Anything in that process's
 * environment is one `env` or one `curl` away from leaving the host, so the
 * turn gets the bot's environment MINUS its secrets. What a turn needs from
 * Slack goes through the ticketed local proxy instead (`slackProxy`), which
 * holds the token on the bot's side.
 *
 * The rule is by NAME, not a list of today's variables: a new `*_TOKEN` added
 * to `.env` next month is withheld without anyone remembering to add it here.
 * `CLAUDE_CODE_OAUTH_TOKEN` is the one exception built in - the CLI cannot
 * authenticate without it. An instance that really needs another secret-shaped
 * variable inside turns names it in `TURN_ENV_PASSTHROUGH`.
 */

/** A word of the name is one of these (`SOME_SERVICE_TOKEN`, `DB_SECRET_X`, `AWS_SECRET_ACCESS_KEY`). Bounded, so `TOKENIZERS_PARALLELISM` is not caught. */
const SECRET_WORD = /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?)(_|$)/i;
/** A password glued to a prefix with no underscore: `PGPASSWORD`. */
const GLUED_PASSWORD = /PASS(WORD|WD|PHRASE)/i;
/** Names that end in a credential word: `OPENAI_KEY`, `GITHUB_PAT`, `MYSQL_PWD`, `NPM_CONFIG__AUTH`. Not the shell's own `PWD`/`OLDPWD`, not `SSH_AUTH_SOCK`. */
const SECRET_SUFFIX = /_(KEY|PAT|PWD|AUTH)$/i;

/** Secret-shaped names a turn still needs: the CLI's own login. */
export const TURN_ENV_ALWAYS_KEEP: ReadonlySet<string> = new Set(["CLAUDE_CODE_OAUTH_TOKEN"]);

export const isSecretEnvName = (name: string): boolean =>
  SECRET_WORD.test(name) || GLUED_PASSWORD.test(name) || SECRET_SUFFIX.test(name);

export type ScrubbedEnv = {
  readonly env: Record<string, string | undefined>;
  /** Names that were withheld (never values), for the boot log. */
  readonly removed: readonly string[];
};

/** A copy of `env` without anything credential-shaped, except what `keep` names. */
export const scrubSecretEnv = (
  env: Readonly<Record<string, string | undefined>>,
  keep: ReadonlySet<string> = new Set(),
): ScrubbedEnv => {
  const out: Record<string, string | undefined> = {};
  const removed: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (isSecretEnvName(name) && !TURN_ENV_ALWAYS_KEEP.has(name) && !keep.has(name)) {
      if (value !== undefined) removed.push(name);
      continue;
    }
    out[name] = value;
  }
  return { env: out, removed: removed.sort() };
};
