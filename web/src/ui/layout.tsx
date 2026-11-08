import { useEffect, useState } from "react";
import { NavLink, Outlet, useNavigation, useRouteLoaderData } from "react-router";
import type { Bootstrap } from "../api.ts";
import { isToggleShortcut, readCollapsed, writeCollapsed } from "./sidebarState.ts";

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

const storage = (): Storage | undefined => (typeof window === "undefined" ? undefined : window.localStorage);

/** Two panes and an arrow: the sidebar toggle. */
function ToggleIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" width="18" height="18">
      <rect x="2.5" y="3.5" width="15" height="13" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M7.5 3.5v13" stroke="currentColor" strokeWidth="1.4" />
      <path d={collapsed ? "M11 8l2 2-2 2" : "M13 8l-2 2 2 2"} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

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

/**
 * The shell: a sidebar that collapses to a slim rail (button or Ctrl/Cmd+B,
 * remembered per browser) and the page. Collapsed, each link shows its first
 * letter with the full name as its tooltip and accessible name.
 */
export function Layout() {
  const boot = useRouteLoaderData("root") as Bootstrap;
  const nav = useNavigation();
  const [collapsed, setCollapsed] = useState(() => readCollapsed(storage()));

  useEffect(() => writeCollapsed(storage(), collapsed), [collapsed]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isToggleShortcut(e)) return;
      e.preventDefault();
      setCollapsed((c) => !c);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className={`app${collapsed ? " collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="brand">
          <Mark />
          <div className="brand-text">
            <div className="brand-name">{boot?.botName ?? "control deck"}</div>
            <div className="brand-sub">control deck</div>
          </div>
          <button
            type="button"
            className="side-toggle"
            onClick={() => setCollapsed((c) => !c)}
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={`${collapsed ? "Expand" : "Collapse"} sidebar (Ctrl/Cmd+B)`}
          >
            <ToggleIcon collapsed={collapsed} />
          </button>
        </div>
        {NAV.map((g) => (
          <nav key={g.group} aria-label={g.group}>
            <div className="nav-group">{g.group}</div>
            {g.items.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                className={({ isActive }) => (isActive ? "active" : "")}
                title={collapsed ? n.label : undefined}
                aria-label={collapsed ? n.label : undefined}
              >
                <span className="nav-initial" aria-hidden="true">{n.label[0]}</span>
                <span className="nav-label">{n.label}</span>
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
