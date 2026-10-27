/**
 * IDEA's result chart: one numeric column (Y) against a category column (X)
 * as bars or a line, with the Y values of equal X combined (sum, average…).
 */
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { IconButton, Select, T } from "@/ui";
import { isNumericColumn, type GridColumn } from "./Grid";
import type { Cell } from "./model";
import { chartSeries, formatNumber, niceTicks, type ChartAggregate } from "./resultView";
import styles from "./Database.module.css";

const AGGREGATES: ReadonlyArray<{ value: ChartAggregate; label: string }> = [
  { value: "none", label: "No aggregation" },
  { value: "sum", label: "Sum" },
  { value: "avg", label: "Mean" },
  { value: "count", label: "Count" },
  { value: "min", label: "Min" },
  { value: "max", label: "Max" },
];

const PAD = { left: 64, right: 16, top: 12, bottom: 44 };

const grouped = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 });

export function ChartView({ columns, rows }: { columns: readonly GridColumn[]; rows: ReadonlyArray<readonly Cell[]> }) {
  const numeric = useMemo(
    () =>
      columns.map((c, i) =>
        isNumericColumn(
          c.type,
          rows.slice(0, 50).map((r) => r[i] ?? null),
        ),
      ),
    [columns, rows],
  );
  const firstText = numeric.findIndex((n) => !n);
  const [x, setX] = useState(Math.max(0, firstText));
  const [y, setY] = useState(() => {
    const n = numeric.findLastIndex((isNum, i) => isNum && i !== Math.max(0, firstText));
    return n >= 0 ? n : Math.min(1, columns.length - 1);
  });
  const [kind, setKind] = useState<"bar" | "line">("bar");
  // IDEA combines equal X values with their mean unless told otherwise.
  const [aggregate, setAgg] = useState<ChartAggregate>("avg");
  const [settings, setSettings] = useState(false);
  const points = useMemo(() => chartSeries(rows, x, y, aggregate), [rows, x, y, aggregate]);

  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 600, h: 300 });
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const options = columns.map((c, i) => ({ value: String(i), label: c.name }));
  const values = points.map((p) => p.value);
  const ticks = niceTicks(
    Math.min(0, ...values),
    Math.max(0, ...values),
    Math.max(2, Math.floor((size.h - PAD.top - PAD.bottom) / 32)),
  );
  const lo = ticks[0] ?? 0;
  const hi = ticks.at(-1) ?? 1;
  const plotW = Math.max(1, size.w - PAD.left - PAD.right);
  const plotH = Math.max(1, size.h - PAD.top - PAD.bottom);
  const yAt = (v: number) => PAD.top + plotH - ((v - lo) / (hi - lo || 1)) * plotH;
  const band = plotW / Math.max(1, points.length);
  const xAt = (i: number) => PAD.left + band * i + band / 2;
  // Every n-th label so they do not overlap.
  const labelEvery = Math.max(1, Math.ceil(points.length / Math.max(1, Math.floor(plotW / 72))));
  const yName = `${columns[y]?.name ?? ""}${aggregate === "none" ? "" : ` (${AGGREGATES.find((a) => a.value === aggregate)!.label.toLowerCase()})`}`;

  return (
    <div className={styles.view}>
      {settings && (
        <div className={styles.chartBar}>
          <span className={styles.formLabel}>
            <T>X:</T>
          </span>
          <Select aria-label="X axis" value={String(x)} options={options} onChange={(v) => setX(Number(v))} />
          <span className={styles.formLabel}>
            <T>Y:</T>
          </span>
          <Select aria-label="Y axis" value={String(y)} options={options} onChange={(v) => setY(Number(v))} />
          <Select
            aria-label="Aggregation"
            value={aggregate}
            options={AGGREGATES.map((a) => ({ ...a }))}
            onChange={(v) => setAgg(v as ChartAggregate)}
          />
          <Select
            aria-label="Chart type"
            value={kind}
            options={[
              { value: "bar", label: "Bar" },
              { value: "line", label: "Line" },
            ]}
            onChange={(v) => setKind(v as "bar" | "line")}
          />
        </div>
      )}
      <div ref={host} className={styles.chartHost}>
        <IconButton
          className={styles.chartSettings}
          icon="settings"
          title="Chart Settings"
          aria-pressed={settings}
          onClick={() => setSettings(!settings)}
        />
        {!points.length ? (
          <div className={styles.filterEmpty}>
            <T>No numeric values to plot</T>
          </div>
        ) : (
          <svg width={size.w} height={size.h} role="img" aria-label={`${yName} by ${columns[x]?.name ?? ""}`}>
            {ticks.map((t) => (
              <g key={t}>
                <line className={styles.chartGrid} x1={PAD.left} x2={PAD.left + plotW} y1={yAt(t)} y2={yAt(t)} />
                <text
                  className={styles.chartTick}
                  x={PAD.left - 6}
                  y={yAt(t)}
                  textAnchor="end"
                  dominantBaseline="middle"
                >
                  {grouped.format(t)}
                </text>
              </g>
            ))}
            {points.map((_, i) => (
              <line
                key={i}
                className={styles.chartGrid}
                x1={PAD.left + band * (i + 1)}
                x2={PAD.left + band * (i + 1)}
                y1={PAD.top}
                y2={PAD.top + plotH}
              />
            ))}
            {kind === "bar"
              ? points.map((p, i) => (
                  <rect
                    key={i}
                    className={styles.chartBarMark}
                    x={PAD.left + band * i + band * 0.05}
                    width={band * 0.9}
                    y={Math.min(yAt(p.value), yAt(0))}
                    height={Math.abs(yAt(0) - yAt(p.value))}
                  >
                    <title>{`${p.label}: ${formatNumber(p.value)}`}</title>
                  </rect>
                ))
              : [
                  <polyline
                    key="line"
                    className={styles.chartLine}
                    points={points.map((p, i) => `${xAt(i)},${yAt(p.value)}`).join(" ")}
                  />,
                  ...points.map((p, i) => (
                    <circle key={i} className={styles.chartDot} cx={xAt(i)} cy={yAt(p.value)} r={3}>
                      <title>{`${p.label}: ${formatNumber(p.value)}`}</title>
                    </circle>
                  )),
                ]}
            <line className={styles.chartAxis} x1={PAD.left} x2={PAD.left + plotW} y1={yAt(0)} y2={yAt(0)} />
            {points.map((p, i) =>
              i % labelEvery ? null : (
                <text key={i} className={styles.chartTick} x={xAt(i)} y={PAD.top + plotH + 14} textAnchor="middle">
                  {p.label.length > 14 ? `${p.label.slice(0, 13)}…` : p.label}
                </text>
              ),
            )}
            <text className={styles.chartAxisName} x={PAD.left + plotW / 2} y={size.h - 6} textAnchor="middle">
              {columns[x]?.name}
            </text>
            <text
              className={styles.chartAxisName}
              transform={`translate(12 ${PAD.top + plotH / 2}) rotate(-90)`}
              textAnchor="middle"
            >
              {yName}
            </text>
          </svg>
        )}
      </div>
    </div>
  );
}
