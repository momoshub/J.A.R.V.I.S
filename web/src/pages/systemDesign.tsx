import {
  DEPLOY,
  FAILURES,
  LIMITS,
  RELATIONS,
  REQUIREMENTS,
  SEQUENCE,
  TABLES,
  fmtLimit,
  type DeployBox,
  type Table,
} from "../systemDesign.ts";

/* ---------- data model ---------- */

const ER = { colW: 250, gapX: 40, rowH: 26, headH: 46, gapY: 26, pad: 16 };
const tableH = (t: Table) => ER.headH + t.cols.length * ER.rowH + 8;

/** Tables sit in a grid of columns; each column stacks its tables top-down. */
const erLayout = () => {
  const pos = new Map<string, { x: number; y: number; h: number }>();
  const colTop = new Map<number, number>();
  for (const t of [...TABLES].sort((a, b) => a.col - b.col || a.row - b.row)) {
    const y = colTop.get(t.col) ?? ER.pad;
    const h = tableH(t);
    pos.set(t.name, { x: ER.pad + t.col * (ER.colW + ER.gapX), y, h });
    colTop.set(t.col, y + h + ER.gapY);
  }
  const cols = Math.max(...TABLES.map((t) => t.col)) + 1;
  return { pos, w: ER.pad * 2 + cols * ER.colW + (cols - 1) * ER.gapX, h: Math.max(...colTop.values()) - ER.gapY + ER.pad };
};

function DataModel() {
  const { pos, w, h } = erLayout();
  return (
    <svg className="sd-svg" viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Data model: tables and how they relate">
      <defs>
        <marker id="er-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" className="sd-arrow" />
        </marker>
      </defs>
      {RELATIONS.map((r) => {
        const a = pos.get(r.from);
        const b = pos.get(r.to);
        if (!a || !b) return null;
        const sameCol = a.x === b.x;
        // Same column: loop out on the right. Otherwise leave from the facing side.
        const ax = sameCol ? a.x + ER.colW : a.x < b.x ? a.x + ER.colW : a.x;
        const bx = sameCol ? b.x + ER.colW : a.x < b.x ? b.x : b.x + ER.colW;
        const ay = a.y + 22;
        const by = b.y + 22;
        const bulge = sameCol ? 34 : (bx - ax) / 2;
        const d = sameCol
          ? `M${ax},${ay} C${ax + bulge},${ay} ${bx + bulge},${by} ${bx},${by}`
          : `M${ax},${ay} C${ax + bulge},${ay} ${bx - bulge},${by} ${bx},${by}`;
        return (
          <g key={`${r.from}-${r.to}`} className="sd-rel">
            <path d={d} markerEnd="url(#er-arrow)" />
            <title>{`${r.from} -> ${r.to} on ${r.on}`}</title>
          </g>
        );
      })}
      {TABLES.map((t) => {
        const p = pos.get(t.name);
        if (!p) return null;
        return (
          <g key={t.name} transform={`translate(${p.x},${p.y})`} className={`sd-table ${t.db === "inbox.db" ? "other-db" : ""}`}>
            <rect width={ER.colW} height={p.h} rx={10} />
            <path d={`M0,${ER.headH - 4} H${ER.colW}`} className="sd-rule" />
            <text x={12} y={20} className="sd-table-name">{t.name}</text>
            <text x={12} y={35} className="sd-table-note">{t.db === "inbox.db" ? `${t.db} - ${t.note}` : t.note}</text>
            {t.cols.map((c, i) => (
              <g key={c.name} transform={`translate(12,${ER.headH + 14 + i * ER.rowH})`}>
                <text className={`sd-col ${c.key ?? ""}`}>{c.name}</text>
                {c.key && <text x={ER.colW - 24} textAnchor="end" className="sd-key">{c.key === "pk" ? "PK" : "ref"}</text>}
              </g>
            ))}
          </g>
        );
      })}
    </svg>
  );
}

/* ---------- sequence ---------- */

const SEQ = { laneW: 168, top: 64, stepH: 46, pad: 20 };

