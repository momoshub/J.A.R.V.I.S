import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  createBrowserRouter,
  Form,
  Link,
  NavLink,
  Outlet,
  RouterProvider,
  useActionData,
  useLoaderData,
  useNavigation,
  useParams,
  useRouteError,
  useRouteLoaderData,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router-dom";
import {
  fmtTime,
  get,
  post,
  type AdapterView,
  type AllowedUser,
  type Bootstrap,
  type Channel,
  type Identity,
  type Learning,
  type Message,
  type Overview,
} from "./api.ts";
import { ConsolePage } from "./console.tsx";
import { CommandsPage } from "./commands.tsx";
import "./styles.css";

/** Wrap an action so thrown API errors surface as `{ error }` instead of crashing. */
const guard =
  (fn: (a: ActionFunctionArgs) => Promise<unknown>) =>
  async (args: ActionFunctionArgs) => {
    try {
      return await fn(args);
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  };

const NAV = [
  { to: "/", label: "Overview", end: true },
  { to: "/users", label: "Users" },
  { to: "/learnings", label: "Memory" },
  { to: "/identity", label: "Identity" },
  { to: "/conversations", label: "Conversations" },
  { to: "/console", label: "Console" },
  { to: "/commands", label: "Commands" },
];

function Layout() {
  const boot = useRouteLoaderData("root") as Bootstrap;
  const nav = useNavigation();
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="dot" />
          <div>
            <div className="brand-name">{boot?.botName ?? "control deck"}</div>
            <div className="brand-sub">control deck</div>
          </div>
        </div>
        <nav>
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => (isActive ? "active" : "")}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="side-foot">
          <div>model</div>
          <code>{boot?.model}</code>
          <div style={{ marginTop: 10 }}>owner</div>
          <code>{boot?.ownerSlackId}</code>
        </div>
      </aside>
      <main className={nav.state === "loading" ? "loading" : ""}>
        <Outlet />
      </main>
    </div>
  );
}

function ErrorView() {
  const err = useRouteError();
  const msg = err instanceof Error ? err.message : String(err);
  return (
    <div className="card error">
      <h2>Something went wrong</h2>
      <p>{msg}</p>
    </div>
  );
}

function Banner({ error }: { error?: string }) {
  if (!error) return null;
  return <div className="banner error">{error}</div>;
}

/* ---------- Overview ---------- */
function OverviewPage() {
  const { overview } = useLoaderData() as { overview: Overview };
  const cards = [
    { n: overview.users, l: "allowed users" },
    { n: overview.conversations, l: "conversations" },
    { n: overview.messages, l: "stored turns" },
    { n: overview.learnings, l: overview.memory ? "memory items" : "learnings" },
  ];
  return (
    <>
      <h1>Overview</h1>
      <div className="cards">
        {cards.map((c) => (
          <div className="card stat" key={c.l}>
            <div className="stat-n">{c.n}</div>
            <div className="stat-l">{c.l}</div>
          </div>
        ))}
      </div>
      <p className="muted">Manage the allowlist, curate learnings, edit the identity, and browse conversations from the tabs.</p>
    </>
  );
}

/* ---------- Users ---------- */
const ROLE_HELP: Record<string, string> = {
  owner: "full control, cannot be removed",
  admin: "full tool access, manages users",
  executer: "sandboxed, tools assigned below",
  pal: "sandboxed read-only tools + review",
};

