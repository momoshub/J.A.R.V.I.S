import { Link, useLoaderData, useRouteLoaderData } from "react-router";
import { get, type Bootstrap, type Overview } from "../api.ts";

export const loader = async () => ({ overview: await get<Overview>("overview") });

export function OverviewPage() {
  const { overview } = useLoaderData() as { overview: Overview };
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
