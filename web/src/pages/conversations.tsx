import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Form, Link, useLoaderData, useParams, useRouteLoaderData, type LoaderFunctionArgs } from "react-router";
import {
  fmtTime,
  get,
  post,
  type Bootstrap,
  type Channel,
  type ChannelPage,
  type ConversationView,
  type Message,
} from "../api.ts";
import { guard } from "../routes/guard.ts";

export const listLoader = async () => get<ChannelPage>("conversations");

export const channelLoader = async ({ params }: LoaderFunctionArgs) =>
  get<ConversationView>(`conversation?channel=${encodeURIComponent(params.channel ?? "")}`);

/** Both pages clear a channel the same way. */
export const clearAction = guard(async ({ request }) => {
  const fd = await request.formData();
  await post("conversation/clear", { channel: fd.get("channel") });
  return { ok: true };
});

/**
 * Call `onHit` whenever `target` scrolls into view inside `root` (the page when
 * absent). The callback is read through a ref, so a new one never re-observes.
 */
const useSentinel = (
  target: RefObject<Element | null>,
  root: RefObject<Element | null> | undefined,
  enabled: boolean,
  onHit: () => void,
) => {
  const hit = useRef(onHit);
  hit.current = onHit;
  useEffect(() => {
    const el = target.current;
    if (!el || !enabled) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && hit.current(), {
      root: root?.current ?? null,
      rootMargin: "240px 0px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, [target, root, enabled]);
};

export function ConversationsPage() {
  const first = useLoaderData() as ChannelPage;
  const [channels, setChannels] = useState<Channel[]>(first.channels);
  const [cursor, setCursor] = useState(first.nextCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const sentinel = useRef<HTMLDivElement>(null);

  // A clear revalidates the loader: start over from its first page.
  useEffect(() => {
    setChannels(first.channels);
    setCursor(first.nextCursor);
    setError("");
  }, [first]);

  const more = useCallback(async () => {
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const page = await get<ChannelPage>(`conversations?cursor=${encodeURIComponent(cursor)}`);
      setChannels((cur) => [...cur, ...page.channels.filter((c) => !cur.some((x) => x.channelId === c.channelId))]);
      setCursor(page.nextCursor);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [cursor, loading]);

  useSentinel(sentinel, undefined, !!cursor && !loading && !error, more);

  return (
    <>
      <h1>Conversations</h1>
      <p className="muted">What the bot remembers, per channel, most recently active first.</p>
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
      <div ref={sentinel} className="scroll-foot muted">
        {loading ? "loading more…" : error ? (
          <>could not load more: {error} <button className="link" onClick={() => void more()}>retry</button></>
        ) : cursor ? "" : channels.length > 0 ? `all ${channels.length} conversations` : ""}
      </div>
    </>
  );
}

const dayOf = (ms: number): string => fmtTime(ms).slice(0, 10);

/**
 * One conversation in reading order: oldest at the top, newest at the bottom,
 * opened scrolled to the newest. Scrolling up loads the page above, and the
 * view is shifted by exactly what was added so the line being read stays put.
 */
export function ConversationPage() {
  const first = useLoaderData() as ConversationView;
  const { channel } = useParams();
  const boot = useRouteLoaderData("root") as Bootstrap;
  const [messages, setMessages] = useState<Message[]>(first.messages);
  const [before, setBefore] = useState(first.nextBefore);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const top = useRef<HTMLDivElement>(null);
  /** The scroll height before older turns were prepended, to restore the position after. */
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const [opened, setOpened] = useState(0);

  useEffect(() => {
    setMessages(first.messages);
    setBefore(first.nextBefore);
    setError("");
    anchor.current = null;
    setOpened((n) => n + 1);
  }, [first]);

  // Open at the newest turn (and again after a clear reloads the page).
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [opened]);

  // After older turns land above, keep what was on screen where it was.
  useLayoutEffect(() => {
    const el = scroller.current;
    const a = anchor.current;
    if (!el || !a) return;
    el.scrollTop = a.top + (el.scrollHeight - a.height);
    anchor.current = null;
  }, [messages]);

  const older = useCallback(async () => {
    const el = scroller.current;
    if (!before || loading || !el || !channel) return;
    setLoading(true);
    try {
      const page = await get<ConversationView>(
        `conversation?channel=${encodeURIComponent(channel)}&before=${before}`,
      );
      anchor.current = { height: el.scrollHeight, top: el.scrollTop };
      setMessages((cur) => [...page.messages.filter((m) => !cur.some((x) => x.id === m.id)), ...cur]);
      setBefore(page.nextBefore);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [before, loading, channel]);

  // Only once the view has been put at the bottom, or it would load upwards at once.
  useSentinel(top, scroller, opened > 0 && !!before && !loading && !error, older);

  return (
    <>
      <p><Link to="/conversations">← back to conversations</Link></p>
      <div className="convo-head">
        <h1>{first.channel.label} <span className="pill">{first.total} turns</span></h1>
        <Form method="post">
          <input type="hidden" name="intent" value="clear" />
          <input type="hidden" name="channel" value={channel} />
          <button className="danger" type="submit">clear this channel's memory</button>
        </Form>
      </div>
      <div className="card convo-scroll" ref={scroller}>
        <div ref={top} className="scroll-foot muted">
          {loading ? "loading older turns…" : error ? (
            <>could not load older turns: {error} <button className="link" onClick={() => void older()}>retry</button></>
          ) : before ? "scroll up for older turns" : messages.length > 0 ? "start of the conversation" : ""}
        </div>
        {messages.length === 0 && <p className="muted convo-empty">No messages in this channel.</p>}
        {messages.map((m, i) => {
          const day = dayOf(m.createdAt);
          const newDay = i === 0 || dayOf(messages[i - 1]!.createdAt) !== day;
          return (
            <div key={m.id}>
              {newDay && <div className="day-rule"><span>{day}</span></div>}
              <div className={`bubble ${m.role}`}>
                <div className="bubble-meta">
                  <span className={`badge ${m.role}`}>{m.role === "assistant" ? boot?.botName ?? "bot" : "user"}</span>
                  <span>{m.userLabel}</span>
                  <span>{fmtTime(m.createdAt).slice(11)}</span>
                </div>
                <div className="bubble-content">{m.content}</div>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