function UsersPage() {
  const { users, owner, executerTools } = useLoaderData() as {
    users: AllowedUser[];
    owner: string;
    executerTools: string;
  };
  const action = useActionData() as { error?: string } | undefined;
  return (
    <>
      <h1>Users</h1>
      <Banner error={action?.error} />
      <Form method="post" className="row">
        <input type="hidden" name="intent" value="add" />
        <input name="slackId" placeholder="U0123456789" pattern="[UW][A-Z0-9]+" required />
        <select name="role" defaultValue="pal">
          <option value="pal">pal</option>
          <option value="executer">executer</option>
          <option value="admin">admin</option>
        </select>
        <button type="submit">add / update</button>
      </Form>
      <div className="card table">
        <table>
          <thead>
            <tr><th>user</th><th>role</th><th>added by</th><th /></tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.slackId}>
                <td>
                  <code>{`<@${u.slackId}:${u.name || "?"}>`}</code>
                </td>
                <td>
                  <span className={`badge ${u.role}`}>{u.role}</span>
                  <div className="muted">{ROLE_HELP[u.role]}</div>
                </td>
                <td className="muted">{u.addedBy}</td>
                <td>
                  {u.slackId === owner ? (
                    <span className="muted">protected</span>
                  ) : (
                    <Form method="post">
                      <input type="hidden" name="intent" value="remove" />
                      <input type="hidden" name="slackId" value={u.slackId} />
                      <button className="danger" type="submit">revoke</button>
                    </Form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Executer tools</h2>
      <p className="muted">Tools the <span className="badge executer">executer</span> role may use (one per line or comma-separated). Blank falls back to the read-only pal set. e.g. <code>Read</code>, <code>WebSearch</code>, <code>Bash(gh pr view:*)</code>.</p>
      <Form method="post" className="stack">
        <input type="hidden" name="intent" value="executerTools" />
        <textarea name="executerTools" defaultValue={executerTools} rows={6} spellCheck={false} />
        <div className="row"><button type="submit">save executer tools</button></div>
      </Form>
    </>
  );
}

/* ---------- Memory ---------- */

/**
 * Memory, when it is an adapter.
 *
 * Read-only on purpose. The old page was a grid of text boxes writing straight
 * into a list that nothing ever curated, which is how that list came to hold a
 * fact and its own retraction at the same time. The two safe actions are here -
 * teach one fact, or put a whole revision back - and reshaping memory is
 * `adapter refine`, which is gated and recorded.
 */
function AdapterMemory({ a, error }: { a: AdapterView; error?: string }) {
  return (
    <>
      <h1>Memory</h1>
      <p className="muted">
        A Hermit harness adapter. The policy and notes load into every reply; notes about a person or a
        channel load only there, and a skill costs its description until something makes it relevant.
      </p>
      <Banner error={error} />
      {a.status && <pre className="card">{a.status}</pre>}

      <Form method="post" className="row">
        <input type="hidden" name="intent" value="add" />
        <input name="content" placeholder="teach one durable fact" required style={{ flex: 1 }} />
        <button type="submit">teach</button>
      </Form>
      <p className="muted">
        It lands under "Recently taught" and stays there until a refine pass files it. Run that with
        <code> adapter refine</code> in Slack.
      </p>

      <h2>Policy</h2>
      <p className="muted">Rules. Always loaded.</p>
      <pre className="card">{a.policy?.trim() || "Nothing yet."}</pre>

      <h2>Notes</h2>
      <p className="muted">Facts. Always loaded.</p>
      <pre className="card">{a.notes?.trim() || "Nothing yet."}</pre>

      <h2>In depth</h2>
      <p className="muted">Only the description is loaded; the body is read when it is relevant.</p>
      <div className="card table">
        <table>
          <thead><tr><th>skill</th><th>description</th></tr></thead>
          <tbody>
            {(a.skills ?? []).length === 0 && <tr><td colSpan={2} className="muted">No skills yet.</td></tr>}
            {(a.skills ?? []).map((s) => (
              <tr key={s.name}><td>{s.name}</td><td className="muted">{s.description}</td></tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Scoped</h2>
      <p className="muted">Loaded only when that person is in the conversation, or in that channel.</p>
      <p>
        {(a.people ?? []).length + (a.channels ?? []).length === 0
          ? <span className="muted">Nothing scoped yet.</span>
          : [...(a.people ?? []), ...(a.channels ?? [])].map((id) => <code key={id} style={{ marginRight: 8 }}>{id}</code>)}
      </p>

      <h2>Revisions</h2>
      <p className="muted">Every change is a snapshot, so a curation that lost something is one click back.</p>
      <div className="card table">
        <table>
          <thead><tr><th>#</th><th>what</th><th>by</th><th>when</th><th /></tr></thead>
          <tbody>
            {(a.revisions ?? []).length === 0 && <tr><td colSpan={5} className="muted">No revisions yet.</td></tr>}
            {(a.revisions ?? []).map((r) => (
              <tr key={r.id}>
                <td>{r.id}</td>
                <td>{r.reason}</td>
                <td className="muted">{r.createdBy}</td>
                <td className="muted">{fmtTime(r.createdAt)}</td>
                <td>
                  <Form method="post">
                    <input type="hidden" name="intent" value="revert" />
                    <input type="hidden" name="id" value={r.id} />
                    <button type="submit">revert</button>
                  </Form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** The flat list, for an instance that has not moved to an adapter. */
function LegacyLearnings({ learnings, error }: { learnings: Learning[]; error?: string }) {
  return (
    <>
      <h1>Learnings</h1>
      <p className="muted">Durable facts injected into every reply as known facts.</p>
      <Banner error={error} />
      <Form method="post" className="row">
        <input type="hidden" name="intent" value="add" />
        <input name="content" placeholder="e.g. Our staging URL is staging.example.com" required style={{ flex: 1 }} />
        <button type="submit">add learning</button>
      </Form>
      <div className="card table">
        <table>
          <thead><tr><th>learning</th><th>by</th><th>when</th><th /></tr></thead>
          <tbody>
            {learnings.length === 0 && (
              <tr><td colSpan={4} className="muted">Nothing learned yet.</td></tr>
            )}
            {learnings.map((l) => (
              <tr key={l.id}>
                <td>
                  {/* Edit in place: the row is the field, so rewording is one
                      click and a save rather than delete-and-retype. */}
                  <Form method="post" className="row" id={`learning-${l.id}`}>
                    <input type="hidden" name="intent" value="update" />
                    <input type="hidden" name="id" value={l.id} />
                    <input name="content" defaultValue={l.content} required style={{ flex: 1 }} />
                  </Form>
                </td>
                <td className="muted">{l.createdBy}</td>
                <td className="muted">{fmtTime(l.createdAt)}</td>
                <td className="row">
                  <button type="submit" form={`learning-${l.id}`}>save</button>
                  <Form method="post">
                    <input type="hidden" name="intent" value="remove" />
                    <input type="hidden" name="id" value={l.id} />
                    <button className="danger" type="submit">delete</button>
                  </Form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function LearningsPage() {
  const { learnings, adapter } = useLoaderData() as { learnings: Learning[]; adapter: AdapterView };
  const action = useActionData() as { error?: string } | undefined;
  return adapter.configured
    ? <AdapterMemory a={adapter} error={action?.error} />
    : <LegacyLearnings learnings={learnings} error={action?.error} />;
}

/* ---------- Identity ---------- */
function IdentityPage() {
  const id = useLoaderData() as Identity;
  const action = useActionData() as { error?: string; ok?: boolean } | undefined;
  return (
    <>
      <h1>Identity</h1>
      <p className="muted">
        {id.usingDefault ? "Using the built-in default persona." : "Using a custom persona."} Identity, learnings, participants and the addressee are appended automatically.
      </p>
      <Banner error={action?.error} />
      {action?.ok && <div className="banner ok">Saved.</div>}
      <Form method="post" className="stack">
        <input type="hidden" name="intent" value="save" />
        <div className="grid2">
          <label>
            <span>bot name</span>
            <input name="name" defaultValue={id.name} required />
          </label>
          <label>
            <span>thinking label (long messages)</span>
            <input name="thinkingLabel" defaultValue={id.thinkingLabel} />
          </label>
          <label>
            <span>thinking done label</span>
            <input name="thinkingDoneLabel" defaultValue={id.thinkingDoneLabel} />
          </label>
        </div>
        <label>
          <span>system prompt - personality &amp; rules</span>
          <textarea name="prompt" defaultValue={id.persona} spellCheck={false} rows={16} />
        </label>
        <div className="row">
          <button type="submit">save</button>
        </div>
      </Form>
      <Form method="post">
        <input type="hidden" name="intent" value="reset" />
        <button className="ghost" type="submit">reset persona to default</button>
      </Form>
    </>
  );
}

/* ---------- Conversations ---------- */
function ConversationsPage() {
  const { channels } = useLoaderData() as { channels: Channel[] };
  return (
    <>
      <h1>Conversations</h1>
      <div className="card table">
        <table>
          <thead><tr><th>channel</th><th>turns</th><th>last active</th><th /></tr></thead>
          <tbody>
            {channels.length === 0 && <tr><td colSpan={4} className="muted">No conversations yet.</td></tr>}
            {channels.map((c) => (
              <tr key={c.channelId}>
                <td><Link to={`/conversations/${encodeURIComponent(c.channelId)}`}><code>{c.channelId}</code></Link></td>
                <td>{c.count}</td>
                <td className="muted">{fmtTime(c.lastAt)}</td>
                <td>
                  <Form method="post">
                    <input type="hidden" name="intent" value="clear" />
                    <input type="hidden" name="channel" value={c.channelId} />
                    <button className="danger" type="submit">clear</button>
                  </Form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function ConversationPage() {
  const { messages } = useLoaderData() as { messages: Message[] };
  const { channel } = useParams();
  const boot = useRouteLoaderData("root") as Bootstrap;
  return (
    <>
      <p><Link to="/conversations">← back to conversations</Link></p>
      <h1>Channel <code>{channel}</code> <span className="pill">{messages.length} turns</span></h1>
      <Form method="post" className="row">
        <input type="hidden" name="intent" value="clear" />
        <input type="hidden" name="channel" value={channel} />
        <button className="danger" type="submit">clear this channel's memory</button>
      </Form>
      {messages.length === 0 && <p className="muted">No messages in this channel.</p>}
      {messages.map((m) => (
        <div className="bubble" key={m.id}>
          <div className="bubble-meta">
            <span className={`badge ${m.role}`}>{m.role === "assistant" ? boot?.botName ?? "bot" : "user"}</span>
            <code>{m.slackUserId}</code>
            <span>{fmtTime(m.createdAt)}</span>
          </div>
          <div className="bubble-content">{m.content}</div>
        </div>
      ))}
    </>
  );
}

const router = createBrowserRouter([
  {
    id: "root",
    path: "/",
    loader: async () => get<Bootstrap>("bootstrap"),
    element: <Layout />,
    errorElement: (
      <div className="app">
        <main>
          <ErrorView />
        </main>
      </div>
    ),
    children: [
      {
        index: true,
        loader: async () => ({ overview: await get<Overview>("overview") }),
        element: <OverviewPage />,
      },
      {
        path: "users",
        loader: async () => {
          const [users, boot, roles] = await Promise.all([
            get<AllowedUser[]>("users"),
            get<Bootstrap>("bootstrap"),
            get<{ executerTools: string }>("roles"),
          ]);
          return { users, owner: boot.ownerSlackId, executerTools: roles.executerTools };
        },
        action: guard(async ({ request }) => {
          const fd = await request.formData();
          const intent = fd.get("intent");
          if (intent === "remove") await post("users/remove", { slackId: fd.get("slackId") });
          else if (intent === "executerTools") await post("roles", { executerTools: fd.get("executerTools") });
          else await post("users", { slackId: fd.get("slackId"), role: fd.get("role") });
          return { ok: true };
        }),
        element: <UsersPage />,
      },
      {
        path: "learnings",
        loader: async () => ({
          learnings: await get<Learning[]>("learnings"),
          adapter: await get<AdapterView>("adapter"),
        }),
        action: guard(async ({ request }) => {
          const fd = await request.formData();
          const intent = fd.get("intent");
          if (intent === "revert") await post("adapter/revert", { id: Number(fd.get("id")) });
          else if (intent === "remove") await post("learnings/remove", { id: Number(fd.get("id")) });
          else if (intent === "update")
            await post("learnings/update", { id: Number(fd.get("id")), content: fd.get("content") });
          // `learnings` is the teach endpoint either way: with an adapter it
          // writes there instead of the table.
          else await post("learnings", { content: fd.get("content") });
          return { ok: true };
        }),
        element: <LearningsPage />,
      },
      {
        path: "identity",
        loader: async () => get<Identity>("identity"),
        action: guard(async ({ request }) => {
          const fd = await request.formData();
          if (fd.get("intent") === "reset") await post("prompt/reset", {});
          else
            await post("identity", {
              name: fd.get("name"),
              thinkingLabel: fd.get("thinkingLabel"),
              thinkingDoneLabel: fd.get("thinkingDoneLabel"),
              prompt: fd.get("prompt"),
            });
          return { ok: true };
        }),
        element: <IdentityPage />,
      },
      {
        path: "conversations",
        loader: async () => ({ channels: await get<Channel[]>("conversations") }),
        action: guard(async ({ request }) => {
          const fd = await request.formData();
          await post("conversation/clear", { channel: fd.get("channel") });
          return { ok: true };
        }),
        element: <ConversationsPage />,
      },
      {
        path: "console",
        element: <ConsolePage />,
      },
      {
        path: "commands",
        loader: async () => {
          const [c, log] = await Promise.all([
            get<{ commands: unknown[]; disabled: string[] }>("commands"),
            get<unknown[]>("command-log"),
          ]);
          return { commands: c.commands, disabled: c.disabled, log };
        },
        action: guard(async ({ request }) => {
          const fd = await request.formData();
          if (fd.get("intent") === "clear") await post("command-log/clear", {});
          else await post("commands/toggle", { name: fd.get("name"), enabled: fd.get("enabled") === "true" });
          return { ok: true };
        }),
        element: <CommandsPage />,
      },
      {
        path: "conversations/:channel",
        loader: async ({ params }: LoaderFunctionArgs) => ({
          messages: await get<Message[]>(`conversation?channel=${encodeURIComponent(params.channel ?? "")}`),
        }),
        action: guard(async ({ request }) => {
          const fd = await request.formData();
          await post("conversation/clear", { channel: fd.get("channel") });
          return { ok: true };
        }),
        element: <ConversationPage />,
      },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
