import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  CANVAS,
  DECISIONS,
  EDGES,
  FLOWS,
  LAYERS,
  NODE,
  NODES,
  curveAt,
  wireCurve,
  type Flow,
  type FlowStep,
  type SysEdge,
  type SysNode,
} from "../systemModel.ts";

const byId = new Map(NODES.map((n) => [n.id, n]));
/** `checkModel` (tested) guarantees every id a flow or wire names is here. */
const node = (id: string): SysNode => {
  const n = byId.get(id);
  if (!n) throw new Error(`architecture: no box ${id}`);
  return n;
};
const NO_FLOW: Flow = { id: "", title: "", blurb: "", steps: [] };

const f1 = (n: number) => n.toFixed(1);
const wirePath = (e: SysEdge): string => {
  const [p, c, q] = wireCurve(e, node(e.from), node(e.to));
  return `M${f1(p.x)},${f1(p.y)} Q${f1(c.x)},${f1(c.y)} ${f1(q.x)},${f1(q.y)}`;
};

const edgeKey = (from: string, to: string) => `${from}>${to}`;
const STEP_MS = 1900;

/**
 * The dot that travels a wire. SMIL times count from page load, so an
 * animation added later with the default begin is already over and the dot
 * would sit at the end. It waits on `indefinite` and is started on mount,
 * before paint, so it never shows at the canvas origin either.
 */
function Packet({ path }: { path: string }) {
  const motion = useRef<SVGAnimateMotionElement>(null);
  useLayoutEffect(() => {
    motion.current?.beginElement();
  }, []);
  return (
    <circle r={6} className="arch-packet">
      <animateMotion ref={motion} begin="indefinite" dur={`${STEP_MS * 0.7}ms`} fill="freeze" path={path} />
    </circle>
  );
}

const KIND_LABEL: Record<SysNode["kind"], string> = {
  external: "outside the host",
  process: "process / listener",
  module: "module",
  store: "storage",
  timer: "timer",
};

function Diagram({
  step,
  index,
  visited,
  selected,
  onSelect,
}: {
  step?: FlowStep;
  index: number;
  visited: Set<string>;
  selected: string;
  onSelect: (id: string) => void;
}) {
  const live = step && !("at" in step) ? edgeKey(step.from, step.to) : "";
  const focus = new Set<string>(step ? ("at" in step ? [step.at] : [step.from, step.to]) : []);
  return (
    <svg className="arch-svg" viewBox={`0 0 ${CANVAS.w} ${CANVAS.h}`} role="group" aria-label="System diagram: click a box for details">
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" className="arch-arrow" />
        </marker>
        <marker id="arrow-live" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" className="arch-arrow live" />
        </marker>
      </defs>

      {/* host boundary: everything that runs on the one machine */}
      <rect className="arch-zone" x={20} y={112} width={1060} height={512} rx={18} />
      <text className="arch-zone-label" x={36} y={134}>one host</text>

      {EDGES.map((e) => {
        const k = edgeKey(e.from, e.to);
        const on = k === live;
        const seen = visited.has(k);
        const d = wirePath(e);
        return (
          <g key={k} className={`arch-edge${on ? " live" : ""}${seen ? " seen" : ""}`}>
            <path id={`w-${k}`} d={d} markerEnd={on ? "url(#arrow-live)" : "url(#arrow)"} />
            {on && <Packet key={`${k}-${index}`} path={d} />}
          </g>
        );
      })}

      {EDGES.map((e) => {
        const k = edgeKey(e.from, e.to);
        if (k !== live) return null;
        const mid = curveAt(wireCurve(e, node(e.from), node(e.to)), 0.5);
        return (
          <text key={`l-${k}`} className="arch-edge-label" x={mid.x} y={mid.y - 8} textAnchor="middle">
            {e.label}
          </text>
        );
      })}

      {NODES.map((n) => (
        <g
          key={n.id}
          className={`arch-node ${n.kind}${focus.has(n.id) ? " focus" : ""}${selected === n.id ? " selected" : ""}`}
          transform={`translate(${n.x - NODE.w / 2},${n.y - NODE.h / 2})`}
          onClick={() => onSelect(n.id)}
          role="button"
          tabIndex={0}
          aria-label={`${n.label}, ${n.sub}`}
          aria-pressed={selected === n.id}
          onKeyDown={(ev) => {
            if (ev.key !== "Enter" && ev.key !== " ") return;
            ev.preventDefault();
            onSelect(n.id);
          }}
        >
          <rect width={NODE.w} height={NODE.h} rx={n.kind === "store" ? 16 : 10} />
          <text x={NODE.w / 2} y={21} textAnchor="middle" className="arch-node-title">{n.label}</text>
          <text x={NODE.w / 2} y={37} textAnchor="middle" className="arch-node-sub">{n.sub}</text>
        </g>
      ))}
    </svg>
  );
}

/**
 * Architecture - how the bot is built, as a system design walkthrough.
 *
 * Pick a request flow and play it: a packet travels each wire in order while
 * the step explains what happens there. Click any box to see what it is for
 * and where it lives in the source. Everything is drawn from `systemModel.ts`.
 */
