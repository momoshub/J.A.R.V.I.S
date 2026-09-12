/**
 * Where to look when someone asks what went wrong.
 *
 * Observability backends are not interchangeable: some are included in a plan,
 * some bill per query. Left to its own judgement the model reaches for whatever
 * it noticed first, which is how an idle "why was it slow last night" turns into
 * a CloudWatch Logs Insights scan over a week of data.
 *
 * So the order is stated, not inferred, and configurable - which backend a team
 * pays for is their business, not something to bake into an open codebase.
 */

/** A log/metric/trace backend the bot may be pointed at. */
export type LogSource = {
  /** Key used in configuration, e.g. `grafana`. */
  readonly id: string;
  /** How to actually query it. */
  readonly how: string;
};

/** Backends the bot knows how to reach, keyed by their configuration id. */
export const LOG_SOURCES: Record<string, LogSource> = {
  grafana: {
    id: "grafana",
    how: "the `gcx` CLI - `gcx logs query '<logql>'` for Loki, `gcx metrics query` for Prometheus, `gcx traces` for Tempo. Run `gcx logs labels` first if you do not know the stream labels. `gcx datasources list` shows what is connected. Before a real investigation run `gcx agent skills list` and load `debug-with-grafana`: it is the vendor's own workflow for triage and root-cause work, and it is better than improvising.",
  },
  datadog: {
    id: "datadog",
    how: "the Datadog MCP tools (search_datadog_logs, search_datadog_spans, and the rest).",
  },
};

/** Order the backends are tried in when nothing is configured. */
export const DEFAULT_LOG_SOURCES: readonly string[] = ["grafana", "datadog"];

/**
 * Backends that must never be queried. CloudWatch bills per GB scanned, so a
 * casual question there has a real invoice attached.
 */
export const DENIED_LOG_SOURCES: readonly string[] = ["cloudwatch"];

/** Parse a stored `grafana,datadog` list, keeping only backends we know. */
export const parseLogSources = (raw: string | undefined): string[] => {
  const wanted = (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s in LOG_SOURCES);
  return [...new Set(wanted)];
};

/** The configured order, falling back to the default when nothing is set. */
export const logSourceOrder = (raw?: string): string[] => {
  const configured = parseLogSources(raw);
  return configured.length > 0 ? configured : [...DEFAULT_LOG_SOURCES];
};

/**
 * The investigation block. Empty when no backend is configured - claiming a
 * source the bot cannot reach is worse than saying nothing.
 */
export const investigationRules = (order: readonly string[]): string => {
  const sources = order.map((id) => LOG_SOURCES[id]).filter((s): s is LogSource => !!s);
  if (sources.length === 0) return "";

  const steps = sources.map((s, i) => `${i + 1}. *${s.id}* - ${s.how}`).join("\n");
  const [first, ...rest] = sources;
  const fallbacks = rest.length > 0 ? rest.map((s) => s.id).join(", then ") : "";

  return `

Looking things up when something is wrong (logs, metrics, traces):
- Go in this order, and start at the top:
${steps}
- ${first ? `Start with *${first.id}*.` : ""}${
    fallbacks
      ? ` Only move on to ${fallbacks} when the first one genuinely has nothing - no such datasource, no matching stream, or the data does not go back far enough. Not because the first query returned no rows: an empty result is an answer.`
      : ""
  }
- NEVER query ${DENIED_LOG_SOURCES.join(" or ")}. Not with the aws CLI, not through a console, not "just to check". It bills per GB scanned, so an idle look there costs real money. If the answer genuinely only exists there, say so and let a person decide - do not run it yourself.
- Narrow before you widen: a tight time window and a specific service or label first, then broaden only if that comes back empty. Never scan an open-ended range to see what turns up.
- Say which source answered you. If you could not reach one at all, say that plainly rather than quietly moving on - "grafana has no logs for that service" and "I could not reach grafana" mean very different things to whoever asked.`;
};
