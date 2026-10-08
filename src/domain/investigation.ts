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

/**
 * Placeholder for the read-only Grafana helper's path, substituted when the
 * rules are built. The script is GET-only, so a sandboxed role can read through
 * a datasource proxy without being handed `gcx api`, which can also write.
 */
const GRAFANA_GET_SCRIPT = "{grafanaGet}";

/**
 * Placeholder for the instance's command prefix. A source the bot cannot reach
 * from this turn should point at the one that can, in the words this instance
 * actually answers to.
 */
const COMMAND_PREFIX = "{prefix}";

/** A log/metric/trace backend the bot may be pointed at. */
export type LogSource = {
  /** Key used in configuration, e.g. `grafana`. */
  readonly id: string;
  /** How to actually query it. */
  readonly how: string;
};

/**
 * Backends the bot knows how to reach, keyed by their configuration id.
 *
 * The Grafana guidance deliberately starts with discovery rather than naming a
 * datasource or a query language. Which ones a Grafana has is that instance's
 * business, and assuming is how you get "datasource is type
 * victoriametrics-logs-datasource, not loki" instead of an answer.
 */
export const LOG_SOURCES: Record<string, LogSource> = {
  grafana: {
    id: "grafana",
    how: `the \`gcx\` CLI. ALWAYS start with \`gcx datasources list\` - it gives you the uid AND the type of each one, and the type decides how you query it. Never assume which is there.
   - a \`loki\` datasource: \`gcx logs query -d <uid> '<logql>'\`, and \`gcx logs labels -d <uid>\` when you do not know the labels yet
   - a \`prometheus\` datasource: \`gcx metrics query -d <uid> '<promql>'\`
   - a \`tempo\` datasource: \`gcx traces query -d <uid> ...\`
   - ANY OTHER type - VictoriaLogs, Elasticsearch, ClickHouse and so on - \`gcx logs\` will refuse it. Go through the datasource proxy instead, with that backend's own query language and API path:
       ${GRAFANA_GET_SCRIPT} '/api/datasources/proxy/uid/<uid>/<the backend's query path>'
     e.g. VictoriaLogs takes LogsQL at \`/select/logsql/query?query=<logsql>&limit=50\`. If you do not know a backend's API, look it up before guessing at it.
   Before a real investigation run \`gcx agent skills list\` and load \`debug-with-grafana\`: it is the vendor's own workflow for triage and root-cause work, and better than improvising.`,
  },
  datadog: {
    id: "datadog",
    how: `the Datadog MCP tools (search_datadog_logs, search_datadog_rum_events, search_datadog_spans, and the rest). RUM - browser errors, user sessions, front-end crashes - exists ONLY here, never in Grafana.
   These tools are loaded from the account's connectors, which an ordinary chat turn does NOT have. If you cannot see any \`mcp__\` Datadog tool, that is the expected state and not something to fix from inside the session: do NOT go hunting for API keys, config files or a CLI. Say plainly that Datadog is out of reach for this turn and that \`{prefix} investigate <question>\` runs with the connectors loaded.`,
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
export const investigationRules = (
  order: readonly string[],
  grafanaGetScript?: string,
  commandPrefix?: string,
): string => {
  const sources = order
    .map((id) => LOG_SOURCES[id])
    .filter((s): s is LogSource => !!s)
    // Without the helper there is no way to reach a non-Loki datasource, so do
    // not describe a route the bot cannot take.
    .map((s) =>
      s.how.includes(GRAFANA_GET_SCRIPT)
        ? { ...s, how: grafanaGetScript ? s.how.replaceAll(GRAFANA_GET_SCRIPT, grafanaGetScript) : s.how.replace(/\n   - ANY OTHER type[\s\S]*?guessing at it\.\n/, "\n") }
        : s,
    )
    // Pointing at a command needs the prefix this instance answers to; with no
    // prefix to offer, drop the pointer rather than print a placeholder.
    .map((s) =>
      s.how.includes(COMMAND_PREFIX)
        ? {
            ...s,
            how: commandPrefix
              ? s.how.replaceAll(COMMAND_PREFIX, commandPrefix)
              : s.how.replace(/ and that `\{prefix\} investigate <question>` runs with the connectors loaded\./, "."),
          }
        : s,
    );
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
