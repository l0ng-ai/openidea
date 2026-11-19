import type { Commit } from "@/bindings";
import { Icon, Popup, TOOLTIP_DELAY, showContextMenu } from "@/ui";
import clsx from "clsx";
import { memo, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import styles from "../GitLog.module.css";
import { type GraphRow } from "../graph";
import { IssueText } from "../issueLinks";
import { type LogOptions } from "../logOptions";
import { selectedCommits } from "../logStore";
import { commitKey, commitRepo } from "../multiRoot";
import { repoName, useVcs } from "../store";
import { CommitMessage, RefLabels } from "./CommitMessage";
import { GraphCell } from "./GraphCell";
import { RowResizeHandle } from "./RowResizeHandle";
import { commitMenu } from "./commitMenu";
import { SUBJECT_COLUMN, columnSequence, type LogColumn } from "./shared";
import { columnPrev } from "./useColumnResize";

function CommitRowView({
  id,
  commit: c,
  fileHistoryTarget,
  graph,
  top,
  height,
  selected,
  head,
  mine,
  onBranch,
  opts,
  remoteNames,
  onPick,
  hoverColor,
  highlighted,
  highlightedNodes,
  onHover,
  onFragment,
  onNavigate,
  targetTitle,
  columns,
  bookmarked,
  interactive,
}: {
  id: string;
  commit: Commit;
  fileHistoryTarget: string | null;
  graph: GraphRow | undefined;
  top: number;
  height: number;
  selected: boolean;
  head: boolean;
  mine: boolean;
  onBranch: boolean;
  opts: LogOptions;
  remoteNames: ReadonlySet<string>;
  onPick: (id: string, e: ReactMouseEvent) => void;
  hoverColor: string | null;
  highlighted: ReadonlySet<string>;
  highlightedNodes: ReadonlySet<string>;
  onHover: (color: string | null) => void;
  onFragment: (from: string, target: string, expand: boolean) => void;
  onNavigate: (index: number, key?: string) => void;
  targetTitle: (index: number, key?: string) => string;
  columns: LogColumn[];
  bookmarked: boolean;
  /** False for rows rendered mid-scroll: their graph is drawn without hit targets. */
  interactive: boolean;
}) {
  const merge = opts.highlightMerges && c.parents.length > 1;
  const subjectRef = useRef<HTMLSpanElement>(null);
  const [tooltip, setTooltip] = useState(false);
  const tooltipBody = useRef<HTMLDivElement>(null);
  const tooltipTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(tooltipTimer.current), []);
  useEffect(() => {
    if (!tooltip) return;
    // Scrolling the log moves the anchor away; scrolling a long message inside the card doesn't.
    const hide = (e: Event) => {
      const card = tooltipBody.current?.closest("[data-popup]");
      if (e.target instanceof Node && card?.contains(e.target)) return;
      setTooltip(false);
    };
    window.addEventListener("scroll", hide, true);
    return () => window.removeEventListener("scroll", hide, true);
  }, [tooltip]);
  const enterTooltip = () => {
    clearTimeout(tooltipTimer.current);
    if (tooltip || subjectRef.current?.closest("[data-hover-paused]")) return;
    tooltipTimer.current = setTimeout(() => {
      if (!subjectRef.current?.closest("[data-hover-paused]")) setTooltip(true);
    }, TOOLTIP_DELAY);
  };
  const leaveTooltip = () => {
    clearTimeout(tooltipTimer.current);
    tooltipTimer.current = setTimeout(() => setTooltip(false), 120);
  };
  const refs = c.refs.length > 0 && (
    <RefLabels
      refs={c.refs}
      compact={opts.compactRefs}
      tagNames={opts.tagNames}
      remoteNames={remoteNames}
      left={opts.refsOnLeft}
    />
  );
  const subjectCell = (
    <span key={SUBJECT_COLUMN.id} className={styles.colSubject}>
      {graph && (
        <GraphCell
          row={graph}
          head={head}
          activeColor={hoverColor}
          highlighted={highlighted}
          highlightedNodes={highlightedNodes}
          onHover={onHover}
          onNavigate={onNavigate}
          targetTitle={targetTitle}
          onFragment={(target, expand, source) => onFragment(source ?? commitKey(c), target, expand)}
          onNode={() => onFragment(commitKey(c), commitKey(c), false)}
          interactive={interactive}
        />
      )}
      {bookmarked && <Icon name="bookmark" size={12} />}
      <span className={styles.commitText}>
        {opts.refsOnLeft && refs}
        <span
          ref={subjectRef}
          className={clsx(styles.subject, head && styles.headSubject, merge && styles.mergeSubject)}
          onPointerEnter={enterTooltip}
          onPointerMove={enterTooltip}
          onPointerLeave={leaveTooltip}
          onPointerDown={() => {
            clearTimeout(tooltipTimer.current);
            setTooltip(false);
          }}
        >
          <IssueText text={c.summary} />
        </span>
        {!opts.refsOnLeft && refs}
      </span>
      <Popup
        open={tooltip}
        anchor={subjectRef}
        role="tooltip"
        autoFocus={false}
        restoreFocus={false}
        onClose={() => setTooltip(false)}
        className={styles.commitTooltip}
      >
        <div ref={tooltipBody} onPointerEnter={() => clearTimeout(tooltipTimer.current)} onPointerLeave={leaveTooltip}>
          <CommitMessage commit={c} />
        </div>
      </Popup>
    </span>
  );
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      className={clsx(
        styles.row,
        onBranch && styles.currentBranch,
        selected && styles.selected,
        opts.showColumnDividers && styles.showDividers,
      )}
      style={{ top, height }}
      onMouseDown={(e) => {
        if (e.shiftKey) e.preventDefault(); // no text selection on range clicks
        onPick(commitKey(c), e);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        showContextMenu(e, commitMenu(c, selectedCommits(), fileHistoryTarget));
      }}
    >
      {opts.showRepository && commitRepo(c) && useVcs.getState().roots.length > 1 && (
        <span className={styles.colRepository} title={commitRepo(c)!}>
          {repoName(commitRepo(c)!)}
        </span>
      )}
      {columnSequence(opts.columnOrder, columns).map((cid, _index, ids) => {
        if (cid === SUBJECT_COLUMN.id) return subjectCell;
        const column = columns.find((col) => col.id === cid);
        if (!column) return null;
        const width = opts.columnWidths[column.id] ?? column.width ?? 120;
        return (
          <span
            key={cid}
            className={clsx(
              styles.columnCell,
              styles.muted,
              column.id === "author" && mine && styles.mine,
              column.id === "hash" && styles.hash,
            )}
            style={{ width }}
            title={column.id === "author" ? `${c.author} <${c.email}>` : undefined}
          >
            {column.render(c)}
            <RowResizeHandle target={{ id: column.id, width, ...columnPrev(ids, column.id, opts, columns) }} />
          </span>
        );
      })}
    </div>
  );
}

// A row that is already interactive stays so when scrolling starts; only rows
// whose content changes mid-scroll are drawn without hit targets.
export const CommitRow = memo(CommitRowView, (prev, next) => {
  for (const key in next) {
    const k = key as keyof typeof next;
    if (prev[k] !== next[k] && !(k === "interactive" && prev.interactive)) return false;
  }
  return true;
});
