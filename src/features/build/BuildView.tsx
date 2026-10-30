/**
 * Build tool window (IDEA's Build view): the build → file → message tree on
 * the left, the raw console of the build on the right. Selecting a message
 * shows its full text on the right instead; Enter / double-click / F4 opens
 * its source (as IDEA: selection shows, navigation jumps).
 */
import { copySelectionOnKeyDown } from "@/ui/selectableText";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { useVirtualizer } from "@tanstack/react-virtual";
import { basename, relativeDir, useProject } from "@/platform/project";
import {
  EmptyState,
  Icon,
  IconButton,
  SplitGroup,
  SplitHandle,
  SplitPanel,
  Spinner,
  Tree,
  fileIconName,
  type TreeHandle,
  type TreeRowState,
  T,
} from "@/ui";
import type { BuildMessage, Severity } from "@/platform/ipc";
import {
  ROOT_KEY,
  fileChildren,
  findNode,
  finishSummary,
  formatDuration,
  rootChildren,
  rootNode,
  type BuildNode,
  type BuildStatus,
} from "./model";
import { navigateToMessage, rerunBuild, selectBuildNode, useBuildRun } from "./store";
import styles from "./Build.module.css";
import { tx } from "@/platform/i18n";

const SEVERITY_ICON: Record<Severity, string> = { error: "error", warning: "warning", info: "info", hint: "info" };

function firstLocated(n: BuildNode): BuildMessage | undefined {
  if (n.kind === "message") return n.message;
  if (n.kind === "file") return n.messages[0];
  return undefined;
}

function StatusIcon({ status }: { status: BuildStatus }) {
  if (status === "running") return <Spinner size={14} label="Building" />;
  const name = status === "success" ? "success" : status === "failed" ? "error" : "warning";
  return <Icon name={name} size={14} className={styles[`status-${status}`]} />;
}

function rootDetail(status: BuildStatus, durationMs: number | null, errors: number, warnings: number): string {
  if (status === "running") return "running…";
  if (status === "cancelled") return "cancelled";
  const summary = finishSummary({ success: status === "success", errors, warnings, durationMs });
  return status === "success"
    ? `finished ${formatDuration(durationMs ?? 0)}`
    : summary.replace(/^Build failed:?\s*/, "") || "failed";
}

export function BuildHeaderActions() {
  const running = useBuildRun((s) => s.status === "running");
  return (
    <>
      <IconButton icon="rerun" size="small" title="Rebuild Last" onClick={() => void rerunBuild()} disabled={running} />
      <IconButton icon="stop" size="small" action="build.stop" disabled={!running} />
    </>
  );
}

function BuildTree() {
  const { title, status, messages, durationMs, selected } = useBuildRun();
  const root = useProject((s) => s.project?.root ?? "");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const tree = useRef<TreeHandle>(null);
  const selection = useMemo(() => new Set(selected ? [selected] : []), [selected]);
  const roots = useMemo(() => (status ? [rootNode(title, status, messages)] : []), [title, status, messages]);
  const children = useMemo(() => rootChildren(messages), [messages]);
  const expanded = useMemo(() => {
    const keys = new Set<string>([ROOT_KEY]);
    for (const c of children) if (c.kind === "file") keys.add(c.key);
    for (const k of collapsed) keys.delete(k);
    return keys;
  }, [children, collapsed]);

  // A selection made by the store (the first error of a failed build) expands
  // its file, then is scrolled into view.
  const [shown, setShown] = useState(selected);
  if (shown !== selected) {
    setShown(selected);
    const file = selected?.split("\u0000")[0];
    if (file && file !== selected && collapsed.has(file)) {
      const next = new Set(collapsed);
      next.delete(file);
      setCollapsed(next);
    }
  }
  useEffect(() => {
    if (selected && tree.current?.leadKey() !== selected) tree.current?.reveal(selected);
  }, [selected, expanded]);

  const navigate = (n: BuildNode) => {
    const m = firstLocated(n);
    if (m) navigateToMessage(m, true);
  };

  const getChildren = useCallback(
    (n: BuildNode): BuildNode[] | undefined =>
      n.kind === "root" ? children : n.kind === "file" ? fileChildren(n) : undefined,
    [children],
  );

  const renderNode = (n: BuildNode, state: TreeRowState) => {
    if (n.kind === "root") {
      return (
        <span className={styles.row}>
          <StatusIcon status={n.status} />
          <span className={styles.strong}>{n.title}</span>
          <span className={styles.muted}>{rootDetail(n.status, durationMs, n.errors, n.warnings)}</span>
        </span>
      );
    }
    if (n.kind === "file") {
      const errors = n.messages.filter((m) => m.severity === "error").length;
      const warnings = n.messages.filter((m) => m.severity === "warning").length;
      const counts = [
        errors && `${errors} error${errors === 1 ? "" : "s"}`,
        warnings && `${warnings} warning${warnings === 1 ? "" : "s"}`,
      ]
        .filter(Boolean)
        .join(", ");
      return (
        <span className={styles.row}>
          <Icon name={fileIconName(basename(n.path))} size={16} className={styles.fileIcon} />
          <span className={clsx(styles.strong, errors > 0 && styles.fileError, state.selected && styles.selected)}>
            {basename(n.path)}
          </span>
          <span className={styles.muted}>{relativeDir(root, n.path)}</span>
          <span className={styles.muted}>{counts}</span>
        </span>
      );
    }
    const m = n.message;
    const start = m.range?.start;
    return (
      <span className={styles.row} title={m.text}>
        <Icon name={SEVERITY_ICON[m.severity]} size={14} className={styles[`sev-${m.severity}`]} />
        <span className={styles.message}>{m.text.split("\n")[0]}</span>
        {start && (
          <span className={styles.position}>
            :{start.line + 1}:{start.col + 1}
          </span>
        )}
      </span>
    );
  };

  return (
    <div
      className={styles.treeHost}
      onKeyDown={(e) => {
        if (e.key !== "F4" || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !selected) return;
        const n = findNode(messages, selected);
        if (!n) return;
        e.preventDefault();
        e.stopPropagation();
        navigate(n);
      }}
    >
      <Tree<BuildNode>
        handleRef={tree}
        aria-label="Build"
        roots={roots}
        getKey={(n) => n.key}
        getLabel={(n) => (n.kind === "root" ? n.title : n.kind === "file" ? basename(n.path) : n.message.text)}
        getChildren={getChildren}
        isExpandable={(n) => n.kind !== "message"}
        expanded={expanded}
        onExpandedChange={(_next, node, isOpen) =>
          setCollapsed((prev) => {
            const s = new Set(prev);
            if (isOpen) s.delete(node.key);
            else s.add(node.key);
            return s;
          })
        }
        renderNode={renderNode}
        selected={selection}
        onActivate={navigate}
        onSelectionChange={(_sel, lead) => selectBuildNode(lead?.key ?? null)}
        multiSelect={false}
        empty={<EmptyState title="No build output" />}
      />
    </div>
  );
}

