import { NavLink, Outlet, useNavigation, useRouteLoaderData } from "react-router";
import type { Bootstrap } from "../api.ts";

const NAV = [
  {
    group: "Workspace",
    items: [
      { to: "/", label: "Overview", end: true },
      { to: "/conversations", label: "Conversations" },
      { to: "/console", label: "Console" },
    ],
  },
  {
    group: "Configure",
    items: [
      { to: "/users", label: "Users" },
      { to: "/learnings", label: "Memory" },
      { to: "/identity", label: "Identity" },
      { to: "/commands", label: "Commands" },
    ],
  },
  { group: "Usage", items: [{ to: "/spend", label: "Spend" }] },
  { group: "Docs", items: [{ to: "/architecture", label: "Architecture" }] },
];

/** A four-point spark, the brand mark. Drawn in currentColor so the theme owns it. */
function Mark() {
  return (
    <svg className="mark" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 1.5c.5 0 .9.4 1 .9l.9 6.1a2 2 0 0 0 1.6 1.6l6.1.9a1 1 0 0 1 0 2l-6.1.9a2 2 0 0 0-1.6 1.6l-.9 6.1a1 1 0 0 1-2 0l-.9-6.1a2 2 0 0 0-1.6-1.6l-6.1-.9a1 1 0 0 1 0-2l6.1-.9a2 2 0 0 0 1.6-1.6l.9-6.1c.1-.5.5-.9 1-.9Z"
      />
    </svg>
  );
}

export function Layout() {
  const boot = useRouteLoaderData("root") as Bootstrap;
  const nav = useNavigation();
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <Mark />
          <div>
            <div className="brand-name">{boot?.botName ?? "control deck"}</div>
            <div className="brand-sub">control deck</div>
          </div>
        </div>
        {NAV.map((g) => (
          <nav key={g.group} aria-label={g.group}>
            <div className="nav-group">{g.group}</div>
            {g.items.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => (isActive ? "active" : "")}>
                {n.label}
              </NavLink>
            ))}
          </nav>
        ))}
        <div className="side-foot">
          <div className="k">model</div>
          <code>{boot?.model}</code>
          <div className="k">owner</div>
          <code>{boot?.ownerSlackId}</code>
        </div>
      </aside>
      <main className={nav.state === "loading" ? "loading" : ""}>
        <Outlet />
      </main>
    </div>
  );
}