function Sequence() {
  const lanes = SEQUENCE.participants;
  const x = (id: string) => SEQ.pad + lanes.findIndex((p) => p.id === id) * SEQ.laneW + SEQ.laneW / 2;
  const w = SEQ.pad * 2 + lanes.length * SEQ.laneW;
  const h = SEQ.top + SEQUENCE.messages.length * SEQ.stepH + 30;
  return (
    <svg className="sd-svg" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Sequence diagram: ${SEQUENCE.title}`}>
      <defs>
        <marker id="seq-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" className="sd-arrow strong" />
        </marker>
      </defs>
      {lanes.map((p) => (
        <g key={p.id}>
          <line x1={x(p.id)} x2={x(p.id)} y1={SEQ.top - 6} y2={h - 10} className="sd-lifeline" />
          <rect x={x(p.id) - 70} y={8} width={140} height={44} rx={10} className="sd-lane-head" />
          <text x={x(p.id)} y={27} textAnchor="middle" className="sd-table-name">{p.label}</text>
          <text x={x(p.id)} y={42} textAnchor="middle" className="sd-table-note">{p.sub}</text>
        </g>
      ))}
      {SEQUENCE.messages.map((m, i) => {
        const y = SEQ.top + 26 + i * SEQ.stepH;
        const x1 = x(m.from);
        const x2 = x(m.to);
        if (x1 === x2) {
          return (
            <g key={i} className={`sd-msg ${m.kind}`}>
              <path d={`M${x1},${y - 8} h34 v16 h-30`} markerEnd="url(#seq-arrow)" />
              <text x={x1 + 42} y={y + 4} className="sd-msg-label">{`${i + 1}. ${m.label}`}</text>
            </g>
          );
        }
        const left = Math.min(x1, x2);
        return (
          <g key={i} className={`sd-msg ${m.kind}`}>
            <line x1={x1} x2={x2 + (x2 > x1 ? -4 : 4)} y1={y} y2={y} markerEnd="url(#seq-arrow)" />
            <text x={left + Math.abs(x2 - x1) / 2} y={y - 7} textAnchor="middle" className="sd-msg-label">{`${i + 1}. ${m.label}`}</text>
          </g>
        );
      })}
    </svg>
  );
}

/* ---------- deployment ---------- */

const centre = (b: DeployBox) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/** Point on a box's border facing another point. */
const edgeOf = (b: DeployBox, to: { x: number; y: number }) => {
  const c = centre(b);
  const dx = to.x - c.x;
  const dy = to.y - c.y;
  const s = Math.min((b.w / 2 + 3) / Math.abs(dx || 1e-9), (b.h / 2 + 3) / Math.abs(dy || 1e-9));
  return { x: c.x + dx * s, y: c.y + dy * s };
};

function Deployment() {
  const by = new Map(DEPLOY.boxes.map((b) => [b.id, b]));
  return (
    <svg className="sd-svg" viewBox={`0 0 ${DEPLOY.w} ${DEPLOY.h}`} role="img" aria-label="Deployment: processes, ports, files and services">
      <defs>
        <marker id="dep-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" className="sd-arrow" />
        </marker>
      </defs>
      {DEPLOY.boxes.filter((b) => b.kind === "zone").map((b) => (
        <g key={b.id}>
          <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={16} className="sd-zone" />
          <text x={b.x + 16} y={b.y + 24} className="sd-zone-label">{`${b.label} - ${b.sub}`}</text>
        </g>
      ))}
      {DEPLOY.links.map((l) => {
        const a = by.get(l.from);
        const b = by.get(l.to);
        if (!a || !b) return null;
        const p = edgeOf(a, centre(b));
        const q = edgeOf(b, centre(a));
        return (
          <g key={`${l.from}-${l.to}`} className="sd-rel">
            <line x1={p.x} y1={p.y} x2={q.x} y2={q.y} markerEnd="url(#dep-arrow)" />
            {l.label && (
              <text x={(p.x + q.x) / 2} y={(p.y + q.y) / 2 - 6} textAnchor="middle" className="sd-link-label">{l.label}</text>
            )}
          </g>
        );
      })}
      {DEPLOY.boxes.filter((b) => b.kind !== "zone").map((b) => (
        <g key={b.id} className={`sd-dep ${b.kind}`}>
          <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={b.kind === "file" ? 14 : 10} />
          <text x={b.x + b.w / 2} y={b.y + b.h / 2 - 3} textAnchor="middle" className="sd-table-name">{b.label}</text>
          <text x={b.x + b.w / 2} y={b.y + b.h / 2 + 13} textAnchor="middle" className="sd-table-note">{b.sub}</text>
        </g>
      ))}
    </svg>
  );
}

/* ---------- the sections ---------- */

const SECTIONS = [
  { id: "requirements", title: "Requirements" },
  { id: "limits", title: "Limits and numbers" },
  { id: "data-model", title: "Data model" },
  { id: "sequence", title: "A request, in sequence" },
  { id: "deployment", title: "Deployment" },
  { id: "failures", title: "Failure modes" },
];

/**
 * The static diagrams under the interactive one, in interview order. Every
 * figure comes from `systemDesign.ts`, which a test holds to the schema and
 * the constants it cites.
 */
export function SystemDesignSections() {
  return (
    <>
      <h2 id="system-design">System design</h2>
      <p className="muted">The same system, the way a design review walks it.</p>
      <nav className="sd-index" aria-label="System design sections">
        {SECTIONS.map((s, i) => (
          <a key={s.id} href={`#${s.id}`}><span>{i + 1}</span>{s.title}</a>
        ))}
      </nav>

      <h3 className="sd-h" id="requirements">1. Requirements</h3>
      <div className="sd-two">
        <div className="card sd-list">
          <b>Functional</b>
          <ul>{REQUIREMENTS.functional.map((r) => <li key={r}>{r}</li>)}</ul>
        </div>
        <div className="card sd-list">
          <b>Non-functional</b>
          <ul>{REQUIREMENTS.nonFunctional.map((r) => <li key={r}>{r}</li>)}</ul>
        </div>
      </div>

      <h3 className="sd-h" id="limits">2. Limits and numbers</h3>
      <p className="muted">Every value is read from the constant named beside it, and a test fails if they drift apart.</p>
      <div className="card table">
        <table>
          <thead><tr><th>limit</th><th>value</th><th>why</th><th>source</th></tr></thead>
          <tbody>
            {LIMITS.map((l) => (
              <tr key={l.source}>
                <td>{l.label}</td>
                <td className="sd-num">{fmtLimit(l)}</td>
                <td className="muted">{l.why}</td>
                <td><code>{l.source.split(":")[1]}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="sd-h" id="data-model">3. Data model</h3>
      <p className="muted">
        SQLite, no foreign keys: rows meet on shared keys, mostly the thread (<code>channel_id</code>, <code>thread_ts</code>)
        and the person (<code>slack_user_id</code>). The inbox is its own file, written by the gateway. Hover a line for the join.
      </p>
      <div className="card sd-stage"><DataModel /></div>

      <h3 className="sd-h" id="sequence">4. A request, in sequence</h3>
      <p className="muted">{SEQUENCE.title}: the same path as the first flow above, as messages over time. Dashed lines are replies.</p>
      <div className="card sd-stage"><Sequence /></div>

      <h3 className="sd-h" id="deployment">5. Deployment</h3>
      <p className="muted">One Mac. Two launchd agents, so restarting the bot never drops Slack. Everything listens on loopback; only the webhook is reachable, through Funnel.</p>
      <div className="card sd-stage"><Deployment /></div>

      <h3 className="sd-h" id="failures">6. Failure modes</h3>
      <div className="card table">
        <table>
          <thead><tr><th>what fails</th><th>how it is noticed</th><th>how it recovers</th></tr></thead>
          <tbody>
            {FAILURES.map((f) => (
              <tr key={f.failure}><td>{f.failure}</td><td className="muted">{f.detect}</td><td>{f.recover}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