export function ArchitecturePage() {
  const [flowId, setFlowId] = useState(FLOWS[0]?.id ?? "");
  const [index, setIndex] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [selected, setSelected] = useState("respond");
  const flow = FLOWS.find((f) => f.id === flowId) ?? FLOWS[0] ?? NO_FLOW;
  const step = index >= 0 ? flow.steps[index] : undefined;

  const visited = useMemo(() => {
    const s = new Set<string>();
    flow.steps.slice(0, index + 1).forEach((st) => {
      if (!("at" in st)) s.add(edgeKey(st.from, st.to));
    });
    return s;
  }, [flow, index]);

  useEffect(() => {
    if (!playing) return;
    if (index >= flow.steps.length - 1) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setIndex((i) => i + 1), index < 0 ? 150 : STEP_MS);
    return () => clearTimeout(t);
  }, [playing, index, flow]);

  // A step that lands on a box shows that box in the inspector.
  useEffect(() => {
    if (step) setSelected("at" in step ? step.at : step.to);
  }, [step]);

  const pick = (id: string) => {
    setFlowId(id);
    setIndex(-1);
    setPlaying(false);
  };
  const play = () => {
    if (index >= flow.steps.length - 1) setIndex(-1);
    setPlaying(true);
  };
  const inspected = node(selected);

  return (
    <>
      <h1>Architecture</h1>
      <p className="muted">
        How the bot is put together, as a system design walkthrough. Pick a request, press play and follow it across
        the boxes. Click any box to see what it does and where it lives.
      </p>

      <div className="seg flows">
        {FLOWS.map((f) => (
          <button key={f.id} type="button" className={f.id === flowId ? "seg-on" : ""} aria-pressed={f.id === flowId} onClick={() => pick(f.id)}>
            {f.title}
          </button>
        ))}
      </div>

      <div className="arch">
        <div className="card arch-stage">
          <Diagram step={step} index={index} visited={visited} selected={selected} onSelect={setSelected} />
          <div className="arch-legend">
            {(Object.keys(KIND_LABEL) as SysNode["kind"][]).map((k) => (
              <span key={k}><i className={`swatch ${k}`} />{KIND_LABEL[k]}</span>
            ))}
          </div>
        </div>

        <aside className="arch-side">
          <div className="card arch-player">
            <div className="arch-player-head">
              <b>{flow.title}</b>
              <span className="muted">{flow.blurb}</span>
            </div>
            <div className="row arch-controls">
              {playing ? (
                <button type="button" onClick={() => setPlaying(false)}>pause</button>
              ) : (
                <button type="button" onClick={play}>{index < 0 ? "play" : index >= flow.steps.length - 1 ? "replay" : "resume"}</button>
              )}
              <button type="button" className="ghost" disabled={index < 0} onClick={() => { setPlaying(false); setIndex((i) => Math.max(-1, i - 1)); }}>back</button>
              <button type="button" className="ghost" disabled={index >= flow.steps.length - 1} onClick={() => { setPlaying(false); setIndex((i) => i + 1); }}>next</button>
              <span className="muted arch-count">{Math.max(0, index + 1)} / {flow.steps.length}</span>
            </div>
            <ol className="arch-steps">
              {flow.steps.map((s, i) => (
                <li
                  key={i}
                  className={i === index ? "on" : i < index ? "done" : ""}
                  onClick={() => { setPlaying(false); setIndex(i); }}
                >
                  <code>{"at" in s ? node(s.at).label : `${node(s.from).label} -> ${node(s.to).label}`}</code>
                  <span>{s.note}</span>
                </li>
              ))}
            </ol>
          </div>

          <div className="card arch-inspect">
            <div className="muted arch-kind">{KIND_LABEL[inspected.kind]}</div>
            <h3>{inspected.label}</h3>
            <p>{inspected.about}</p>
            {inspected.files.length > 0 && (
              <div className="arch-files">
                {inspected.files.map((f) => <code key={f}>{f}</code>)}
              </div>
            )}
            <div className="arch-links">
              {EDGES.filter((e) => e.from === inspected.id || e.to === inspected.id).map((e) => (
                <button
                  key={edgeKey(e.from, e.to)}
                  type="button"
                  className="link"
                  onClick={() => setSelected(e.from === inspected.id ? e.to : e.from)}
                >
                  {e.from === inspected.id ? `-> ${node(e.to).label}` : `<- ${node(e.from).label}`}
                  <span className="muted"> {e.label}</span>
                </button>
              ))}
            </div>
          </div>
        </aside>
      </div>

      <h2>Layers</h2>
      <p className="muted">Clean architecture: dependencies point inward, functional throughout, no classes.</p>
      <div className="layers">
        {LAYERS.map((l, i) => (
          <div className="card layer" key={l.name} style={{ marginLeft: `${i * 4}%`, marginRight: `${i * 4}%` }}>
            <b>{l.name}</b>
            <span>{l.rule}</span>
            <code>{l.examples}</code>
          </div>
        ))}
      </div>

      <h2>Design decisions</h2>
      <p className="muted">Each choice, and what it costs.</p>
      <div className="tiles decisions">
        {DECISIONS.map((d) => (
          <div className="card decision" key={d.title}>
            <b>{d.title}</b>
            <p>{d.body}</p>
            <p className="muted"><em>Trade-off:</em> {d.cost}</p>
          </div>
        ))}
      </div>
    </>
  );
}
