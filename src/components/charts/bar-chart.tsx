/**
 * Server-rendered SVG column chart for daily series (single or stacked).
 * Follows the dataviz method: one axis, thin columns with 4px rounded tops
 * anchored to the baseline, 2px surface gaps between stacked segments,
 * recessive grid, legend for ≥2 series, native per-bar hover tooltips, and
 * a table view (relief for sub-3:1 series contrast).
 */

export interface Series {
  key: string;
  label: string;
  color: string; // CSS color, e.g. "var(--series-1)"
}

export interface BarDatum {
  day: string; // YYYY-MM-DD
  values: number[];
}

const W = 640;
const H = 180;
const PAD = { top: 12, right: 8, bottom: 22, left: 32 };

function niceMax(v: number) {
  if (v <= 4) return Math.max(2, 2 * Math.ceil(v / 2)); // even, so the midline tick is a whole number
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

const fmtDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export function BarChart({ title, data, series, testId }: { title: string; data: BarDatum[]; series: Series[]; testId?: string }) {
  const totals = data.map((d) => d.values.reduce((a, b) => a + b, 0));
  const total = totals.reduce((a, b) => a + b, 0);
  const max = niceMax(Math.max(0, ...totals));
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const slot = innerW / data.length;
  const barW = Math.max(3, Math.min(14, slot - 4));
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH;
  const ticks = Number.isInteger(max / 2) ? [0, max / 2, max] : [0, max]; // counts: whole-number ticks only

  return (
    <figure className="grid gap-2" data-testid={testId}>
      <figcaption className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-xs text-muted-foreground tabular-nums">{total.toLocaleString("en-US")} in {data.length} days</span>
      </figcaption>
      {series.length > 1 ? (
        <ul className="flex flex-wrap gap-3 text-xs text-muted-foreground" aria-label="Legend">
          {series.map((s, i) => (
            <li key={s.key} className="flex items-center gap-1.5">
              <span className="inline-block size-2.5 rounded-sm" style={{ background: s.color }} aria-hidden />
              {s.label} <span className="tabular-nums">({data.reduce((a, d) => a + (d.values[i] ?? 0), 0).toLocaleString("en-US")})</span>
            </li>
          ))}
        </ul>
      ) : null}
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`${title}: ${total} total over ${data.length} days`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="var(--chart-grid)" strokeWidth={1} />
            <text x={PAD.left - 6} y={y(t) + 3} textAnchor="end" className="fill-muted-foreground" fontSize={10}>{Number.isInteger(t) ? t : t.toFixed(1)}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const x = PAD.left + i * slot + (slot - barW) / 2;
          let acc = 0;
          const segs = d.values.map((v, si) => {
            if (!v) return null;
            const y0 = y(acc);
            acc += v;
            const y1 = y(acc);
            const top = si === d.values.findLastIndex((n) => n > 0);
            const h = Math.max(1, y0 - y1 - (top ? 0 : 2)); // 2px gap between stacked segments
            return top ? (
              <path key={si} fill={series[si]!.color} d={`M${x},${y0} V${y0 - h + 4} q0,-4 4,-4 h${barW - 8} q4,0 4,4 V${y0} Z`} />
            ) : (
              <rect key={si} x={x} y={y0 - h} width={barW} height={h} fill={series[si]!.color} />
            );
          });
          const label = `${fmtDay(d.day)}: ${series.map((s, si) => `${d.values[si]} ${s.label.toLowerCase()}`).join(", ")}`;
          return (
            <g key={d.day}>
              <title>{label}</title>
              {segs}
              {/* Hit target larger than the mark */}
              <rect x={PAD.left + i * slot} y={PAD.top} width={slot} height={innerH} fill="transparent" />
            </g>
          );
        })}
        {data.map((d, i) =>
          // Weekly ticks counted back from the last day, so the newest day is always labelled and labels never collide.
          (data.length - 1 - i) % 7 === 0 ? (
            <text key={d.day} x={PAD.left + i * slot + slot / 2} y={H - 6} textAnchor="middle" className="fill-muted-foreground" fontSize={10}>{fmtDay(d.day)}</text>
          ) : null,
        )}
      </svg>
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">View as table</summary>
        <div className="mt-2 max-h-48 overflow-auto">
          <table className="w-full text-left tabular-nums">
            <thead><tr><th className="pr-3 font-medium">Day</th>{series.map((s) => <th key={s.key} className="pr-3 font-medium">{s.label}</th>)}</tr></thead>
            <tbody>{data.map((d) => <tr key={d.day}><td className="pr-3">{d.day}</td>{d.values.map((v, i) => <td key={i} className="pr-3">{v}</td>)}</tr>)}</tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
