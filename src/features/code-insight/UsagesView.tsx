/**
 * "usages" tool window: Find Usages results grouped by file with line
 * previews, one tab per search (pinnable, as the Find tool window's tabs).
 */
import { useCallback, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import clsx from "clsx";
import { create } from "zustand";
import { tokenSpans, useLineTokens } from "@/editor/lineTokens";
import { formatMessage, useTx } from "@/platform/i18n";
import { shortcutLabel } from "@/platform/keymap";
import { basename, relativeDir, useProject } from "@/platform/project";
import { maybeEditorService, useOccurrenceNavigator } from "@/workbench/contributions";
import {
  EmptyState,
  Icon,
  IconButton,
  SourcePreview,
  SplitGroup,
  SplitHandle,
  SplitPanel,
  Spinner,
  Tabs,
  Tree,
  fileIconName,
  showContextMenu,
  type MenuItem,
  type TreeHandle,
  type TreeRowState,
  T,
} from "@/ui";
import { previewText } from "./ipc";
import {
  activeUsageSearch,
  closeUsageTab,
  pinUsageTab,
  trimPreview,
  usageCount,
  useUsages,
  type Usage,
  type UsageGroup,
} from "./usages";
import styles from "./UsagesView.module.css";

type Node =
  | { kind: "summary"; key: string }
  | { kind: "file"; key: string; group: UsageGroup }
  | { kind: "usage"; key: string; usage: Usage };

export function UsagePreview({ usage }: { usage: Usage }) {
  const { text, textCol, from, to } = trimPreview(usage);
  const tokens = useLineTokens({ path: usage.path, line: usage.line, col: textCol }, text);
  return (
    <span className={styles.preview}>
      {tokenSpans(text, 0, from, tokens, "b:")}
      <mark className={styles.match}>{tokenSpans(text, from, to, tokens, "m:")}</mark>
      {tokenSpans(text, to, text.length, tokens, "a:")}
    </span>
  );
}

/** Tool window header: one content tab per search (`Usages of 'foo'`). */
export function UsagesTabs() {
  const tx = useTx();
  const tabs = useUsages((s) => s.tabs);
  const search = useUsages(activeUsageSearch);
  if (!search) return null;
  const label = (t: (typeof tabs)[number]) =>
    t.symbol ? formatMessage(tx("Usages of '{symbol}'"), { symbol: t.symbol }) : tx("Usages");
  return (
    <Tabs
      variant="compact"
      className={styles.tabs}
      aria-label="Usage searches"
      items={tabs.map((t) => ({
        id: String(t.id),
        label: label(t),
        closable: true,
        icon: t.pinned ? "pin" : undefined,
      }))}
      activeId={String(search.id)}
      onSelect={(id) => useUsages.setState({ active: Number(id) })}
      onClose={(id) => closeUsageTab(Number(id))}
      onContextMenu={(id, e) => {
        const t = tabs.find((x) => x.id === Number(id));
        if (!t) return;
        showContextMenu(e, [
          { id: "pin", label: t.pinned ? "Unpin Tab" : "Pin Tab", run: () => pinUsageTab(t.id, !t.pinned) },
          { kind: "separator" },
          { id: "close", label: "Close Tab", run: () => closeUsageTab(t.id) },
          {
            id: "closeOthers",
            label: "Close Other Tabs",
            disabled: tabs.length < 2,
            run: () => tabs.forEach((o) => o.id !== t.id && closeUsageTab(o.id)),
          },
        ]);
      }}
    />
  );
}

const SUMMARY_KEY = "\u0000summary";

const usageKey = (u: Usage) => `${u.path}:${u.line}:${u.col}`;

/** Excluded (⌫) usages per search. */
const useExcluded = create<{ byTab: Record<number, ReadonlySet<string>> }>(() => ({ byTab: {} }));
const NONE: ReadonlySet<string> = new Set();

/** Usages under a node (itself for a usage). */
function nodeUsages(n: Node, files: readonly Node[]): Usage[] {
  if (n.kind === "usage") return [n.usage];
  if (n.kind === "file") return n.group.usages;
  return files.flatMap((f) => (f.kind === "file" ? f.group.usages : []));
}

/** Toggles exclusion of `usages`: all excluded already → include them, else exclude them all. */
export function toggleExcludedUsages(excluded: ReadonlySet<string>, usages: readonly Usage[]): Set<string> {
  const keys = usages.map(usageKey);
  const next = new Set(excluded);
  if (keys.every((k) => excluded.has(k))) keys.forEach((k) => next.delete(k));
  else keys.forEach((k) => next.add(k));
  return next;
}

function openUsage(u: Usage, focus: boolean) {
  void maybeEditorService()?.openFile(u.path, { selection: { line: u.line, col: u.col }, focus });
}

export function UsagesView() {
  const tx = useTx();
  const search = useUsages(activeUsageSearch);
  const root = useProject((s) => s.project?.root ?? "");
  const [collapsed, setCollapsed] = useState<{ id: number | null; keys: ReadonlySet<string> }>({
    id: null,
    keys: new Set(),
  });
  const files = useMemo<Node[]>(
    () => (search?.groups ?? []).map((g) => ({ kind: "file", key: g.path, group: g })),
    [search?.groups],
  );
  const roots = useMemo<Node[]>(() => (files.length ? [{ kind: "summary", key: SUMMARY_KEY }] : []), [files.length]);
  const searchId = search?.id ?? null;
  const expanded = useMemo(() => {
    const hidden = collapsed.id === searchId ? collapsed.keys : new Set<string>();
    return new Set([SUMMARY_KEY, ...files.map((r) => r.key)].filter((k) => !hidden.has(k)));
  }, [files, collapsed, searchId]);
  const getChildren = useCallback(
    (n: Node): Node[] | undefined =>
      n.kind === "summary"
        ? files
        : n.kind === "file"
          ? n.group.usages.map((u) => ({ kind: "usage", key: usageKey(u), usage: u }) as Node)
          : undefined,
    [files],
  );
  const tree = useRef<TreeHandle>(null);
  const [lead, setLead] = useState<Node | null>(null);
  const excluded = useExcluded((s) => (searchId != null ? s.byTab[searchId] : undefined)) ?? NONE;

  useOccurrenceNavigator("usages", (dir, focus) => {
    const step = tree.current?.selectOccurrence(dir);
    const n = step?.node as Node | undefined;
    if (!step || n?.kind !== "usage") return null;
    openUsage(n.usage, focus);
    return step;
  });

  if (!search)
    return (
      <EmptyState>
        <T>Use Find Usages (⌥F7) on a symbol to see its usages here</T>
      </EmptyState>
    );
  const total = usageCount(search.groups);
  const setAll = (collapse: boolean) =>
    setCollapsed({ id: search.id, keys: collapse ? new Set(files.map((f) => f.key)) : new Set() });

  const exclude = () => {
    if (!lead) return;
    const next = toggleExcludedUsages(excluded, nodeUsages(lead, files));
    useExcluded.setState((s) => ({ byTab: { ...s.byTab, [search.id]: next } }));
    // Excluding moves on to the next usage, as in IDEA.
    if (next.size > excluded.size) tree.current?.selectOccurrence(1, { skipSubtree: true });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.key === "Backspace" || e.key === "Delete") && !e.metaKey && !e.altKey && !e.ctrlKey) {
      e.preventDefault();
      exclude();
    }
  };
  const isExcluded = (n: Node) => nodeUsages(n, files).every((u) => excluded.has(usageKey(u)));

  const renderNode = (n: Node, _state: TreeRowState) => {
    if (n.kind === "summary")
      return (
        <span className={styles.row}>
          <span className={styles.groupLabel}>
            <T>Found usages</T>
          </span>
          <span className={styles.count}>
            {total} {tx(total === 1 ? "result" : "results")}
          </span>
          {search.note && <span className={styles.note}>{search.note}</span>}
        </span>
      );
    if (n.kind === "file") {
      const path = n.group.path;
      return (
        <span className={clsx(styles.row, isExcluded(n) && styles.excluded)}>
          <Icon name={fileIconName(basename(path))} size={16} className={styles.icon} />
          <span className={styles.file}>{basename(path)}</span>
          <span className={styles.muted}>{relativeDir(root, path)}</span>
          <span className={styles.count}>
            {n.group.usages.length} {tx(n.group.usages.length === 1 ? "usage" : "usages")}
          </span>
        </span>
      );
    }
    return (
      <span className={clsx(styles.row, excluded.has(n.key) && styles.excluded)}>
        <span className={styles.line}>{n.usage.line + 1}</span>
        <UsagePreview usage={n.usage} />
      </span>
    );
  };

  return (
    <div className={styles.view}>
      <div className={styles.toolbar} role="toolbar" aria-orientation="vertical" aria-label={tx("Usages actions")}>
        <IconButton
          icon="rerun"
          title={tx("Rerun Find Usages")}
          size="small"
          iconSize={16}
          shortcut={shortcutLabel("usages.rerun")}
          disabled={!search.rerun}
          onClick={() => search.rerun?.()}
        />
        <span className={styles.toolbarSep} />
        <IconButton icon="arrow-up" action="navigate.prevOccurrence" size="small" iconSize={16} />
        <IconButton icon="arrow-down" action="navigate.nextOccurrence" size="small" iconSize={16} />
        <span className={styles.toolbarSep} />
        <IconButton icon="expand-all" title="Expand All" size="small" iconSize={16} onClick={() => setAll(false)} />
        <IconButton icon="collapse-all" title="Collapse All" size="small" iconSize={16} onClick={() => setAll(true)} />
      </div>
      <div className={styles.body} onKeyDown={onKeyDown}>
        {(search.loading || search.error) && (
          <div className={styles.summary} role="status" aria-live="polite">
            {search.loading ? (
              <>
                <Spinner size={12} />{" "}
                {search.symbol
                  ? formatMessage(tx("Searching for usages of '{symbol}'"), { symbol: search.symbol })
                  : tx("Searching for usages")}
                …
              </>
            ) : (
              <span className={styles.error}>{search.error}</span>
            )}
          </div>
        )}
        <UsagesSplit preview={<UsagesPreview node={lead} />}>
          <Tree<Node>
            key={search.id}
            aria-label="Usages"
            handleRef={tree}
            roots={roots}
            getKey={(n) => n.key}
            getLabel={(n) =>
              n.kind === "summary"
                ? tx("Found usages")
                : n.kind === "file"
                  ? basename(n.group.path)
                  : n.usage.text.trim()
            }
            getChildren={getChildren}
            isExpandable={(n) => n.kind !== "usage"}
            isOccurrence={(n) => n.kind === "usage" && !excluded.has(n.key)}
            expanded={expanded}
            onExpandedChange={(next) =>
              setCollapsed({
                id: search.id,
                keys: new Set([SUMMARY_KEY, ...files.map((f) => f.key)].filter((k) => !next.has(k))),
              })
            }
            renderNode={renderNode}
            multiSelect={false}
            onSelectionChange={(_sel, node) => setLead(node)}
            onContextMenu={(n, _sel, e) => {
              if (!n) return;
              showContextMenu(e, [
                {
                  id: "exclude",
                  label: isExcluded(n) ? "Include" : "Exclude",
                  shortcut: "⌫",
                  run: () => {
                    setLead(n);
                    const next = toggleExcludedUsages(excluded, nodeUsages(n, files));
                    useExcluded.setState((s) => ({ byTab: { ...s.byTab, [search.id]: next } }));
                  },
                },
              ]);
            }}
            onActivate={(n) => {
              const u = n.kind === "usage" ? n.usage : n.kind === "file" ? n.group.usages[0] : undefined;
              if (u) openUsage(u, true);
            }}
            empty={
              !search.loading && !search.error ? (
                <EmptyState>
                  <T>No usages found</T>
                </EmptyState>
              ) : undefined
            }
          />
        </UsagesSplit>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preview pane (persisted toggle in the ⋮ menu; on by default, like the Find tool window's).

const OPTIONS_KEY = "openidea.usages.view.v1";

export const useUsagesOptions = create<{ preview: boolean }>(() => {
  try {
    return { preview: true, ...JSON.parse(globalThis.localStorage?.getItem(OPTIONS_KEY) ?? "{}") };
  } catch {
    return { preview: true };
  }
});

useUsagesOptions.subscribe((s) => {
  try {
    globalThis.localStorage?.setItem(OPTIONS_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
});

/** The Find Usages tool window's ⋮ menu entries. */
export function useUsagesHeaderMenu(): MenuItem[] {
  const preview = useUsagesOptions((s) => s.preview);
  return [
    {
      id: "preview",
      label: "Preview Source",
      checked: preview,
      run: () => useUsagesOptions.setState({ preview: !preview }),
    },
  ];
}

function UsagesSplit({ preview, children }: { preview: ReactNode; children: ReactNode }) {
  const show = useUsagesOptions((s) => s.preview);
  if (!show) return children;
  return (
    <SplitGroup orientation="horizontal" id="usages-preview-split">
      <SplitPanel id="usages" minSize={160} className={styles.panel}>
        {children}
      </SplitPanel>
      <SplitHandle />
      <SplitPanel id="preview" minSize={160} defaultSize="45%" className={styles.panel}>
        {preview}
      </SplitPanel>
    </SplitGroup>
  );
}

function UsagesPreview({ node }: { node: Node | null }) {
  const usage = node?.kind === "usage" ? node.usage : node?.kind === "file" ? (node.group.usages[0] ?? null) : null;
  const search = useUsages(activeUsageSearch);
  const highlights = useMemo(() => {
    const group = usage && search?.groups.find((g) => g.path === usage.path);
    return (group?.usages ?? []).map((u) => ({ line: u.line, ranges: [[u.col, u.endCol] as const] }));
  }, [usage, search?.groups]);
  return (
    <SourcePreview path={usage?.path ?? null} line={usage?.line ?? 0} highlights={highlights} load={previewText} />
  );
}
