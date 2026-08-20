/**
 * Pure HTML rendering for the admin dashboard.
 *
 * No I/O here - takes plain data, returns a string. That keeps the markup easy
 * to test and the server file focused on wiring.
 */
import type { AllowedUser } from "../../domain/types.ts";

export type DashboardData = {
  users: readonly AllowedUser[];
  messageCount: number;
  ownerSlackId: string;
  model: string;
};

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const roleBadge = (role: string): string =>
  `<span class="badge ${escapeHtml(role)}">${escapeHtml(role)}</span>`;

const userRow = (u: AllowedUser, ownerSlackId: string, token: string): string => {
  const isOwner = u.slackId === ownerSlackId;
  const remove = isOwner
    ? "<span class=\"muted\">protected</span>"
    : `<form method="POST" action="/api/users/remove?token=${encodeURIComponent(token)}">
         <input type="hidden" name="slackId" value="${escapeHtml(u.slackId)}" />
         <button class="danger" type="submit">revoke</button>
       </form>`;
  return `<tr>
    <td><code>${escapeHtml(u.slackId)}</code></td>
    <td>${escapeHtml(u.displayName || "-")}</td>
    <td>${roleBadge(u.role)}</td>
    <td>${escapeHtml(u.addedBy)}</td>
    <td>${remove}</td>
  </tr>`;
};

export const renderDashboard = (data: DashboardData, token: string): string => {
  const rows = data.users.map((u) => userRow(u, data.ownerSlackId, token)).join("\n");
  const t = encodeURIComponent(token);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>E.V. control deck</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin: 0; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #0b0e14; color: #e6e6e6; }
    header { padding: 24px 32px; border-bottom: 1px solid #1c2230;
      background: linear-gradient(90deg, #10151f, #0b0e14); }
    h1 { margin: 0; font-size: 20px; letter-spacing: 0.5px; }
    h1 span { color: #ffb454; }
    .sub { color: #7a869a; font-size: 13px; margin-top: 4px; }
    main { padding: 24px 32px; max-width: 960px; }
    .cards { display: flex; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }
    .card { background: #10151f; border: 1px solid #1c2230; border-radius: 12px;
      padding: 16px 20px; min-width: 160px; }
    .card .n { font-size: 26px; font-weight: 700; color: #ffb454; }
    .card .l { color: #7a869a; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; }
    table { width: 100%; border-collapse: collapse; background: #10151f;
      border: 1px solid #1c2230; border-radius: 12px; overflow: hidden; }
    th, td { text-align: left; padding: 10px 14px; border-bottom: 1px solid #1c2230; }
    th { color: #7a869a; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; }
    tr:last-child td { border-bottom: none; }
    code { color: #6cb6ff; }
    .badge { padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; }
    .badge.owner { background: #3a2a00; color: #ffb454; }
    .badge.admin { background: #16324a; color: #6cb6ff; }
    .badge.member { background: #1c2230; color: #9aa5b8; }
    .muted { color: #55607a; font-size: 12px; }
    form.add { display: flex; gap: 8px; margin: 20px 0; flex-wrap: wrap; }
    input, select, button { font: inherit; border-radius: 8px; border: 1px solid #232b3b;
      background: #0b0e14; color: #e6e6e6; padding: 8px 12px; }
    button { background: #ffb454; color: #0b0e14; border: none; font-weight: 600; cursor: pointer; }
    button.danger { background: #b3202a; color: #fff; padding: 4px 10px; }
    h2 { font-size: 14px; color: #7a869a; text-transform: uppercase; letter-spacing: 1px; }
  </style>
</head>
<body>
  <header>
    <h1><span>E.V.</span> control deck</h1>
    <div class="sub">model: ${escapeHtml(data.model)} - owner: <code>${escapeHtml(data.ownerSlackId)}</code></div>
  </header>
  <main>
    <div class="cards">
      <div class="card"><div class="n">${data.users.length}</div><div class="l">allowed users</div></div>
      <div class="card"><div class="n">${data.messageCount}</div><div class="l">stored turns</div></div>
    </div>

    <h2>Grant access</h2>
    <form class="add" method="POST" action="/api/users?token=${t}">
      <input name="slackId" placeholder="U0123456789" required pattern="[UW][A-Z0-9]+" />
      <select name="role">
        <option value="member">member</option>
        <option value="admin">admin</option>
      </select>
      <button type="submit">add</button>
    </form>

    <h2>Access list</h2>
    <table>
      <thead><tr><th>slack id</th><th>name</th><th>role</th><th>added by</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </main>
</body>
</html>`;
};
