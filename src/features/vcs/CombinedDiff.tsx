/**
 * The all-in-one diff tab (`combined-diff`): one block per file of a change, each a diff
 * as tall as its content under a sticky header, in one scrolling view. Blocks load as they
 * come near the viewport; a header collapses its block or opens the file's own diff tab.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { tx } from "@/platform/i18n";
import { relativeDir, useProject } from "@/platform/project";
import { Icon, IconButton, T, fileIconName } from "@/ui";
import { editorService, type EditorInput } from "@/workbench/contributions";
import { setAllInOneDiff, type CombinedDiffData } from "./allInOneDiff";
import { DiffEditor } from "./DiffEditor";
import { diffInput, openDiff, withChain, type DiffData } from "./diffInput";
import { loadDiffOptions, saveDiffOptions } from "./diffOptions";
import { KIND_COLOR, KIND_LABEL, baseName, fileCount } from "./model";
import styles from "./CombinedDiff.module.css";

type Kind = "added" | "deleted" | "modified";

/** What happened to the file: one side absent means added or deleted. */
export function blockKind(item: DiffData): Kind {
  const absent = (s: DiffData["left"]) => s.type === "text" && !!s.absent;
  return absent(item.left) ? "added" : absent(item.right) ? "deleted" : "modified";
}

/** How far below the viewport a block starts loading (above it, only once scrolled to). */
const PRELOAD = "0px 0px 800px 0px";

function Block({
  item,
  index,
  items,
  collapsed,
  onToggle,
  mode,
}: {
  item: DiffData;
  index: number;
  items: readonly DiffData[];
  collapsed: boolean;
  onToggle: () => void;
  mode: "split" | "unified";
}) {
  const ref = useRef<HTMLElement>(null);
  // Without IntersectionObserver (tests), every block loads at once.
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const el = ref.current;
    if (!el || near) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear(true);
      },
      { root: el.closest("[data-combined-scroll]"), rootMargin: PRELOAD },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [near]);
  const input: EditorInput = useMemo(() => diffInput({ ...item, mode }), [item, mode]);
  const kind = blockKind(item);
  const name = baseName(item.path);
  const root = useProject((s) => s.project?.root ?? "");
  const dir = relativeDir(root, item.path);
  return (
    <section
      ref={ref}
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
        {item.right.type === "worktree" && (
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
          {dir && <span className={styles.dir}>{dir}</span>}
        </div>
      </div>
      {/* A collapsed block keeps its loaded diff, hidden: unmounting it would release the
          working-tree document and, with autosave off, drop its unsaved edits. */}
      {near ? (
        <div className={styles.body} hidden={collapsed}>
          <DiffEditor input={input} fit />
        </div>
      ) : (
        !collapsed && <div className={styles.placeholder} />
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

  const blocks = () => [...(scrollRef.current?.querySelectorAll<HTMLElement>("[data-combined-block]") ?? [])];
  /** The block at the top of the view. */
  const current = () => {
    const top = scrollRef.current?.getBoundingClientRect().top ?? 0;
    const all = blocks();
    const at = all.findIndex((b) => b.getBoundingClientRect().bottom > top + 1);
    return at < 0 ? all.length - 1 : at;
  };
  const scrollTo = (path: string) => {
    const el = blocks().find((b) => b.dataset.combinedBlock === path);
    const scroller = scrollRef.current;
    if (el && scroller) {
      const inset = Number.parseFloat(getComputedStyle(scroller).paddingTop) || 0;
      scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - inset;
    }
  };
  const step = (dir: 1 | -1) => {
    const next = items[current() + dir];
    if (next) scrollTo(next.path);
  };

  // Open at the file the diff was asked for.
  useLayoutEffect(() => {
    if (data.reveal) scrollTo(data.reveal);
    // Once per tab: later revisits keep their scroll position.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setViewer = (next: "split" | "unified") => {
    setMode(next);
    saveDiffOptions({ ...loadDiffOptions(), mode: next });
  };
  const toggle = (path: string) =>
    setCollapsed((c) => {
      const s = new Set(c);
      if (s.has(path)) s.delete(path);
      else s.add(path);
      return s;
    });
  const allCollapsed = items.length > 0 && items.every((i) => collapsed.has(i.path));

  return (
    <div className={styles.root}>
      <div className={styles.toolbar} role="toolbar" aria-label={tx("Combined Changes Diff")}>
        <IconButton icon="arrow-up" title="Previous File" size="small" onClick={() => step(-1)} />
        <IconButton icon="arrow-down" title="Next File" size="small" onClick={() => step(1)} />
        <IconButton
          icon={allCollapsed ? "expand-all" : "collapse-all"}
          title={allCollapsed ? "Expand All Files" : "Collapse All Files"}
          size="small"
          onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(items.map((i) => i.path)))}
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
          items.map((item, index) => (
            <Block
              // Keyed by file alone: switching the layout keeps each block's diff and its documents.
              key={item.path}
              item={item}
              index={index}
              items={items}
              collapsed={collapsed.has(item.path)}
              onToggle={() => toggle(item.path)}
              mode={mode}
            />
          ))
        ) : (
          <div className={clsx(styles.placeholder, styles.empty)}>
            <T>No changes</T>
          </div>
        )}
      </div>
    </div>
  );
}
