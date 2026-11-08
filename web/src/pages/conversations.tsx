import { Form, Link, useLoaderData, useParams, useRouteLoaderData, type LoaderFunctionArgs } from "react-router";
import { fmtTime, get, post, type Bootstrap, type Channel, type ConversationView } from "../api.ts";
import { guard } from "../routes/guard.ts";

export const listLoader = async () => ({ channels: await get<Channel[]>("conversations") });

export const channelLoader = async ({ params }: LoaderFunctionArgs) =>
  get<ConversationView>(`conversation?channel=${encodeURIComponent(params.channel ?? "")}`);

/** Both pages clear a channel the same way. */
export const clearAction = guard(async ({ request }) => {
  const fd = await request.formData();
  await post("conversation/clear", { channel: fd.get("channel") });
  return { ok: true };
});

export function ConversationsPage() {
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
                <td><Link to={`/conversations/${encodeURIComponent(c.channelId)}`}>{c.label}</Link></td>
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

export function ConversationPage() {
  const { channel: info, messages } = useLoaderData() as ConversationView;
  const { channel } = useParams();
  const boot = useRouteLoaderData("root") as Bootstrap;
  return (
    <>
      <p><Link to="/conversations">← back to conversations</Link></p>
      <h1>{info.label} <span className="pill">{messages.length} turns</span></h1>
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
            <span>{m.userLabel}</span>
            <span>{fmtTime(m.createdAt)}</span>
          </div>
          <div className="bubble-content">{m.content}</div>
        </div>
      ))}
    </>
  );
}
