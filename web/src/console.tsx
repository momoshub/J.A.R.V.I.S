import { useCallback, useEffect, useState } from "react";
import {
  fmtSlackTs,
  get,
  post,
  type SlackConversation,
  type SlackMessage,
} from "./api.ts";

type Mode = "all" | "own" | "mentions";
type Editing = { ts: string; text: string } | null;
type Target = { threadTs?: string; label: string };

/**
 * Slack console - the web port of Jarvis's terminal message manager. Browse a
 * conversation, read a thread, edit/delete the bot's own messages, reply, and
 * generate an AI draft into the composer before sending.
 */
export function ConsolePage() {
  const [convos, setConvos] = useState<SlackConversation[]>([]);
  const [channel, setChannel] = useState("");
  const [convoFilter, setConvoFilter] = useState("");
  const [messages, setMessages] = useState<SlackMessage[]>([]);
  const [limit, setLimit] = useState(30);
  const [filter, setFilter] = useState("");
  const [mode, setMode] = useState<Mode>("all");
  const [thread, setThread] = useState<{ root: string; messages: SlackMessage[] } | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [target, setTarget] = useState<Target>({ label: "channel" });
  const [composer, setComposer] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const run = useCallback(async (fn: () => Promise<void>, note = "") => {
    setError("");
    setBusy(true);
    if (note) setStatus(note);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setStatus("");
    }
  }, []);

  useEffect(() => {
    run(async () => {
      const list = await get<SlackConversation[]>("slack/conversations");
      setConvos(list);
      // Open the most recently active conversation by default.
      setChannel((cur) => cur || list[0]?.id || "");
    });
  }, [run]);

  const loadHistory = useCallback(
    (ch: string, lim: number) =>
      run(async () => {
        setThread(null);
        setMessages(await get<SlackMessage[]>(`slack/history?channel=${encodeURIComponent(ch)}&limit=${lim}`));
      }),
    [run],
  );

  useEffect(() => {
    if (channel) loadHistory(channel, limit);
  }, [channel, limit, loadHistory]);

  const openThread = (m: SlackMessage) =>
    run(async () => {
      const root = m.threadTs ?? m.ts;
      setThread({ root, messages: await get<SlackMessage[]>(`slack/thread?channel=${encodeURIComponent(channel)}&ts=${root}`) });
      setTarget({ threadTs: root, label: "thread" });
    });

  const refresh = () => {
    loadHistory(channel, limit);
    if (thread) run(async () => setThread({ root: thread.root, messages: await get<SlackMessage[]>(`slack/thread?channel=${encodeURIComponent(channel)}&ts=${thread.root}`) }));
  };

  const send = () =>
    run(async () => {
      await post("slack/post", { channel, text: composer, threadTs: target.threadTs });
      setComposer("");
      refresh();
    }, "posting...");

  const draft = () =>
    run(async () => {
      const { draft } = await post<{ draft: string }>("slack/draft", { channel, threadTs: target.threadTs });
      setComposer(draft);
    }, "drafting...");

  const saveEdit = () =>
    run(async () => {
      if (!editing) return;
      await post("slack/update", { channel, ts: editing.ts, text: editing.text });
      setEditing(null);
      refresh();
    }, "saving...");

  const del = (m: SlackMessage) => {
    if (!confirm("Delete this message?")) return;
    run(async () => {
      await post("slack/delete", { channel, ts: m.ts });
      refresh();
    }, "deleting...");
  };

  const shown = messages.filter((m) => {
    if (mode === "own" && !m.own) return false;
    if (mode === "mentions" && !m.mentionsBot) return false;
    if (filter && !m.text.toLowerCase().includes(filter.toLowerCase())) return false;
    return true;
  });

  const convoOptions = convos.filter((c) => c.name.toLowerCase().includes(convoFilter.toLowerCase()));

  const ago = (ms: number): string => {
    if (!ms) return "";
    const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (s < 90) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  };

  const marker = (m: SlackMessage) =>
    m.own ? <span className="badge assistant" title="your message">✎</span> : m.mentionsBot ? <span className="badge user" title="mentions you">@</span> : <span className="mk-space" />;

  const Row = (m: SlackMessage, inThread = false) => (
    <div className={`msg${m.own ? " own" : ""}`} key={m.ts}>
      <div className="msg-head">
        {marker(m)}
        <strong>{m.userName}</strong>
        <span className="muted">{fmtSlackTs(m.ts)}</span>
        {!inThread && m.replyCount > 0 && <span className="pill">{m.replyCount} replies</span>}
        <span className="msg-actions">
          {!inThread && (
            <button className="link" onClick={() => openThread(m)}>thread</button>
          )}
          <button className="link" onClick={() => setTarget({ threadTs: m.threadTs ?? m.ts, label: "reply" })}>reply</button>
          {m.own && <button className="link" onClick={() => setEditing({ ts: m.ts, text: m.text })}>edit</button>}
          {m.own && <button className="link danger-link" onClick={() => del(m)}>delete</button>}
        </span>
      </div>
      {editing?.ts === m.ts ? (
        <div className="stack">
          <textarea value={editing.text} onChange={(e) => setEditing({ ts: m.ts, text: e.target.value })} rows={3} />
          <div className="row">
            <button onClick={saveEdit} disabled={busy}>save</button>
            <button className="ghost" onClick={() => setEditing(null)}>cancel</button>
          </div>
        </div>
      ) : (
        <div className="msg-body">{m.text || <span className="muted">(no text)</span>}</div>
      )}
    </div>
  );

  return (
    <>
      <h1>Console</h1>
      <p className="muted">Manage the bot's live Slack messages. Read threads, edit or delete its own messages, reply, and generate an AI draft to review before posting.</p>
      {error && <div className="banner error">{error}</div>}
      {status && <div className="banner ok">{status}</div>}

      <div className="row">
        <input placeholder="filter conversations..." value={convoFilter} onChange={(e) => setConvoFilter(e.target.value)} style={{ minWidth: 220 }} />
        <select value={channel} onChange={(e) => setChannel(e.target.value)} style={{ minWidth: 240 }}>
          <option value="">select a conversation...</option>
          {convoOptions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}{c.lastActive ? ` · ${ago(c.lastActive)}` : ""}
            </option>
          ))}
        </select>
        <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
          {[15, 30, 50].map((n) => <option key={n} value={n}>{n} msgs</option>)}
        </select>
        <button className="ghost" onClick={refresh} disabled={!channel || busy}>refresh</button>
      </div>

      {channel && (
        <div className="row">
          <input placeholder="search messages..." value={filter} onChange={(e) => setFilter(e.target.value)} style={{ flex: 1 }} />
          <div className="seg">
            {(["all", "own", "mentions"] as Mode[]).map((m) => (
              <button key={m} className={mode === m ? "seg-on" : ""} onClick={() => setMode(m)}>{m}</button>
            ))}
          </div>
        </div>
      )}

      {thread && (
        <div className="card thread">
          <div className="thread-head">
            <strong>Thread</strong>
            <button className="link" onClick={() => { setThread(null); setTarget({ label: "channel" }); }}>close</button>
          </div>
          {thread.messages.map((m) => Row(m, true))}
        </div>
      )}

      {channel && !thread && (
        <div className="card msgs">
          {shown.length === 0 && <p className="muted" style={{ padding: 16 }}>No messages.</p>}
          {shown.map((m) => Row(m))}
        </div>
      )}

      {channel && (
        <div className="composer card">
          <div className="composer-target">
            replying to: <span className="pill">{target.label}</span>
            {target.threadTs && <button className="link" onClick={() => setTarget({ label: "channel" })}>post to channel instead</button>}
          </div>
          <textarea placeholder="write a message, or hit AI draft..." value={composer} onChange={(e) => setComposer(e.target.value)} rows={4} />
          <div className="row">
            <button onClick={send} disabled={busy || !composer.trim()}>send</button>
            <button className="ghost" onClick={draft} disabled={busy}>✨ AI draft</button>
          </div>
        </div>
      )}
    </>
  );
}
