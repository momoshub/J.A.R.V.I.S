/**
 * Small hand-drawn charts for the overview: a day series as an area or as
 * bars, and a ranked list as horizontal bars. No chart library - three shapes
 * do not earn a dependency, and SVG drawn here takes its colours from the
 * theme's CSS variables, so dark mode needs nothing extra.
 *
 * One series per chart and one axis per chart, always: two measures of
 * different scale get two charts. Every plot has a hover tooltip, and the
 * numbers stay in text colours - the accent only marks the data.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

export type DayPoint = { date: string; value: number; detail?: ReactNode };

const HEIGHT = 190;
const PAD = { top: 12, right: 12, bottom: 26, left: 44 };

/** The smallest 1/2/5 x 10^k at or above `v`, so gridlines land on round numbers. */
export const niceMax = (v: number): number => {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 5, 10].find((m) => m * p >= v) ?? 10) * p;
};

const shortDate = (d: string): string => {
  const [, m, day] = d.split("-");
  return `${Number(day)}/${Number(m)}`;
};

/** The element's width, kept current, so the SVG is drawn in real pixels (no stretched text). */
const useWidth = () => {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
};

type Props = {
  data: readonly DayPoint[];
  kind: "area" | "bar";
  format?: (v: number) => string;
  /** Read out for screen readers; the visible title sits outside the chart. */
  label: string;
};

export function DayChart({ data, kind, format = (v) => String(Math.round(v)), label }: Props) {
  const { ref, width } = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const n = data.length;
  const max = niceMax(Math.max(0, ...data.map((d) => d.value)));
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const step = n > 0 ? plotW / n : 0;
  // Bars sit in slots; a line's points sit at slot centres, so both read the same days.
  const x = (i: number) => PAD.left + step * (i + 0.5);
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
  const ticks = [0, max / 2, max];
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotW / 64))));

  const line = data.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(d.value).toFixed(1)}`).join("");
  const area = n ? `${line}L${x(n - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z` : "";
  const barW = Math.max(1, step - 2);

  const onMove = (clientX: number, el: SVGRectElement) => {
    const box = el.getBoundingClientRect();
    const i = Math.floor((clientX - box.left) / (box.width / Math.max(1, n)));
    setHover(Math.min(n - 1, Math.max(0, i)));
  };

  const h = hover === null ? undefined : data[hover];
  const tipLeft = hover === null ? 0 : Math.min(Math.max(x(hover), 70), Math.max(70, width - 70));

  return (
    <div className="chart" ref={ref}>
      {width > 0 && (
        <svg width={width} height={HEIGHT} role="img" aria-label={label}>
          {ticks.map((t) => (
            <g key={t}>
              <line className="chart-grid" x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
              <text className="chart-tick" x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end">
                {format(t)}
              </text>
            </g>
          ))}
          {data.map((d, i) =>
            i % labelEvery === (n - 1) % labelEvery ? (
              <text key={d.date} className="chart-tick" x={x(i)} y={HEIGHT - 8} textAnchor="middle">
                {shortDate(d.date)}
              </text>
            ) : null,
          )}
          {kind === "area" ? (
            <>
              <path className="chart-area" d={area} />
              <path className="chart-line" d={line} />
            </>
          ) : (
            data.map((d, i) => {
              const top = y(d.value);
              const hgt = Math.max(0, y(0) - top);
              const r = Math.min(4, barW / 2, hgt);
              const left = x(i) - barW / 2;
              // Rounded only at the data end; flat on the baseline.
              return hgt > 0 ? (
                <path
                  key={d.date}
                  className={`chart-bar${hover === i ? " on" : ""}`}
                  d={`M${left},${y(0)}V${top + r}Q${left},${top} ${left + r},${top}H${left + barW - r}Q${left + barW},${top} ${left + barW},${top + r}V${y(0)}Z`}
                />
              ) : null;
            })
          )}
          {h && hover !== null && (
            <g pointerEvents="none">
              <line className="chart-cross" x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={y(0)} />
              {kind === "area" && <circle className="chart-dot" cx={x(hover)} cy={y(h.value)} r={4.5} />}
            </g>
          )}
          <rect
            x={PAD.left}
            y={PAD.top}
            width={plotW}
            height={plotH}
            fill="transparent"
            onMouseMove={(e) => onMove(e.clientX, e.currentTarget)}
            onTouchStart={(e) => e.touches[0] && onMove(e.touches[0].clientX, e.currentTarget)}
            onMouseLeave={() => setHover(null)}
          />
        </svg>
      )}
      {h && (
        <div className="chart-tip" style={{ left: tipLeft }}>
          <div className="muted">{h.date}</div>
          <b>{format(h.value)}</b>
          {h.detail && <div className="chart-tip-detail">{h.detail}</div>}
        </div>
      )}
    </div>
  );
}

export type Rank = { key: string; label: ReactNode; value: number; note?: ReactNode };

/** A ranked list as horizontal bars, longest first; the number is text beside the bar. */
export function RankBars({ rows, format = String, empty }: { rows: readonly Rank[]; format?: (v: number) => string; empty: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (rows.length === 0) return <p className="muted rank-empty">{empty}</p>;
  return (
    <ol className="rank">
      {rows.map((r) => (
        <li key={r.key} title={typeof r.note === "string" ? r.note : undefined}>
          <div className="rank-label">
            <span>{r.label}</span>
            <span className="rank-n">{format(r.value)}</span>
          </div>
          <div className="rank-track">
            <i style={{ width: `${(r.value / max) * 100}%` }} />
          </div>
          {r.note && <div className="rank-note muted">{r.note}</div>}
        </li>
      ))}
    </ol>
  );
}
