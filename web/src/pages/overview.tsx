import { Link, useLoaderData, useRouteLoaderData, useSearchParams, type LoaderFunctionArgs } from "react-router";
import { get, type Bootstrap, type Overview, type StatsView } from "../api.ts";
import { DayChart, RankBars } from "../ui/charts.tsx";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const days = new URL(request.url).searchParams.get("days") ?? "30";
  const [overview, stats] = await Promise.all([
    get<Overview>("overview"),
    get<StatsView>(`stats?days=${encodeURIComponent(days)}`),
  ]);
  return { overview, stats };
};

const WINDOWS = [7, 30, 90];

const money = (usd: number): string =>
  usd >= 100 ? `$${Math.round(usd)}` : usd >= 10 ? `$${usd.toFixed(1)}` : usd > 0 ? `$${usd.toFixed(2)}` : "$0";

const sum = <T,>(rows: readonly T[], f: (r: T) => number): number => rows.reduce((a, r) => a + f(r), 0);

function Activity({ stats }: { stats: Extract<StatsView, { recording: true }> }) {
  const [params, setParams] = useSearchParams();
  const days = stats.days;
  const messages = sum(stats.messages, (d) => d.user + d.assistant);
  const turns = sum(stats.turns, (d) => d.ok + d.failed);
  const failed = sum(stats.turns, (d) => d.failed);
  const cost = sum(stats.spend, (d) => d.costUsd);
  const tiles = [
    { n: String(messages), l: `messages, last ${days}d` },
    { n: String(turns), l: failed ? `brain runs, ${failed} did not finish ok` : "brain runs, all ok" },
    { n: money(cost), l: "list-price model time" },
    { n: String(stats.activeThreads.day), l: `threads live today, ${stats.activeThreads.week} this week` },
  ];
  return (
    <>
      <div className="section-head">
        <h2>Activity</h2>
        <div className="seg" role="radiogroup" aria-label="window">
          {WINDOWS.map((w) => (
            <button
              key={w}
              role="radio"
              aria-checked={days === w}
              className={days === w ? "seg-on" : ""}
              onClick={() => {
                const next = new URLSearchParams(params);
                next.set("days", String(w));
                setParams(next, { preventScrollReset: true });
              }}
            >
              {w}d
            </button>
          ))}
        </div>
      </div>
      <div className="cards">
        {tiles.map((t) => (
          <div className="card stat" key={t.l}>
            <div className="stat-n">{t.n}</div>
            <div className="stat-l">{t.l}</div>
          </div>
        ))}
      </div>
      <div className="card chart-card">
        <div className="chart-title">
          <b>Messages per day</b>
          <span className="muted">every stored turn, people and bot</span>
        </div>
        <DayChart
          kind="area"
          label="Messages per day"
          data={stats.messages.map((d) => ({
            date: d.date,
            value: d.user + d.assistant,
            detail: `${d.user} from people · ${d.assistant} from the bot`,
          }))}
        />
      </div>
      <div className="chart-pair">
        <div className="card chart-card">
          <div className="chart-title">
            <b>Brain runs per day</b>
            <span className="muted">chat and workflow turns</span>
          </div>
          <DayChart
            kind="bar"
            label="Brain runs per day"
            data={stats.turns.map((d) => ({
              date: d.date,
              value: d.ok + d.failed,
              detail: d.failed ? `${d.ok} ok · ${d.failed} failed or stopped` : `${d.ok} ok`,
            }))}
          />
        </div>
        <div className="card chart-card">
          <div className="chart-title">
            <b>Spend per day</b>
            <span className="muted">list price, not an invoice</span>
          </div>
          <DayChart
            kind="area"
            label="Spend per day"
            format={money}
            data={stats.spend.map((d) => ({ date: d.date, value: d.costUsd, detail: `${d.runs} runs` }))}
          />
        </div>
      </div>
      <div className="chart-pair">
        <div className="card chart-card">
          <div className="chart-title">
            <b>Top commands</b>
            <span className="muted">
              runs, last {days}d · <Link to="/commands">command log</Link>
            </span>
          </div>
          <RankBars
            empty="No commands ran in this window."
            rows={stats.topCommands.map((c) => ({
              key: c.key,
              label: <code>{c.key}</code>,
              value: c.runs,
              note: c.failed ? `${c.failed} failed` : undefined,
            }))}
          />
        </div>
        <div className="card chart-card">
          <div className="chart-title">
            <b>Most active people</b>
            <span className="muted">turns plus commands, last {days}d</span>
          </div>
          <RankBars
            empty="Nobody talked to the bot in this window."
            rows={stats.topUsers.map((u) => ({
              key: u.key,
              label: u.label,
              value: u.turns + u.commands,
              note: `${u.turns} turns · ${u.commands} commands`,
            }))}
          />
        </div>
      </div>
    </>
  );
}

export function OverviewPage() {
  const { overview, stats } = useLoaderData() as { overview: Overview; stats: StatsView };
  const boot = useRouteLoaderData("root") as Bootstrap;
  const cards = [
    { n: overview.users, l: "allowed users" },
    { n: overview.conversations, l: "conversations" },
    { n: overview.messages, l: "stored turns" },
    { n: overview.learnings, l: overview.memory ? "memory items" : "learnings" },
  ];
  const tiles = [
    { to: "/users", t: "Users", d: "Who may talk to the bot, and with which role" },
    { to: "/learnings", t: "Memory", d: "Teach a fact, edit the adapter, revert a revision" },
    { to: "/identity", t: "Identity", d: "Name, persona and system prompt" },
    { to: "/console", t: "Console", d: "Read, reply to and edit Slack messages" },
    { to: "/commands", t: "Commands", d: "Turn commands on or off, see what ran" },
    { to: "/spend", t: "Spend", d: "What the model consumed, by person and command" },
    { to: "/architecture", t: "Architecture", d: "How it is built - play a request through the system" },
  ];
  return (
    <>
      <div className="hero">
        <h1>Good to see you</h1>
        <p className="muted">{boot?.botName ?? "The bot"} at a glance. Everything below is live from its own database.</p>
      </div>
      <div className="cards">
        {cards.map((c) => (
          <div className="card stat" key={c.l}>
            <div className="stat-n">{c.n}</div>
            <div className="stat-l">{c.l}</div>
          </div>
        ))}
      </div>
      {stats.recording && <Activity stats={stats} />}
      <h2>Jump to</h2>
      <div className="tiles">
        {tiles.map((t) => (
          <Link className="card tile" to={t.to} key={t.to}>
            <b>{t.t}</b>
            <span>{t.d}</span>
          </Link>
        ))}
      </div>
    </>
  );
}