const LINE_HEIGHT = 20;

function BuildConsole() {
  const lines = useBuildRun((s) => s.lines);
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => ref.current,
    estimateSize: () => LINE_HEIGHT,
    overscan: 20,
  });
  useEffect(() => {
    if (stick.current && lines.length) virtualizer.scrollToIndex(lines.length - 1, { align: "end" });
  }, [lines.length, virtualizer]);
  return (
    <div
      ref={ref}
      className={styles.console}
      tabIndex={0}
      role="log"
      onKeyDown={copySelectionOnKeyDown}
      aria-label={tx("Build output")}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < LINE_HEIGHT * 2;
      }}
    >
      <div className={styles.consoleInner} style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((v) => {
          const line = lines[v.index]!;
          return (
            <div
              key={v.key}
              className={clsx(styles.line, styles[line.kind])}
              style={{ transform: `translateY(${v.start}px)` }}
            >
              {line.text || " "}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Full text and location of the selected message (IDEA shows the node's own console). */
function MessageDetail({ message }: { message: BuildMessage }) {
  const root = useProject((s) => s.project?.root ?? "");
  const start = message.range?.start;
  const location = message.path
    ? `${relativeDir(root, message.path) ? `${relativeDir(root, message.path)}/` : ""}${basename(message.path)}${
        start ? `:${start.line + 1}:${start.col + 1}` : ""
      }`
    : null;
  return (
    <div
      className={styles.detail}
      tabIndex={0}
      onKeyDown={copySelectionOnKeyDown}
      role="document"
      aria-label={tx("Build message")}
    >
      {location && (
        <button type="button" className={styles.detailLocation} onClick={() => navigateToMessage(message, true)}>
          {location}
        </button>
      )}
      <div className={clsx(styles.detailText, message.severity === "error" && styles.err)}>{message.text}</div>
    </div>
  );
}

function BuildOutput() {
  const selected = useBuildRun((s) => s.selected);
  const messages = useBuildRun((s) => s.messages);
  const node = useMemo(() => (selected ? findNode(messages, selected) : undefined), [selected, messages]);
  return node?.kind === "message" ? <MessageDetail message={node.message} /> : <BuildConsole />;
}

export function BuildView() {
  const hasBuild = useBuildRun((s) => s.status !== null);
  if (!hasBuild) {
    return (
      <div className={styles.view}>
        <EmptyState title="No build output">
          <T>Build the project to see compiler messages here</T>
        </EmptyState>
      </div>
    );
  }
  return (
    <div className={styles.view}>
      <SplitGroup orientation="horizontal" className={styles.split} id="build-view-split">
        <SplitPanel id="build-tree" defaultSize="38%" minSize="120px" className={styles.pane}>
          <BuildTree />
        </SplitPanel>
        <SplitHandle />
        <SplitPanel id="build-console" minSize="120px" className={styles.pane}>
          <BuildOutput />
        </SplitPanel>
      </SplitGroup>
    </div>
  );
}
