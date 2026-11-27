/**
 * The all-in-one diff tab (`combined-diff`): one block per file of a change, each a diff
 * as tall as its content under a sticky header, in one scrolling view. Only the blocks near
 * the viewport are mounted; a header collapses its block or opens the file's own diff tab.
 */
import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { defaultRangeExtractor, elementScroll, useVirtualizer, type Range } from "@tanstack/react-virtual";
import clsx from "clsx";
import { tx } from "@/platform/i18n";
import { relativeDir, useProject } from "@/platform/project";
import { Icon, IconButton, SplitGroup, SplitHandle, SplitPanel, T, fileIconName } from "@/ui";
import { editorService, type EditorInput } from "@/workbench/contributions";
import { combinedDiffDocumentOwner, setAllInOneDiff, type CombinedDiffData } from "./allInOneDiff";
import { ResolvedDiffEditor, type DiffViewState } from "./DiffEditor";
import { diffInput, hasGitlink, openDiff, withChain, type DiffData } from "./diffInput";
import { loadDiffOptions, saveDiffOptions } from "./diffOptions";
import { useGitDiffEntries, type DiffEntriesCache } from "./gitDiffEntries";
import { KIND_COLOR, KIND_LABEL, baseName, fileCount } from "./model";
import { ownedStagedDocument } from "./stagedDocument";
import styles from "./CombinedDiff.module.css";

type Kind = "added" | "deleted" | "modified";

/** What happened to the file: one side absent means added or deleted. */
export function blockKind(item: DiffData): Kind {
  const absent = (s: DiffData["left"]) => s.type === "text" && !!s.absent;
  return absent(item.left) ? "added" : absent(item.right) ? "deleted" : "modified";
}

/** Height of a block not measured yet: its header and a short diff. */
const ESTIMATE = 200;
/**
 * The panel library puts `overflow: auto` on its content div. The file tree and the diff list
 * scroll themselves; a sub-pixel overflow of the panel would add a second native scrollbar.
 */
const CLIP = { overflow: "hidden" } as const;

/** A file of the view: `key` tells apart the same file shown twice (staged and unstaged, in two commits). */
export interface CombinedDiffItem {
  key: string;
  data: DiffData;
  /** Shown after the file name instead of its folder under the project. */
  detail?: string;
}

/** Scrolls the view to the block of an item. */
export interface CombinedDiffHandle {
  reveal(key: string): void;
}

