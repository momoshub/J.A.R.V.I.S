/**
 * The `cloudwatch` command: Logs Insights queries run by the bot itself.
 *
 * CloudWatch bills per GB scanned, so a model that reaches for `aws logs` on
 * its own turns an idle question into an invoice. That path stays denied
 * (`ALWAYS_DISALLOW`); this is the one door, and it is guarded in code:
 *
 * - `owner` is warned about the cost and then runs straight away
 * - `executer` and `admin` never run immediately: the request is parked and a
 *   Confirm / Cancel message is posted, and only the requester (or the owner)
 *   may confirm it
 * - anyone else is refused, naming who can
 *
 * Everything here is pure: parsing, the cost estimate, the wording, the role
 * rule. The `aws` calls live in `infrastructure/aws`, the parked requests in
 * `infrastructure/db/cloudwatchRepo.ts`.
 */
import { redactSecrets } from "./toolVisibility.ts";
import type { UserRole } from "./types.ts";

/** Region used when none is given: where the US prod backend logs live. */
export const DEFAULT_REGION = "us-west-2";
/** Window used when none is given. */
export const DEFAULT_RANGE_MS = 60 * 60_000;
/** Longest window accepted at all; older than that nobody keeps logs. */
export const MAX_RANGE_MS = 400 * 86_400_000;
/** Longer than this is flagged as costly (owner: "range over 3 weeks"). */
export const COSTLY_RANGE_MS = 21 * 86_400_000;
/** List price of a Logs Insights scan, USD per GB. */
export const USD_PER_GB = 0.005;
/** Rows asked of Insights when none is given, and the most that can be asked. */
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 1000;
/** How long a Confirm / Cancel message stays live. */
export const CONFIRM_TTL_MS = 15 * 60_000;
/** Insights queries over this many log groups are refused (the API takes 50). */
export const MAX_GROUPS = 10;
/** Longest query accepted: the Confirm message shows it whole, so what is confirmed is what runs. */
export const MAX_QUERY_CHARS = 1500;

/** Button ids. `jv:` like every element of ours, but handled in code, never sent to the model. */
export const CODE_ACTION_PREFIX = "jv:cloudwatch:";
export const CONFIRM_ACTION = `${CODE_ACTION_PREFIX}confirm`;
export const CANCEL_ACTION = `${CODE_ACTION_PREFIX}cancel`;

const DAY_MS = 86_400_000;

/** What a role gets when it asks for a query. */
export type CloudwatchMode = "run" | "confirm" | "refuse";

export const cloudwatchMode = (role: UserRole): CloudwatchMode =>
  role === "owner" ? "run" : role === "admin" || role === "executer" ? "confirm" : "refuse";

/** Said to a role that may not use the command at all. */
export const refusal = (role: UserRole): string =>
  `*${role}* cannot run CloudWatch queries. *executer* and *admin* can, after pressing Confirm on the cost warning, and the *owner* can run one directly.`;

export type CloudwatchRequest = {
  groups: string[];
  region: string;
  query: string;
  startMs: number;
  endMs: number;
  limit: number;
};

export type ParseOk = { ok: true; request: CloudwatchRequest };
export type ParseError = { ok: false; error: string };

/** Slack escapes `<`, `>` and `&` in message text; an Insights query uses all three. */
export const unescapeSlack = (text: string): string =>
  text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

/** `15m`, `2h`, `3d`, `1w` as milliseconds; undefined for anything else. */
export const parseSpan = (token: string): number | undefined => {
  const m = token.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)([mhdw])$/);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2] === "m" ? 60_000 : m[2] === "h" ? 3_600_000 : m[2] === "d" ? DAY_MS : 7 * DAY_MS;
  return n > 0 ? Math.round(n * unit) : undefined;
};

const parseTime = (token: string): number | undefined => {
  const ms = Date.parse(token);
  return Number.isFinite(ms) ? ms : undefined;
};

const splitGroups = (value: string): string[] =>
  value
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean);

