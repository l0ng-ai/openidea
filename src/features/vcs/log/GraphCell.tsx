import { tx } from "@/platform/i18n";
import { useRowHeight } from "@/ui/density";
import { Fragment } from "react";
import styles from "../GitLog.module.css";
import { laneColor, type GraphRow, type GraphSegment } from "../graph";
import { LANE, ROW } from "./shared";

export function x(lane: number) {
  return LANE / 2 + lane * LANE;
}

/** Straight, also across lanes (IDEA's diagonal edges). */
function seg(fromX: number, fromY: number, toX: number, toY: number) {
  return `M${fromX} ${fromY}L${toX} ${toY}`;
}

export function GraphCell({
  row,
  head,
  activeColor,
  highlighted,
  highlightedNodes,
  onHover,
  onNavigate,
  onFragment,
  targetTitle,
  onNode,
  interactive = true,
}: {
  row: GraphRow;
  head?: boolean;
  activeColor?: string | null;
  highlighted?: ReadonlySet<string>;
  highlightedNodes?: ReadonlySet<string>;
  onHover?: (edge: string | null) => void;
  onNavigate?: (index: number, key?: string) => void;
  onFragment?: (target: string, expand: boolean, source?: string) => void;
  targetTitle?: (index: number, key?: string) => string;
  onNode?: () => void;
  interactive?: boolean;
}) {
  const height = useRowHeight(ROW);
  const cy = height / 2;
  const width = row.width * LANE;
  const draw = (s: GraphSegment, i: number, up: boolean) => {
    const fromX = x(s.fromX ?? s.from);
    const toX = x(s.toX ?? s.to);
    const path =
      seg(fromX, up ? 0 : cy, toX, up ? cy : height) +
      (s.arrow ? arrowHead(up ? fromX : toX, up ? 0 : height, up ? -1 : 1) : "");
    const line = (
      <path
        key={interactive ? undefined : `${up ? "u" : "d"}${i}`}
        d={path}
        stroke={laneColor(s.color)}
        strokeWidth={s.edge != null && (activeColor === s.edge || highlighted?.has(s.edge)) ? 2.8 : 1.4}
        pointerEvents="none"
        strokeLinecap={s.dashed ? "butt" : "square"}
        strokeDasharray={s.dashed ? "2 2" : undefined}
      />
    );
    if (!interactive) return line;
    const target = (up ? row.upTargets : row.downTargets)?.[i];
    const canFragment =
      !!target &&
      !!onFragment &&
      s.kind !== "filtered" &&
      s.kind !== "shallow" &&
      (!!s.source || (!up && s.from === row.lane));
    const canNavigate = s.targetRow != null && s.kind !== "shallow" && !!onNavigate;
    const actionable = canNavigate || canFragment;
    const label =
      s.kind === "shallow"
        ? tx("Shallow history boundary")
        : s.targetRow != null
          ? (targetTitle?.(s.targetRow, target) ?? tx("Go to connected commit"))
          : s.dashed
            ? tx("Expand this fragment")
            : tx("Collapse this fragment");
    const activate = () => {
      if (canNavigate) onNavigate?.(s.targetRow!, target);
      else if (canFragment) onFragment?.(target!, !!s.dashed, s.source);
    };
    return (
      <Fragment key={`${up ? "u" : "d"}${i}`}>
        <path
          d={path}
          stroke="transparent"
          strokeWidth={10}
          style={{ pointerEvents: "stroke" }}
          role={actionable ? "button" : undefined}
          tabIndex={actionable ? 0 : undefined}
          aria-label={actionable ? label : undefined}
          onMouseEnter={() => onHover?.(s.edge ?? `${s.source ?? ""}\0${target ?? ""}`)}
          onMouseMove={() => onHover?.(s.edge ?? `${s.source ?? ""}\0${target ?? ""}`)}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            activate();
          }}
          onKeyDown={(e) => {
            if (actionable && (e.key === "Enter" || e.key === " ")) {
              e.preventDefault();
              e.stopPropagation();
              activate();
            }
          }}
        >
          <title>{label}</title>
        </path>
        {line}
      </Fragment>
    );
  };
  return (
    <svg
      className={styles.graph}
      width={width}
      height={height}
      aria-label={tx("Commit graph")}
      onMouseLeave={() => onHover?.(null)}
    >
      {row.up.map((s, i) => draw(s, i, true))}
      {row.down.map((s, i) => draw(s, i, false))}
      <g
        role={onNode ? "button" : undefined}
        tabIndex={onNode ? 0 : undefined}
        aria-label={onNode ? tx("Collapse or expand this branch") : undefined}
        onMouseDown={(e) => e.stopPropagation()}
        onMouseEnter={() => row.id && onHover?.(`node:${row.id}`)}
        onMouseMove={() => row.id && onHover?.(`node:${row.id}`)}
        onClick={(e) => {
          e.stopPropagation();
          onNode?.();
        }}
        onKeyDown={(e) => {
          if (onNode && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            e.stopPropagation();
            onNode();
          }
        }}
      >
        <circle cx={x(row.lane)} cy={cy} r={8} fill="transparent" />
        <circle
          cx={x(row.lane)}
          cy={cy}
          r={row.id && highlightedNodes?.has(row.id) ? 6 : head ? 5 : 3.8}
          fill={head ? "var(--log-row-bg, var(--bg-app))" : laneColor(row.color)}
          stroke={laneColor(row.color)}
          strokeWidth={head ? 1.5 : 0}
          pointerEvents="none"
        />
        {head && <circle cx={x(row.lane)} cy={cy} r={2.5} fill={laneColor(row.color)} pointerEvents="none" />}
      </g>
    </svg>
  );
}

/** Arrow head at (`px`, `py`) pointing up (`dir` -1) or down (1): a long edge continues. */
function arrowHead(px: number, py: number, dir: 1 | -1) {
  const back = py - dir * 4;
  return `M${px - 3} ${back}L${px} ${py}L${px + 3} ${back}`;
}
