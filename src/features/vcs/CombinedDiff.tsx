/**
 * The all-in-one diff tab (`combined-diff`): one block per file of a change, each a diff
 * as tall as its content under a sticky header, in one scrolling view. Only the blocks near
 * the viewport are mounted; a header collapses its block or opens the file's own diff tab.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import clsx from "clsx";
import { tx } from "@/platform/i18n";
import { relativeDir, useProject } from "@/platform/project";
import { Icon, IconButton, T, fileIconName } from "@/ui";
import { editorService, type EditorInput } from "@/workbench/contributions";
import { combinedDiffDocumentOwner, setAllInOneDiff, type CombinedDiffData } from "./allInOneDiff";
import { ResolvedDiffEditor } from "./DiffEditor";
import { diffInput, hasGitlink, openDiff, withChain, type DiffData } from "./diffInput";
import { loadDiffOptions, saveDiffOptions } from "./diffOptions";
import { useGitDiffEntries, type DiffEntriesCache } from "./gitDiffEntries";
import { KIND_COLOR, KIND_LABEL, baseName, fileCount } from "./model";
import styles from "./CombinedDiff.module.css";

type Kind = "added" | "deleted" | "modified";

/** What happened to the file: one side absent means added or deleted. */
export function blockKind(item: DiffData): Kind {
  const absent = (s: DiffData["left"]) => s.type === "text" && !!s.absent;
  return absent(item.left) ? "added" : absent(item.right) ? "deleted" : "modified";
}

/** Height of a block not measured yet: its header and a short diff. */
const ESTIMATE = 200;

function Block({
  item,
  index,
  items,
  collapsed,
  onToggle,
  mode,
  tabKey,
  heights,
  entriesCache,
}: {
  item: DiffData;
  index: number;
  items: readonly DiffData[];
  collapsed: boolean;
  onToggle: () => void;
  mode: "split" | "unified";
  tabKey: string;
  /** Height of each block's loaded diff, by layout and diff, kept while blocks are unmounted. */
  heights: Map<string, number>;
  /** Git entries of the blocks, so a block back in view shows without asking Git again. */
  entriesCache: DiffEntriesCache;
}) {
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
  const dir = relativeDir(root, item.path);
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
          onClick={onToggle}
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
          document (saved first with autosave on), and staged edits are saved to the index. */}
      {loaded && (
        <div ref={bodyRef} className={styles.body} hidden={collapsed} style={hold ? { minHeight: hold } : undefined}>
          <ResolvedDiffEditor
            diff={diff}
            input={input}
            documentOwner={combinedDiffDocumentOwner(tabKey, input.key)}
            fit
          />
        </div>
      )}
    </section>
  );
}

export function CombinedDiffTab({ input }: { input: EditorInput }) {
  const data = input.data as CombinedDiffData;
  const items = data.items;
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [mode, setMode] = useState(() => loadDiffOptions().mode);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [heights] = useState(() => new Map<string, number>());
  const [entriesCache] = useState<DiffEntriesCache>(() => new Map());
  // A partially staged file is listed twice (staged and unstaged), so blocks go by diff, not path.
  const keys = useMemo(() => items.map((item) => diffInput(item).key), [items]);

  // The block holding the keyboard focus stays mounted when scrolled away, so typing still reaches it.
  const rangeExtractor = useCallback((range: Range) => {
    const shown = defaultRangeExtractor(range);
    const active = document.activeElement;
    const slot = scrollRef.current?.contains(active) ? active?.closest<HTMLElement>("[data-index]") : null;
    const focused = slot ? Number(slot.dataset.index) : -1;
    return focused < 0 || shown.includes(focused) ? shown : [...shown, focused].sort((a, b) => a - b);
  }, []);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => keys[index]!,
    estimateSize: () => ESTIMATE,
    overscan: 4,
    rangeExtractor,
  });

  /** Index of the block at the top of the view. */
  const current = () =>
    virtualizer.getVirtualItemForOffset(scrollRef.current?.scrollTop ?? 0)?.index ?? items.length - 1;
  const step = (dir: 1 | -1) => {
    const next = current() + dir;
    if (next >= 0 && next < items.length) virtualizer.scrollToIndex(next, { align: "start" });
  };

  // Open at the file the diff was asked for.
  useLayoutEffect(() => {
    const at = data.reveal ? items.findIndex((i) => i.path === data.reveal) : -1;
    if (at >= 0) virtualizer.scrollToIndex(at, { align: "start" });
    // Once per tab: later revisits keep their scroll position.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setViewer = (next: "split" | "unified") => {
    setMode(next);
    saveDiffOptions({ ...loadDiffOptions(), mode: next });
  };
  const toggle = (key: string) =>
    setCollapsed((c) => {
      const s = new Set(c);
      if (s.has(key)) s.delete(key);
      else s.add(key);
      return s;
    });
  const allCollapsed = items.length > 0 && keys.every((key) => collapsed.has(key));

  return (
    <div className={styles.root}>
      <div className={styles.toolbar} role="toolbar" aria-label={tx("Combined Changes Diff")}>
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
        <span className={styles.count}>{fileCount(items.length)}</span>
        <span className={styles.grow} />
        <IconButton
          icon="editor-only"
          title="Show Files in Separate Diff Tabs"
          size="small"
          onClick={() => {
            // Back to one diff per file, at the file in view.
            setAllInOneDiff(false);
            const at = Math.max(0, current());
            void openDiff(withChain(items, at)).then(() => editorService().closeInput?.(input.key));
          }}
        />
      </div>
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
                  item={items[index]!}
                  index={index}
                  items={items}
                  collapsed={collapsed.has(keys[index]!)}
                  onToggle={() => toggle(keys[index]!)}
                  mode={mode}
                  tabKey={input.key}
                  heights={heights}
                  entriesCache={entriesCache}
                />
              </div>
            ))}
          </div>
        ) : (
          <div className={clsx(styles.placeholder, styles.empty)}>
            <T>No changes</T>
          </div>
        )}
      </div>
    </div>
  );
}