/** A log group name as AWS allows it, and starting with `/` so a stray word is not taken for one. */
const GROUP_NAME = /^\/[A-Za-z0-9_\-/.#]{1,511}$/;
const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d$/;

export type ParseDefaults = { region?: string; group?: string };

/**
 * `[--group <log group>[,<log group>]] [--last 15m | --from <time> [--to <time>]]
 * [--region r] [--limit n] <insights query>`. Flags come first, everything
 * after them is the query - which may itself contain `|`, quotes and `--`.
 */
export const parseCloudwatchArgs = (
  args: readonly string[],
  now: number,
  defaults: ParseDefaults = {},
): ParseOk | ParseError => {
  const groups: string[] = [];
  let region = defaults.region ?? DEFAULT_REGION;
  let last: number | undefined;
  let from: number | undefined;
  let to: number | undefined;
  let limit = DEFAULT_LIMIT;

  let i = 0;
  const value = (): string | undefined => {
    i += 1;
    const v = args[i];
    return v === undefined ? undefined : (i += 1, v);
  };
  while (i < args.length && /^--?[a-z]/i.test(args[i] ?? "")) {
    const raw = args[i] ?? "";
    const eq = raw.indexOf("=");
    const flag = (eq > 0 ? raw.slice(0, eq) : raw).replace(/^-+/, "").toLowerCase();
    // `--flag=value` and `--flag value` both work.
    const inline = eq > 0 ? raw.slice(eq + 1) : undefined;
    const take = (): string | undefined => (inline !== undefined ? (i += 1, inline) : value());
    if (flag === "group" || flag === "g" || flag === "log-group") {
      const v = take();
      if (!v) return { ok: false, error: "`--group` needs a log group name" };
      groups.push(...splitGroups(v));
    } else if (flag === "last" || flag === "range") {
      const v = take();
      last = v ? parseSpan(v) : undefined;
      if (last === undefined) return { ok: false, error: "`--last` takes a span like `15m`, `2h`, `3d` or `1w`" };
    } else if (flag === "from") {
      const v = take();
      from = v ? parseTime(v) : undefined;
      if (from === undefined) return { ok: false, error: "`--from` takes a time like `2026-11-10T08:00:00Z`" };
    } else if (flag === "to") {
      const v = take();
      to = v ? parseTime(v) : undefined;
      if (to === undefined) return { ok: false, error: "`--to` takes a time like `2026-11-10T09:00:00Z`" };
    } else if (flag === "region" || flag === "r") {
      const v = take();
      if (!v || !REGION.test(v)) return { ok: false, error: "`--region` takes an AWS region like `us-west-2`" };
      region = v;
    } else if (flag === "limit" || flag === "n") {
      const v = take();
      const n = Number(v);
      if (!v || !Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
        return { ok: false, error: `\`--limit\` takes a whole number from 1 to ${MAX_LIMIT}` };
      }
      limit = n;
    } else {
      return { ok: false, error: `I do not know the flag \`${raw}\`` };
    }
  }

  const query = unescapeSlack(args.slice(i).join(" ")).trim();
  if (!query) return { ok: false, error: "Which query? Everything after the flags is the Logs Insights query" };
  if (query.length > MAX_QUERY_CHARS) return { ok: false, error: `That query is ${query.length} characters; the limit is ${MAX_QUERY_CHARS} so the Confirm message can show all of it` };
  if (last !== undefined && (from !== undefined || to !== undefined)) {
    return { ok: false, error: "Use `--last` or `--from`/`--to`, not both" };
  }
  if (groups.length === 0 && defaults.group) groups.push(...splitGroups(defaults.group));
  if (groups.length === 0) return { ok: false, error: "Which log group? `--group /ecs/<name>`" };
  const unique = [...new Set(groups)];
  if (unique.length > MAX_GROUPS) return { ok: false, error: `At most ${MAX_GROUPS} log groups per query` };
  const bad = unique.find((g) => !GROUP_NAME.test(g));
  if (bad) return { ok: false, error: `\`${bad}\` is not a log group name (they start with \`/\`, like \`/ecs/my-service\`)` };

  const endMs = to ?? now;
  const startMs = from ?? endMs - (last ?? DEFAULT_RANGE_MS);
  if (startMs >= endMs) return { ok: false, error: "The range is empty: `--from` must be before `--to`" };
  if (endMs - startMs > MAX_RANGE_MS) return { ok: false, error: "That range is longer than any log group keeps" };

  return { ok: true, request: { groups: unique, region, query, startMs, endMs, limit } };
};

/** What `describe-log-groups` says about one group. */
export type GroupInfo = {
  name: string;
  storedBytes: number;
  /** Absent: the group never expires. */
  retentionDays?: number;
  /** Epoch ms the group was created, so a never-expiring group has an age. */
  createdAt?: number;
};

/**
 * Bytes a scan of `rangeMs` will roughly read, assuming a group's stored bytes
 * are spread evenly over what it keeps. Stored bytes are compressed and a scan
 * reads the original, so it is a floor in spirit; it is there to tell a 15
 * minute look from a 3 week one, not to predict the invoice.
 */
export const estimateScanBytes = (groups: readonly GroupInfo[], rangeMs: number, now: number): number =>
  Math.round(
    groups.reduce((sum, g) => {
      const age = g.createdAt ? Math.max(DAY_MS, now - g.createdAt) : undefined;
      const keptMs = g.retentionDays
        ? Math.min(g.retentionDays * DAY_MS, age ?? Infinity)
        : (age ?? 365 * DAY_MS);
      return sum + g.storedBytes * Math.min(1, rangeMs / keptMs);
    }, 0),
  );

export const costUsd = (bytes: number): number => (bytes / 1e9) * USD_PER_GB;

export const isCostlyRange = (rangeMs: number): boolean => rangeMs > COSTLY_RANGE_MS;

export const formatBytes = (bytes: number): string =>
  bytes >= 1e12 ? `${(bytes / 1e12).toFixed(2)} TB` : bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.round(bytes / 1e3)} KB`;

export const formatUsd = (usd: number): string => (usd < 0.01 ? "under $0.01" : `$${usd.toFixed(2)}`);

export const formatSpan = (ms: number): string => {
  const mins = Math.round(ms / 60_000);
  if (mins < 120) return `${mins} min`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(ms / DAY_MS)} days`;
};

