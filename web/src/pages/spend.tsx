import { useLoaderData, useSearchParams, type LoaderFunctionArgs } from "react-router";
import { get, type UsageView } from "../api.ts";

/** 1_234_567 -> "1.2M". The same shapes the Slack report uses. */
const tokens = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
};

const money = (usd: number): string =>
  usd >= 100 ? `$${Math.round(usd)}` : usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(3)}`;

const duration = (ms: number): string => {
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}`;
};

const WINDOWS = [
  { hours: 24, label: "24h" },
  { hours: 24 * 7, label: "7d" },
  { hours: 24 * 30, label: "30d" },
  { hours: 24 * 365, label: "all" },
];

/**
 * Spend - what the model has cost, by person and by command.
 *
 * The figure is the CLI's own LIST price, which on a subscription credential is
 * consumption rather than an invoice. The page says so under the headline
 * number rather than leaving somebody to read it as a bill.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const hours = new URL(request.url).searchParams.get("hours") ?? "24";
  return get<UsageView>(`usage?hours=${encodeURIComponent(hours)}`);
};

export function SpendPage() {
  const data = useLoaderData() as UsageView;
  const [params, setParams] = useSearchParams();
  const hours = Number(params.get("hours") ?? "24");

  if (!data.recording) {
    return (
      <>
        <h1>Spend</h1>
        <p className="muted">Nothing is recording what runs cost on this instance.</p>
      </>
    );
  }

  const t = data.totals;
  const name = (id: string) => (id ? (data.names[id] ?? id) : "unattributed");

  return (
    <>
      <h1>Spend</h1>
      <p className="muted">
        What the brain has consumed, at list price. Every turn is a Claude Code run; a review is
        minutes of one. On a subscription credential nobody is invoiced this - it measures
        consumption, not money owed.
      </p>

      <div className="card">
        <div className="seg">
          {WINDOWS.map((w) => (
            <button
              key={w.hours}
              type="button"
              className={w.hours === hours ? "seg-on" : ""}
              onClick={() => setParams({ hours: String(w.hours) })}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      <div className="cards">
        {[
          { n: money(t.costUsd), l: "list price" },
          { n: String(t.runs), l: "runs" },
          { n: duration(t.durationMs), l: "model time" },
          { n: tokens(t.inputTokens + t.outputTokens), l: "tokens, uncached" },
          { n: tokens(t.cacheRead + t.cacheWrite), l: "tokens, cached" },
        ].map((c) => (
          <div className="card stat" key={c.l}>
            <div className="stat-n">{c.n}</div>
            <div className="stat-l">{c.l}</div>
          </div>
        ))}
      </div>

      <div className="card table">
        <h2>By person</h2>
        <table>
          <thead>
            <tr><th>who</th><th>cost</th><th>runs</th><th>tokens</th><th>model time</th></tr>
          </thead>
          <tbody>
            {data.byUser.map((u) => (
              <tr key={u.key || "none"}>
                <td>{name(u.key)}</td>
                <td>{money(u.costUsd)}</td>
                <td>{u.runs}</td>
                <td>{tokens(u.inputTokens + u.outputTokens + u.cacheRead + u.cacheWrite)}</td>
                <td>{duration(u.durationMs)}</td>
              </tr>
            ))}
            {data.byUser.length === 0 && (
              <tr><td colSpan={5} className="muted">nothing in this window</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card table">
        <h2>By command</h2>
        <table>
          <thead>
            <tr><th>what</th><th>cost</th><th>runs</th><th>tokens</th><th>model time</th></tr>
          </thead>
          <tbody>
            {data.byKind.map((k) => (
              <tr key={k.key || "chat"}>
                <td><code>{k.key || "chat"}</code></td>
                <td>{money(k.costUsd)}</td>
                <td>{k.runs}</td>
                <td>{tokens(k.inputTokens + k.outputTokens + k.cacheRead + k.cacheWrite)}</td>
                <td>{duration(k.durationMs)}</td>
              </tr>
            ))}
            {data.byKind.length === 0 && (
              <tr><td colSpan={5} className="muted">nothing in this window</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
