/**
 * Pure HTML rendering for the admin dashboard.
 *
 * No I/O - each renderer takes plain data and returns a string wrapped by a
 * shared `layout`. The layout carries the nav and the CSP-friendly styling (no
 * inline scripts; every action is a form POST). The dashboard token is threaded
 * into links/forms so navigation stays authenticated.
 */
import type { AllowedUser, Learning, StoredMessage } from "../../domain/types.ts";
import type { ChannelSummary } from "../db/messageRepo.ts";

export const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const q = (token: string): string => `token=${encodeURIComponent(token)}`;

const fmtTime = (ms: number): string => {
  if (!ms) return "-";
  try {
    return new Date(ms).toISOString().replace("T", " ").slice(0, 16);
  } catch {
    return "-";
  }
};

type Nav = "overview" | "users" | "learnings" | "prompt" | "conversations";

const NAV: readonly { key: Nav; label: string; href: string }[] = [
  { key: "overview", label: "Overview", href: "/" },
  { key: "users", label: "Users", href: "/users" },
  { key: "learnings", label: "Learnings", href: "/learnings" },
  { key: "prompt", label: "Prompt", href: "/prompt" },
  { key: "conversations", label: "Conversations", href: "/conversations" },
];

const STYLES = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: #0b0e14; color: #e6e6e6; }
  header { padding: 20px 32px; border-bottom: 1px solid #1c2230;
    background: linear-gradient(90deg, #10151f, #0b0e14); }
  h1 { margin: 0; font-size: 20px; letter-spacing: 0.5px; }
  h1 span { color: #ffb454; }
  .sub { color: #7a869a; font-size: 13px; margin-top: 4px; }
  nav { display: flex; gap: 4px; padding: 0 24px; border-bottom: 1px solid #1c2230; background: #0d1219; flex-wrap: wrap; }
  nav a { padding: 12px 16px; color: #9aa5b8; text-decoration: none; font-size: 14px; border-bottom: 2px solid transparent; }
  nav a.active { color: #ffb454; border-bottom-color: #ffb454; }
  nav a:hover { color: #e6e6e6; }
  main { padding: 24px 32px; max-width: 1000px; }
  h2 { font-size: 13px; color: #7a869a; text-transform: uppercase; letter-spacing: 1px; margin-top: 28px; }
  .cards { display: flex; gap: 16px; margin-bottom: 8px; flex-wrap: wrap; }
  .card { background: #10151f; border: 1px solid #1c2230; border-radius: 12px; padding: 16px 20px; min-width: 150px; }
  .card .n { font-size: 26px; font-weight: 700; color: #ffb454; }
  .card .l { color: #7a869a; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; }
  table { width: 100%; border-collapse: collapse; background: #10151f; border: 1px solid #1c2230; border-radius: 12px; overflow: hidden; }
  th, td { text-align: left; padding: 10px 14px; border-bottom: 1px solid #1c2230; vertical-align: top; }
  th { color: #7a869a; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; }
  tr:last-child td { border-bottom: none; }
  code { color: #6cb6ff; }
  a { color: #6cb6ff; }
  .badge { padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .badge.owner { background: #3a2a00; color: #ffb454; }
  .badge.admin { background: #16324a; color: #6cb6ff; }
  .badge.member { background: #1c2230; color: #9aa5b8; }
  .badge.user { background: #16324a; color: #6cb6ff; }
  .badge.assistant { background: #3a2a00; color: #ffb454; }
  .muted { color: #55607a; font-size: 12px; }
  form.inline { display: inline; }
  form.row { display: flex; gap: 8px; margin: 16px 0; flex-wrap: wrap; align-items: flex-start; }
  input, select, button, textarea { font: inherit; border-radius: 8px; border: 1px solid #232b3b; background: #0b0e14; color: #e6e6e6; padding: 8px 12px; }
  textarea { width: 100%; min-height: 320px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; line-height: 1.5; }
  button { background: #ffb454; color: #0b0e14; border: none; font-weight: 600; cursor: pointer; }
  button.danger { background: #b3202a; color: #fff; padding: 4px 10px; }
  button.ghost { background: #1c2230; color: #9aa5b8; }
  .bubble { background: #10151f; border: 1px solid #1c2230; border-radius: 12px; padding: 12px 16px; margin-bottom: 10px; }
  .bubble .meta { font-size: 12px; color: #7a869a; margin-bottom: 6px; display: flex; gap: 8px; align-items: center; }
  .bubble .content { white-space: pre-wrap; word-break: break-word; }
  .pill { display: inline-block; background: #1c2230; color: #9aa5b8; border-radius: 999px; padding: 2px 10px; font-size: 12px; }
`;

export const layout = (opts: {
  title: string;
  active: Nav;
  subtitle: string;
  body: string;
  token: string;
}): string => {
  const nav = NAV.map((n) => {
    const cls = n.key === opts.active ? ' class="active"' : "";
    return `<a href="${n.href}?${q(opts.token)}"${cls}>${escapeHtml(n.label)}</a>`;
  }).join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(opts.title)}</title>
  <style>${STYLES}</style>
</head>
<body>
  <header>
    <h1><span>E.V.</span> control deck</h1>
    <div class="sub">${opts.subtitle}</div>
  </header>
  <nav>${nav}</nav>
  <main>${opts.body}</main>
</body>
</html>`;
};

// --- sections ---

export const renderOverview = (data: {
  userCount: number;
  messageCount: number;
  learningCount: number;
  channelCount: number;
}): string => `
  <div class="cards">
    <div class="card"><div class="n">${data.userCount}</div><div class="l">allowed users</div></div>
    <div class="card"><div class="n">${data.channelCount}</div><div class="l">conversations</div></div>
    <div class="card"><div class="n">${data.messageCount}</div><div class="l">stored turns</div></div>
    <div class="card"><div class="n">${data.learningCount}</div><div class="l">learnings</div></div>
  </div>
  <p class="muted">Use the tabs above to browse conversations, curate what E.V. has learned, and edit her personality and rules.</p>
`;

const roleBadge = (role: string): string =>
  `<span class="badge ${escapeHtml(role)}">${escapeHtml(role)}</span>`;

export const renderUsers = (
  users: readonly AllowedUser[],
  ownerSlackId: string,
  token: string,
): string => {
  const rows = users
    .map((u) => {
      const isOwner = u.slackId === ownerSlackId;
      const remove = isOwner
        ? '<span class="muted">protected</span>'
        : `<form class="inline" method="POST" action="/api/users/remove?${q(token)}">
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
    })
    .join("\n");
  return `
    <h2>Grant access</h2>
    <form class="row" method="POST" action="/api/users?${q(token)}">
      <input name="slackId" placeholder="U0123456789" required pattern="[UW][A-Z0-9]+" />
      <select name="role"><option value="member">member</option><option value="admin">admin</option></select>
      <button type="submit">add</button>
    </form>
    <h2>Access list</h2>
    <table>
      <thead><tr><th>slack id</th><th>name</th><th>role</th><th>added by</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
};

export const renderLearnings = (learnings: readonly Learning[], token: string): string => {
  const rows =
    learnings.length === 0
      ? '<tr><td colspan="4" class="muted">Nothing learned yet.</td></tr>'
      : learnings
          .map(
            (l) => `<tr>
              <td>${escapeHtml(l.content)}</td>
              <td class="muted">${escapeHtml(l.createdBy)}</td>
              <td class="muted">${fmtTime(l.createdAt)}</td>
              <td>
                <form class="inline" method="POST" action="/api/learnings/remove?${q(token)}">
                  <input type="hidden" name="id" value="${l.id}" />
                  <button class="danger" type="submit">delete</button>
                </form>
              </td>
            </tr>`,
          )
          .join("\n");
  return `
    <h2>Teach E.V. something</h2>
    <form class="row" method="POST" action="/api/learnings?${q(token)}">
      <input name="content" placeholder="e.g. Our staging URL is staging.acme.com" required style="flex:1; min-width:280px;" />
      <button type="submit">add learning</button>
    </form>
    <p class="muted">Learnings are injected into every reply as known facts.</p>
    <table>
      <thead><tr><th>learning</th><th>by</th><th>when</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
};

export const renderPrompt = (
  data: { current: string; usingDefault: boolean },
  token: string,
): string => `
  <h2>System prompt - personality &amp; rules</h2>
  <p class="muted">
    ${data.usingDefault ? "Currently using the built-in default." : "Currently using a custom override."}
    This text is E.V.'s base personality; learnings and the addressee are appended automatically.
  </p>
  <form method="POST" action="/api/prompt?${q(token)}">
    <textarea name="prompt" spellcheck="false">${escapeHtml(data.current)}</textarea>
    <div class="row">
      <button type="submit">save</button>
    </div>
  </form>
  <form class="inline" method="POST" action="/api/prompt/reset?${q(token)}">
    <button class="ghost" type="submit">reset to default</button>
  </form>`;

export const renderConversations = (
  channels: readonly ChannelSummary[],
  token: string,
): string => {
  const rows =
    channels.length === 0
      ? '<tr><td colspan="4" class="muted">No conversations yet.</td></tr>'
      : channels
          .map(
            (c) => `<tr>
              <td><a href="/conversation?channel=${encodeURIComponent(c.channelId)}&${q(token)}"><code>${escapeHtml(c.channelId)}</code></a></td>
              <td>${c.count}</td>
              <td class="muted">${fmtTime(c.lastAt)}</td>
              <td>
                <form class="inline" method="POST" action="/api/conversation/clear?${q(token)}">
                  <input type="hidden" name="channel" value="${escapeHtml(c.channelId)}" />
                  <button class="danger" type="submit">clear</button>
                </form>
              </td>
            </tr>`,
          )
          .join("\n");
  return `
    <h2>Conversations &amp; DMs</h2>
    <table>
      <thead><tr><th>channel</th><th>turns</th><th>last active</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
};

export const renderConversation = (
  data: { channelId: string; messages: readonly StoredMessage[] },
  token: string,
): string => {
  const bubbles =
    data.messages.length === 0
      ? '<p class="muted">No messages in this channel.</p>'
      : data.messages
          .map(
            (m) => `<div class="bubble">
              <div class="meta">
                <span class="badge ${escapeHtml(m.role)}">${m.role === "assistant" ? "E.V." : "user"}</span>
                <code>${escapeHtml(m.slackUserId)}</code>
                <span>${fmtTime(m.createdAt)}</span>
              </div>
              <div class="content">${escapeHtml(m.content)}</div>
            </div>`,
          )
          .join("\n");
  return `
    <p><a href="/conversations?${q(token)}">back to conversations</a></p>
    <h2>Channel <code>${escapeHtml(data.channelId)}</code> <span class="pill">${data.messages.length} turns</span></h2>
    <form class="row" method="POST" action="/api/conversation/clear?${q(token)}">
      <input type="hidden" name="channel" value="${escapeHtml(data.channelId)}" />
      <button class="danger" type="submit">clear this channel's memory</button>
    </form>
    ${bubbles}`;
};
