import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { get, type SlackMember } from "../api.ts";

/** What a pasted Slack user id looks like - the fallback when search has nobody. */
export const SLACK_ID = /^[UW][A-Z0-9]{6,}$/;

/** The person chosen: a member from search, or just an id that was pasted. */
export type Picked = { id: string; name: string; member?: SlackMember };

const DEBOUNCE_MS = 180;

const nameOf = (m: SlackMember): string => m.realName || m.displayName || m.handle || m.id;

const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("") || "?";

export function Avatar({ src, name, size = 32 }: { src?: string; name: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  return src && !broken ? (
    <img className="avatar" src={src} alt="" width={size} height={size} onError={() => setBroken(true)} />
  ) : (
    <span className="avatar avatar-initials" style={{ width: size, height: size }} aria-hidden>
      {initials(name)}
    </span>
  );
}

type Option = { kind: "member"; member: SlackMember } | { kind: "id"; id: string };

/**
 * Search the workspace by name, email or handle and pick a person. The server
 * filters a cached `users.list`, so each keystroke is one cheap local request.
 * A pasted Slack id is always offered too, for when the directory is down or
 * the person is not in it.
 */
export function MemberPicker({ picked, onPick }: { picked?: Picked; onPick: (p: Picked | undefined) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SlackMember[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState("");
  const seq = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();

  useEffect(() => {
    const q = query.trim();
    const mine = ++seq.current;
    if (!q) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = setTimeout(() => {
      get<{ members: SlackMember[] }>(`slack/members?q=${encodeURIComponent(q)}`)
        .then((r) => {
          if (seq.current !== mine) return;
          setResults(r.members);
          setProblem("");
          setActive(0);
        })
        .catch((e: unknown) => {
          if (seq.current !== mine) return;
          setResults([]);
          setProblem(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (seq.current === mine) setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const raw = query.trim().toUpperCase();
  const options: Option[] = [
    ...results.map((member): Option => ({ kind: "member", member })),
    ...(SLACK_ID.test(raw) && !results.some((m) => m.id === raw) ? [{ kind: "id", id: raw } as Option] : []),
  ];

  const choose = (o: Option) => {
    onPick(o.kind === "member" ? { id: o.member.id, name: nameOf(o.member), member: o.member } : { id: o.id, name: "" });
    setQuery("");
    setOpen(false);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, Math.max(0, options.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      const o = options[active];
      if (open && o) {
        e.preventDefault();
        choose(o);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  if (picked) {
    const m = picked.member;
    return (
      <div className="picked">
        <Avatar src={m?.avatar} name={picked.name || picked.id} size={36} />
        <div className="picked-text">
          <b>{picked.name || picked.id}</b>
          <span className="muted">
            {m ? [m.displayName && `@${m.displayName}`, m.title].filter(Boolean).join(" · ") || m.id : "pasted Slack id"}
            {m && <code>{m.id}</code>}
          </span>
        </div>
        <button
          type="button"
          className="link"
          onClick={() => {
            onPick(undefined);
            requestAnimationFrame(() => input.current?.focus());
          }}
        >
          change
        </button>
      </div>
    );
  }

  const q = query.trim();
  return (
    <div className="picker">
      <svg className="picker-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden>
        <circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <input
        ref={input}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={onKey}
        placeholder="Search by name, email or @handle, or paste a Slack id"
        role="combobox"
        aria-expanded={open && options.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        spellCheck={false}
      />
      {loading && <span className="picker-spin" aria-hidden />}
      {open && q && (
        <div className="picker-menu" id={listId} role="listbox">
          {options.map((o, i) =>
            o.kind === "member" ? (
              <button
                type="button"
                role="option"
                aria-selected={i === active}
                key={o.member.id}
                className={`picker-opt${i === active ? " on" : ""}`}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(o)}
              >
                <Avatar src={o.member.avatar} name={nameOf(o.member)} />
                <span className="picker-opt-text">
                  <span>
                    <b>{nameOf(o.member)}</b>
                    {o.member.displayName && o.member.displayName !== nameOf(o.member) && (
                      <span className="muted"> @{o.member.displayName}</span>
                    )}
                  </span>
                  <span className="muted picker-sub">{o.member.title || `@${o.member.handle}`}</span>
                </span>
                {o.member.role && <span className={`badge ${o.member.role}`}>already {o.member.role}</span>}
              </button>
            ) : (
              <button
                type="button"
                role="option"
                aria-selected={i === active}
                key={`id-${o.id}`}
                className={`picker-opt${i === active ? " on" : ""}`}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(o)}
              >
                <span className="avatar avatar-initials">#</span>
                <span className="picker-opt-text">
                  <span>Use Slack id <code>{o.id}</code></span>
                  <span className="muted picker-sub">the name fills in from Slack when they next write</span>
                </span>
              </button>
            ),
          )}
          {!loading && options.length === 0 && (
            <div className="picker-empty muted">
              {problem ? `${problem}. You can still paste a Slack id (U…).` : `Nobody in the workspace matches "${q}".`}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