const stamp = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")}Z`;

/** A query inside a code fence cannot be allowed to close it. */
const fenced = (text: string, max = 600): string => {
  const clipped = text.length > max ? `${text.slice(0, max)}...` : text;
  return `\`\`\`${clipped.replaceAll("```", "'''")}\`\`\``;
};

export type Estimate = { bytes: number; usd: number; costly: boolean; rangeMs: number };

export const estimateOf = (request: CloudwatchRequest, groups: readonly GroupInfo[], now: number): Estimate => {
  const rangeMs = request.endMs - request.startMs;
  const bytes = estimateScanBytes(groups, rangeMs, now);
  return { bytes, usd: costUsd(bytes), costly: isCostlyRange(rangeMs), rangeMs };
};

/** The cost warning, the same words whether it precedes a button or a direct run. */
export const costWarning = (e: Estimate): string =>
  `${e.costly ? "⚠️ *Costly range* - over 3 weeks. " : "💸 "}CloudWatch bills per GB scanned: roughly *${formatBytes(e.bytes)}* (about ${formatUsd(e.usd)}) over ${formatSpan(e.rangeMs)}. A rough estimate from the log group size, not a quote.`;

/** What is about to run: query, group(s), range, region. */
export const requestSummary = (r: CloudwatchRequest): string =>
  [
    `*Log group:* ${r.groups.map((g) => `\`${g}\``).join(", ")} (${r.region})`,
    `*Range:* ${stamp(r.startMs)} → ${stamp(r.endMs)}`,
    `*Query:* ${fenced(r.query, MAX_QUERY_CHARS)}`,
    `*Rows:* up to ${r.limit}`,
  ].join("\n");

/** The text a Confirm / Cancel message carries; the buttons are added by the poster. */
export const confirmText = (requester: string, r: CloudwatchRequest, e: Estimate, ttlMs = CONFIRM_TTL_MS): string =>
  `🔎 <@${requester}> wants to run a CloudWatch query. Nothing runs until it is confirmed.\n${requestSummary(r)}\n${costWarning(e)}\nOnly <@${requester}> or the owner can confirm. Expires in ${Math.round(ttlMs / 60_000)} min.`;

/** The message after a press, in place of the buttons. */
export const settledText = (kind: "confirmed" | "cancelled" | "expired", by?: string): string =>
  kind === "confirmed"
    ? `✅ confirmed by <@${by}> - running the query`
    : kind === "cancelled"
      ? `❌ cancelled by <@${by}> - nothing ran`
      : "⌛ expired - nothing ran. Ask again if you still need it";

export type QueryResult = {
  status: string;
  /** Field -> value per row, in the order Insights returned them (`@ptr` already dropped). */
  rows: { field: string; value: string }[][];
  bytesScanned: number;
  recordsMatched: number;
  recordsScanned: number;
};

const CELL_MAX = 300;
const ROW_MAX = 700;
const ROWS_MAX = 25;
const BODY_MAX = 2800;

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 3)}...` : text);

/**
 * A result sized for a Slack message: at most `ROWS_MAX` rows, each cell and
 * row clipped, the whole body under `BODY_MAX`, secrets redacted (a bunyan
 * request line carries the caller's cookie), and a line saying what was left
 * out so a clipped answer never reads as the whole one.
 */
export const formatResult = (r: CloudwatchRequest, res: QueryResult, mode: "confirm" | "run", by: string): string => {
  const head = `${res.status === "Complete" ? "📋" : "⚠️"} CloudWatch ${res.status.toLowerCase()} - ${res.rows.length} row${res.rows.length === 1 ? "" : "s"}, scanned ${formatBytes(res.bytesScanned)} (${formatUsd(costUsd(res.bytesScanned))}), ${res.recordsMatched.toLocaleString("en-US")} matched`;
  const lines: string[] = [];
  let used = 0;
  let shown = 0;
  for (const row of res.rows.slice(0, ROWS_MAX)) {
    // One field alone reads as its value; several read as field=value.
    const line = clip(
      redactSecrets(
        row.length === 1
          ? (row[0]?.value ?? "")
          : row.map((c) => `${c.field}=${clip(c.value.replace(/\s+/g, " "), CELL_MAX)}`).join(" | "),
      ).replace(/\s*\n\s*/g, " "),
      ROW_MAX,
    );
    if (used + line.length + 1 > BODY_MAX && shown > 0) break;
    lines.push(line);
    used += line.length + 1;
    shown += 1;
  }
  const left = res.rows.length - shown;
  const body = shown > 0 ? fenced(lines.join("\n"), BODY_MAX + 50) : "_no rows_";
  const note =
    left > 0 ? `\n_${left} more row${left === 1 ? "" : "s"} not shown - narrow the query or the range_` : res.rows.length >= r.limit ? `\n_hit the limit of ${r.limit} rows, so there may be more_` : "";
  const who = mode === "run" ? `run by <@${by}> (owner, no confirmation needed)` : `confirmed by <@${by}>`;
  return `${head}\n${body}${note}\n_${r.groups.join(", ")} · ${stamp(r.startMs)} → ${stamp(r.endMs)} · ${who}_`;
};

export const helpText = (prefix: string): string =>
  [
    `*${prefix} cloudwatch* - query CloudWatch Logs Insights directly. It is the only allowed way to touch CloudWatch: nobody runs \`aws logs\` by hand, because it bills per GB scanned.`,
    `\`${prefix} cloudwatch [--group /log/group[,/other]] [--last 15m | --from <time> --to <time>] [--region us-west-2] [--limit 50] <insights query>\``,
    "- `--group` the log group(s); optional once a default is set (`cloudwatch default /log/group`)",
    "- `--last` a span such as `15m`, `2h`, `3d`, `1w` (default 1h), or `--from`/`--to` as ISO times (UTC)",
    "- `--region` default `us-west-2`; `--limit` rows asked of Insights, default 50, at most 1000",
    `- example: \`${prefix} cloudwatch --group /ecs/prod-api --last 15m fields @timestamp, @message | filter @message like /ERROR/ | sort @timestamp desc\``,
    "*Who and how*",
    "- *owner*: gets the cost warning, then it runs straight away",
    "- *executer* and *admin*: the request is posted with its query, log group, range and cost warning plus Confirm / Cancel buttons. Only the requester or the owner can confirm, and an unanswered request expires after 15 min. Nothing runs before a confirm",
    "- anyone else: refused",
    "*Cost guard*: the scan is estimated from the log group's stored size and the range before anything runs, and a range over 3 weeks is flagged as costly. Every run is audited (who, query, range, who confirmed). Output is clipped to fit Slack.",
  ].join("\n");
