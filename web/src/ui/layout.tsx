import { useEffect, useState } from "react";
import { NavLink, Outlet, useNavigation, useRouteLoaderData } from "react-router";
import type { Bootstrap } from "../api.ts";
import { NavIcon, type NavIconName } from "./navIcons.tsx";
import { isToggleShortcut, readCollapsed, writeCollapsed } from "./sidebarState.ts";
import { THEME_LABEL, nextTheme, readTheme, resolveTheme, writeTheme, type ThemePref } from "./theme.ts";

const NAV: { group: string; items: { to: string; label: string; icon: NavIconName; end?: boolean }[] }[] = [
  {
    group: "Workspace",
    items: [
      { to: "/", label: "Overview", icon: "overview", end: true },
      { to: "/conversations", label: "Conversations", icon: "conversations" },
      { to: "/console", label: "Console", icon: "console" },
    ],
  },
  {
    group: "Configure",
    items: [
      { to: "/users", label: "Users", icon: "users" },
      { to: "/roles", label: "Roles", icon: "roles" },
      { to: "/learnings", label: "Memory", icon: "memory" },
      { to: "/identity", label: "Identity", icon: "identity" },
      { to: "/commands", label: "Commands", icon: "commands" },
    ],
  },
  { group: "Usage", items: [{ to: "/spend", label: "Spend", icon: "spend" }] },
  { group: "Docs", items: [{ to: "/architecture", label: "Architecture", icon: "architecture" }] },
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

/** Sun, moon, or a half-filled circle for "follow the system". */
function ThemeIcon({ pref }: { pref: ThemePref }) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      {pref === "light" && (
        <>
          <circle cx="10" cy="10" r="3.2" />
          <path d="M10 2.5v1.8M10 15.7v1.8M2.5 10h1.8M15.7 10h1.8M4.7 4.7l1.3 1.3M14 14l1.3 1.3M4.7 15.3 6 14M14 6l1.3-1.3" />
        </>
      )}
      {pref === "dark" && <path d="M15.5 12.3A6 6 0 0 1 7.7 4.5a6 6 0 1 0 7.8 7.8Z" />}
      {pref === "system" && (
        <>
          <circle cx="10" cy="10" r="6.5" />
          <path d="M10 3.5a6.5 6.5 0 0 1 0 13Z" fill="currentColor" />
        </>
      )}
    </svg>
  );
}

/**
 * The theme preference, applied to `<html data-theme>` as the resolved light
 * or dark. While it is "system" an OS switch is followed live.
 */
function useTheme(): [ThemePref, () => void] {
  const [pref, setPref] = useState<ThemePref>(() => readTheme(storage()));
  useEffect(() => {
    writeTheme(storage(), pref);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const theme = resolveTheme(pref, mq.matches);
      document.documentElement.dataset.theme = theme;
      document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#262624" : "#faf9f5");
    };
    apply();
    if (pref !== "system") return;
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [pref]);
  return [pref, () => setPref((p) => nextTheme(p))];
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
 * remembered per browser) and the page. Every link carries an icon; collapsed, the
 * icon is all that shows, with the full name as its tooltip and accessible name.
 */
export function Layout() {
  const boot = useRouteLoaderData("root") as Bootstrap;
  const nav = useNavigation();
  const [collapsed, setCollapsed] = useState(() => readCollapsed(storage()));
  const [theme, cycleTheme] = useTheme();

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
            onClick={cycleTheme}
            aria-label={`${THEME_LABEL[theme]}. Change theme`}
            title={`${THEME_LABEL[theme]} - click to change`}
          >
            <ThemeIcon pref={theme} />
          </button>
          <button
            type="button"
            className="side-toggle collapse-toggle"
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
                <NavIcon name={n.icon} />
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