// Memoized: selecting a file elsewhere (a file list beside the view) mustn't render every diff again.
const Block = memo(function Block({
  entry,
  index,
  items,
  collapsed,
  onToggle,
  mode,
  tabKey,
  heights,
  viewStates,
  entriesCache,
}: {
  entry: CombinedDiffItem;
  index: number;
  items: readonly DiffData[];
  collapsed: boolean;
  onToggle: (key: string) => void;
  mode: "split" | "unified";
  tabKey: string;
  /** Height of each block's loaded diff, by layout and diff, kept while blocks are unmounted. */
  heights: Map<string, number>;
  /** Each block's selection and expanded unchanged lines, by layout and diff, kept the same way. */
  viewStates: Map<string, DiffViewState>;
  /** Git entries of the blocks, so a block back in view shows without asking Git again. */
  entriesCache: DiffEntriesCache;
}) {
  const item = entry.data;
  // A block mounted collapsed creates its diff once expanded.
  const [loaded, setLoaded] = useState(!collapsed);
  if (!collapsed && !loaded) setLoaded(true);
  const request = useMemo(() => ({ ...item, mode }), [item, mode]);
  const input = useMemo(() => diffInput(request), [request]);
  const diff = useGitDiffEntries(request, entriesCache);

  // Back in view, the diff loads again: until it is as tall as before (or for a second), the block
  // keeps its last height, so the blocks around it don't move while the view scrolls.
  const bodyRef = useRef<HTMLDivElement>(null);
  const heightKey = `${mode}\0${input.key}`;
  const [hold, setHold] = useState(() => heights.get(heightKey) ?? 0);
  const viewState = useMemo(() => {
    if (!viewStates.has(heightKey)) viewStates.set(heightKey, {});
    return viewStates.get(heightKey)!;
  }, [viewStates, heightKey]);
  useEffect(() => {
    const content = bodyRef.current?.firstElementChild;
    if (!(content instanceof HTMLElement)) return;
    const timer = hold ? setTimeout(() => setHold(0), 1000) : undefined;
    const observer = new ResizeObserver(() => {
      const height = content.offsetHeight;
      // Collapsed (hidden), or still loading.
      if (!height || height < hold) return;
      if (hold) setHold(0);
      else heights.set(heightKey, height);
    });
    observer.observe(content);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [loaded, hold, heightKey, heights]);
  const gitlink = hasGitlink(diff.data);
  const kind = blockKind(item);
  const name = baseName(item.path);
  const root = useProject((s) => s.project?.root ?? "");
  const dir = entry.detail ?? relativeDir(root, item.path);
  return (
    <section
      className={styles.block}
      data-combined-block={item.path}
      data-collapsed={collapsed || undefined}
      aria-label={name}
    >
      <div className={styles.header}>
        <IconButton
          icon={collapsed ? "chevron-right" : "chevron-down"}
          title={collapsed ? "Expand File" : "Collapse File"}
          size="small"
          aria-expanded={!collapsed}
          onClick={() => onToggle(entry.key)}
        />
        <IconButton
          icon="diff"
          title="Open in Separate Tab"
          size="small"
          // The file's own diff, still knowing its siblings for Compare Next File.
          onClick={() => void editorService().openInput(diffInput(withChain(items, index)), { focus: true })}
        />
        {!diff.loading && !gitlink && item.right.type === "worktree" && (
          <IconButton
            icon="edit"
            title="Jump to Source"
            size="small"
            onClick={() => void editorService().openFile(item.path, { focus: true })}
          />
        )}
        <span className={styles.sep} aria-hidden="true" />
        <div className={styles.file} title={`${item.path}\n${tx(KIND_LABEL[kind])}`}>
          <Icon name={fileIconName(name)} size={16} />
          <span className={styles.name} style={{ color: KIND_COLOR[kind] }}>
            {name}
          </span>
          {gitlink && <span className={styles.dir}>{tx("Submodule")}</span>}
          {dir && <span className={styles.dir}>{dir}</span>}
        </div>
      </div>
      {/* Collapsing hides the diff instead of unmounting it, so expanding it doesn't load it again.
          A block scrolled away does unmount: its unsaved working-tree edits stay open in their
          document (saved first with autosave on). Unmounting saves staged edits to the index, so
          with autosave off a block holding some stays mounted (`rangeExtractor`). */}
      {loaded && (
        <div ref={bodyRef} className={styles.body} hidden={collapsed} style={hold ? { minHeight: hold } : undefined}>
          <ResolvedDiffEditor
            diff={diff}
            input={input}
            documentOwner={combinedDiffDocumentOwner(tabKey, input.key)}
            viewState={viewState}
            fit
          />
        </div>
      )}
    </section>
  );
});

export function CombinedDiffTab({ input }: { input: EditorInput }) {
  const data = input.data as CombinedDiffData;
  // A partially staged file is listed twice (staged and unstaged), so blocks go by diff, not path.
  const entries = useMemo(() => data.items.map((item) => ({ key: diffInput(item).key, data: item })), [data.items]);
  // The diff opened (`revealKey`) picks the staged or the unstaged block of a partially staged file.
  const reveal =
    entries.find((e) => e.key === data.revealKey)?.key ??
    (data.reveal ? entries.find((e) => e.data.path === data.reveal)?.key : undefined);
  return (
    <CombinedDiffView
      items={entries}
      tabKey={input.key}
      reveal={reveal}
      onSeparateTabs={(at) => {
        // Back to one diff per file, at the file in view.
        setAllInOneDiff(false);
        void openDiff(withChain(data.items, at)).then(() => editorService().closeInput?.(input.key));
      }}
    />
  );
}

/**
 * Every file of `items` in one scrolling view, with its toolbar. `tabKey` owns the working
 * documents its diffs edit; `onSeparateTabs` (given the index in view) offers one tab per file.
 * A view with a list of its files (`files`, beside the diffs) shares the toolbar: its controls
 * go before (`toolbarStart`) and after (`toolbarEnd`) the diff's.
 */
export function CombinedDiffView({
  items: entries,
  tabKey,
  reveal,
  handle,
  empty = <T>No changes</T>,
  onSeparateTabs,
  toolbarStart,
  toolbarEnd,
  files,
}: {
  items: readonly CombinedDiffItem[];
  tabKey: string;
  /** Key of the item to scroll to when the view opens. */
  reveal?: string;
  handle?: Ref<CombinedDiffHandle>;
  /** Shown instead of the diffs when there are none. */
  empty?: ReactNode;
  onSeparateTabs?: (index: number) => void;
  toolbarStart?: ReactNode;
  toolbarEnd?: ReactNode;
  files?: { content: ReactNode; label: string; storageKey: string };
}) {
  const items = useMemo(() => entries.map((e) => e.data), [entries]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [mode, setMode] = useState(() => loadDiffOptions().mode);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [heights] = useState(() => new Map<string, number>());
  const [viewStates] = useState(() => new Map<string, DiffViewState>());
  const [entriesCache] = useState<DiffEntriesCache>(() => new Map());
  const keys = useMemo(() => entries.map((e) => e.key), [entries]);
  // Each diff's own key, hashing its texts: worked out once, not on every scroll frame.
  const diffKeys = useMemo(() => items.map((item) => diffInput(item).key), [items]);

  // Blocks that stay mounted when scrolled away: the one holding the keyboard focus, so typing still
  // reaches it, and with autosave off those with unsaved staged edits, which unmounting would save.
  const rangeExtractor = useCallback(
    (range: Range) => {
      const shown = new Set(defaultRangeExtractor(range));
      const active = document.activeElement;
      const slot = scrollRef.current?.contains(active) ? active?.closest<HTMLElement>("[data-index]") : null;
      if (slot) shown.add(Number(slot.dataset.index));
      if (useProject.getState().settings?.files?.autoSave === false)
        diffKeys.forEach((key, index) => {
          if (ownedStagedDocument(combinedDiffDocumentOwner(tabKey, key))?.dirty) shown.add(index);
        });
      return [...shown].sort((a, b) => a - b);
    },
    [diffKeys, tabKey],
  );
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => keys[index]!,
    estimateSize: () => ESTIMATE,
    overscan: 4,
    rangeExtractor,
    // A correction for a block above moves the view by its delta from wherever it is now: a `scrollTo`
    // (the library's offset plus the delta) can drop wheel scrolling still in flight in WebKit.
    scrollToFn: (offset, options, instance) => {
      if (options.adjustments)
        instance.scrollElement?.scrollBy({ top: options.adjustments, behavior: options.behavior });
      else elementScroll(offset, options, instance);
    },
  });
  // A block's real height is only known once its diff loads, up to thousands of lines past the
  // estimate. The view moves with every block above it that grows, scrolling up too (the library
  // skips that), or a reveal, Previous File and scrolling up land blocks early.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) =>
    item.end <= (instance.scrollOffset ?? 0);

  /** Index of the block at the top of the view. */
  const current = () =>
    virtualizer.getVirtualItemForOffset(scrollRef.current?.scrollTop ?? 0)?.index ?? items.length - 1;
  const step = (dir: 1 | -1) => {
    const next = current() + dir;
    if (next >= 0 && next < items.length) virtualizer.scrollToIndex(next, { align: "start" });
  };

  const scrollTo = (key: string) => {
    const at = keys.indexOf(key);
    if (at >= 0) virtualizer.scrollToIndex(at, { align: "start" });
  };
  useImperativeHandle(handle, () => ({ reveal: scrollTo }));

  // Open at the file the diff was asked for.
  useLayoutEffect(() => {
    if (reveal) scrollTo(reveal);
    // Once per view: later revisits keep their scroll position.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setViewer = (next: "split" | "unified") => {
    setMode(next);
    saveDiffOptions({ ...loadDiffOptions(), mode: next });
  };
  const toggle = useCallback(
    (key: string) =>
      setCollapsed((c) => {
        const s = new Set(c);
        if (s.has(key)) s.delete(key);
        else s.add(key);
        return s;
      }),
    [],
  );
  const allCollapsed = items.length > 0 && keys.every((key) => collapsed.has(key));

  const scroller = (
    <div ref={scrollRef} className={styles.scroll} data-combined-scroll>
      {items.length ? (
        <div className={styles.blocks} style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map(({ index, key, start }) => (
            <div
              // Keyed by diff alone: switching the layout keeps each block's diff and its documents.
              key={key}
              ref={virtualizer.measureElement}
              data-index={index}
              className={styles.slot}
              // `top`, not a transform: a sticky header inside a transformed box sticks off by the transform.
              style={{ top: start }}
            >
              <Block
                entry={entries[index]!}
                index={index}
                items={items}
                collapsed={collapsed.has(keys[index]!)}
                onToggle={toggle}
                mode={mode}
                tabKey={tabKey}
                heights={heights}
                viewStates={viewStates}
                entriesCache={entriesCache}
              />
            </div>
          ))}
        </div>
      ) : (
        <div className={clsx(styles.placeholder, styles.empty)}>{empty}</div>
      )}
    </div>
  );

  return (
    <div className={styles.root}>
      <div className={styles.toolbar} role="toolbar" aria-label={tx("Combined Changes Diff")}>
        {toolbarStart && (
          <>
            {toolbarStart}
            <span className={styles.sep} />
          </>
        )}
        <IconButton icon="arrow-up" title="Previous File" size="small" onClick={() => step(-1)} />
        <IconButton icon="arrow-down" title="Next File" size="small" onClick={() => step(1)} />
        <IconButton
          icon={allCollapsed ? "expand-all" : "collapse-all"}
          title={allCollapsed ? "Expand All Files" : "Collapse All Files"}
          size="small"
          onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(keys))}
        />
        <span className={styles.sep} />
        <IconButton
          icon="diff-side-by-side"
          title="Side-by-side Viewer"
          size="small"
          pressed={mode === "split"}
          onClick={() => setViewer("split")}
        />
        <IconButton
          icon="diff-unified"
          title="Unified Viewer"
          size="small"
          pressed={mode === "unified"}
          onClick={() => setViewer("unified")}
        />
        {!files && <span className={styles.count}>{fileCount(items.length)}</span>}
        <span className={styles.grow} />
        {toolbarEnd}
        {onSeparateTabs && (
          <IconButton
            icon="editor-only"
            title="Show Files in Separate Diff Tabs"
            size="small"
            onClick={() => onSeparateTabs(Math.max(0, current()))}
          />
        )}
      </div>
      {files ? (
        <SplitGroup orientation="horizontal" storageKey={files.storageKey} className={styles.split}>
          <SplitPanel
            id="combined-files"
            defaultSize={240}
            minSize={160}
            maxSize="50%"
            className={styles.files}
            style={CLIP}
          >
            {files.content}
          </SplitPanel>
          <SplitHandle aria-label={files.label} />
          <SplitPanel id="combined-diffs" minSize={240} className={styles.diffs} style={CLIP}>
            {scroller}
          </SplitPanel>
        </SplitGroup>
      ) : (
        scroller
      )}
    </div>
  );
}
