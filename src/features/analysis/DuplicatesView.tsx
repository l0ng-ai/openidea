/** Duplicates tool window: clone groups, and the selected group's fragments side by side. */
import { useCallback, useMemo, useState } from "react";
import type { DuplicateGroup, Fragment } from "@/platform/ipc";
import { basename } from "@/platform/project";
import { editorService } from "@/workbench/contributions";
import { EmptyState, Icon, IconButton, Spinner, Tree, fileIconName } from "@/ui";
import { cancelDuplicates, fragmentLines, rerunDuplicates, useDuplicates } from "./duplicates";
import styles from "./Analysis.module.css";
import { tx } from "@/platform/i18n";

type Node =
  | { kind: "group"; key: string; index: number; group: DuplicateGroup }
  | { kind: "fragment"; key: string; index: number; fragment: Fragment };

function openFragment(f: Fragment, focus = true) {
  void editorService().openFile(f.path, {
    selection: { line: f.range.start.line, col: f.range.start.col },
    focus,
    preview: !focus,
  });
}

export function DuplicatesHeaderActions() {
  const running = useDuplicates((s) => s.running);
  const last = useDuplicates((s) => s.last);
  return (
    <>
      <IconButton icon="rerun" title="Rerun" size="small" disabled={!last || running} onClick={rerunDuplicates} />
      <IconButton icon="stop" title="Stop" size="small" disabled={!running} onClick={cancelDuplicates} />
    </>
  );
}

function FragmentPane({ fragment }: { fragment: Fragment }) {
  const lines = useMemo(() => fragmentLines(fragment.text, fragment.range.start.line), [fragment]);
  return (
    <section className={styles.fragment} aria-label={fragment.relPath}>
      <button
        type="button"
        className={styles.fragmentHeader}
        onClick={() => openFragment(fragment)}
        title={tx("Open in editor")}
      >
        <Icon name={fileIconName(basename(fragment.path), fragment.path)} size={16} className={styles.fileIcon} />
        <span className={styles.strong}>{basename(fragment.path)}</span>
        <span className={styles.muted}>
          {fragment.range.start.line + 1}–{fragment.range.end.line + 1}
        </span>
      </button>
      <pre className={styles.code}>
        {lines.map((l) => (
          <div key={l.no}>
            <span className={styles.lineNo}>{l.no}</span>
            {l.text}
          </div>
        ))}
      </pre>
    </section>
  );
}

export function DuplicatesView() {
  const { running, report, scopeLabel, error, selected } = useDuplicates();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const roots = useMemo<Node[]>(
    () => (report?.groups ?? []).map((group, index) => ({ kind: "group", key: `g${index}`, index, group })),
    [report],
  );
  const getChildren = useCallback(
    (n: Node): Node[] | undefined =>
      n.kind === "group"
        ? n.group.fragments.map((fragment, i) => ({ kind: "fragment", key: `${n.key}:${i}`, index: n.index, fragment }))
        : undefined,
    [],
  );
  const group = selected !== null ? report?.groups[selected] : undefined;

  const status = running
    ? `Looking for duplicates in ${scopeLabel ?? ""}…`
    : report
      ? `${scopeLabel}: ${report.groups.length}${report.truncated ? "+" : ""} duplicate group${report.groups.length === 1 ? "" : "s"} in ${report.files} files (${report.tokens} tokens)` +
        (report.cancelled ? " (stopped)" : "")
      : null;

  return (
    <div className={styles.view}>
      {status && (
        <div className={styles.status} role="status">
          {running && <Spinner size={12} />}
          <span className={styles.statusText}>{status}</span>
        </div>
      )}
      <div className={styles.split}>
        <div className={styles.groups}>
          <Tree<Node>
            aria-label="Duplicate groups"
            roots={roots}
            getKey={(n) => n.key}
            getLabel={(n) => (n.kind === "group" ? `${n.group.tokens} tokens` : n.fragment.relPath)}
            getChildren={getChildren}
            isExpandable={(n) => n.kind === "group"}
            expanded={expanded}
            onExpandedChange={(next) => setExpanded(next)}
            renderNode={(n) =>
              n.kind === "group" ? (
                <span className={styles.row}>
                  <span className={styles.strong}>
                    {tx`${n.group.fragments.length} occurrences · ${n.group.lines} lines`}
                  </span>
                  <span className={styles.count}>{tx`${n.group.tokens} tokens`}</span>
                </span>
              ) : (
                <span className={styles.row}>
                  <Icon
                    name={fileIconName(basename(n.fragment.path), n.fragment.path)}
                    size={16}
                    className={styles.fileIcon}
                  />
                  <span>{basename(n.fragment.path)}</span>
                  <span className={styles.muted}>
                    :{n.fragment.range.start.line + 1}–{n.fragment.range.end.line + 1}
                  </span>
                  <span className={styles.count}>{n.fragment.relPath}</span>
                </span>
              )
            }
            onSelectionChange={(_sel, lead) => {
              if (lead) useDuplicates.setState({ selected: lead.index });
            }}
            onActivate={(n) => {
              if (n.kind === "fragment") openFragment(n.fragment);
            }}
            activateExpandable={false}
            multiSelect={false}
            empty={
              error ? (
                <EmptyState icon="error" title={error} />
              ) : running ? (
                <EmptyState icon="search" title="Analysing…" />
              ) : report ? (
                <EmptyState icon="check" title="No duplicates found" />
              ) : (
                <EmptyState icon="search" title="Run Code › Analyze Code › Locate Duplicates… to find copied code" />
              )
            }
          />
        </div>
        <div className={styles.fragments}>
          {group ? (
            group.fragments.map((f, i) => <FragmentPane key={`${selected}:${i}`} fragment={f} />)
          ) : (
            <EmptyState title={report?.groups.length ? "Select a group" : undefined} />
          )}
        </div>
      </div>
    </div>
  );
}
