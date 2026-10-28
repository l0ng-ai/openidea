import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { create } from "zustand";
import clsx from "clsx";
import { shortcutLabel } from "@/platform/keymap";
import {
  Checkbox,
  Dialog,
  EmptyState,
  HighlightedText,
  Icon,
  IconButton,
  Menu,
  SymbolBadge,
  Tree,
  fileIconName,
  type MenuItem,
  type TreeHandle,
  T,
} from "@/ui";
import type { OutlineItem } from "@/platform/ipc";
import { badgeKind, basename, openLocation } from "../common/open";
import { useTracking } from "../common/tracking";
import {
  allKeys,
  applyViewFilter,
  filterOutline,
  hasFields,
  hasVisibility,
  keyOutline,
  parentKeys,
  sortOutline,
  symbolPathAt,
  visibleCount,
  withInherited,
  type OutlineNode,
} from "./outline";
import { useLiveOutline, useOutline, useStructureOptions } from "./store";
import styles from "./StructureView.module.css";
import { tx } from "@/platform/i18n";

function useOutlineNodes() {
  const items = useOutline((s) => s.items);
  const alphabetical = useStructureOptions((s) => s.alphabetical);
  const byVisibility = useStructureOptions((s) => s.sortByVisibility);
  const fields = useStructureOptions((s) => s.showFields);
  const nonPublic = useStructureOptions((s) => s.showNonPublic);
  const showInherited = useStructureOptions((s) => s.showInherited);
  const supported = useOutline((s) => s.inheritedSupported);
  const inherited = useOutline((s) => s.inherited);
  const extra = showInherited && supported ? inherited : null;
  return useMemo(
    () => sortOutline(applyViewFilter(withInherited(keyOutline(items ?? []), extra), { fields, nonPublic }), alphabetical, byVisibility),
    [items, extra, alphabetical, byVisibility, fields, nonPublic],
  );
}

/** IDEA's view options: Show Fields, Show Non-Public and Sort by Visibility (only when the outline knows visibility). */
function viewOptionItems(items: readonly OutlineItem[]): MenuItem[] {
  const o = useStructureOptions.getState();
  const out: MenuItem[] = [];
  if (hasFields(items) || !o.showFields)
    out.push({
      label: "Show Fields",
      checked: o.showFields,
      run: () => useStructureOptions.setState({ showFields: !o.showFields }),
    });
  if (hasVisibility(items)) {
    out.push(
      {
        label: "Show Non-Public",
        checked: o.showNonPublic,
        run: () => useStructureOptions.setState({ showNonPublic: !o.showNonPublic }),
      },
      { kind: "separator" },
      {
        label: "Sort by Visibility",
        checked: o.sortByVisibility,
        run: () => useStructureOptions.setState({ sortByVisibility: !o.sortByVisibility }),
      },
    );
  }
  return out;
}

const navigate = (path: string, node: OutlineNode, focus: boolean) => {
  const p = node.item.selection_range.start;
  void openLocation(node.inherited?.path ?? path, { line: p.line, col: p.col }, { focus });
};

/** A symbol row; inherited members are greyed and name their supertype. */
function SymbolRow({ node, indices, selected, dim }: { node: OutlineNode; indices?: readonly number[] | null; selected: boolean; dim?: boolean }) {
  return (
    <span className={clsx(styles.node, dim && styles.ancestor, node.inherited && styles.inherited)}>
      <SymbolBadge kind={badgeKind(node.item.kind)} className={styles.badge} />
      <HighlightedText
        className={styles.name}
        text={node.item.name}
        indices={indices}
        tone={selected ? "accent" : "strong"}
      />
      {node.item.detail && <span className={styles.detail}>{node.item.detail}</span>}
      {node.inherited && <span className={styles.detail}>{`↑${node.inherited.owner}`}</span>}
    </span>
  );
}

const useCollapsed = create<{ keys: ReadonlySet<string> }>(() => ({ keys: new Set() }));

/** The file itself, shown as the tree root like IDEA. */
interface FileRoot {
  key: string;
  file: true;
  name: string;
  children: OutlineNode[];
}
type StructNode = OutlineNode | FileRoot;
const FILE_KEY = "\u0000file";
const isFile = (n: StructNode): n is FileRoot => "file" in n;

// ---------------------------------------------------------------------------
// Tool window

export function StructureView() {
  useLiveOutline();
  const path = useOutline((s) => s.path);
  const items = useOutline((s) => s.items);
  const loading = useOutline((s) => s.loading);
  const error = useOutline((s) => s.error);
  const autoscroll = useStructureOptions((s) => s.autoscrollFromSource);
  const caret = useTracking((s) => s.caret);
  const collapsed = useCollapsed((s) => s.keys);
  const nodes = useOutlineNodes();
  const tree = useRef<TreeHandle>(null);
  const revealing = useRef(false);

  const expandable = useMemo(() => [FILE_KEY, ...allKeys(nodes)], [nodes]);
  const expanded = useMemo(() => new Set(expandable.filter((k) => !collapsed.has(k))), [expandable, collapsed]);
  const roots = useMemo<StructNode[]>(
    () => [{ key: FILE_KEY, file: true, name: path ? basename(path) : "", children: nodes }],
    [nodes, path],
  );

  // Autoscroll from source: select the innermost symbol around the caret.
  const caretPath = useMemo(() => {
    if (!autoscroll || !caret || caret.path !== path) return [];
    return symbolPathAt(nodes, { line: caret.line, col: caret.col });
  }, [autoscroll, caret, path, nodes]);
  const caretKey = caretPath[caretPath.length - 1] ?? null;

  useEffect(() => {
    if (!caretKey) return;
    const hidden = caretPath.slice(0, -1).filter((k) => collapsed.has(k));
    if (hidden.length) {
      const next = new Set(collapsed);
      hidden.forEach((k) => next.delete(k));
      useCollapsed.setState({ keys: next });
      return; // re-runs once the ancestors are expanded
    }
    revealing.current = true;
    tree.current?.reveal(caretKey);
    revealing.current = false;
  }, [caretKey, caretPath, collapsed]);

  if (!path)
    return (
      <EmptyState>
        <T>No structure to show</T>
      </EmptyState>
    );
  if (!items) {
    return error ? (
      <EmptyState title="Structure unavailable">{error}</EmptyState>
    ) : (
      <div className={styles.loading}>{loading ? tx("Loading…") : null}</div>
    );
  }

  return (
    <div className={styles.root}>
      <StructureToolbar />
      <Tree<StructNode>
        className={styles.tree}
        aria-label="Structure"
        handleRef={tree}
        roots={roots}
        getKey={(n) => n.key}
        getLabel={(n) => (isFile(n) ? n.name : n.item.name)}
        getChildren={(n) => (n.children.length ? n.children : undefined)}
        isExpandable={(n) => n.children.length > 0}
        expanded={expanded}
        onExpandedChange={(next) => useCollapsed.setState({ keys: new Set(expandable.filter((k) => !next.has(k))) })}
        onSelectionChange={(_next, lead) => {
          if (revealing.current || !lead || isFile(lead)) return;
          if (useStructureOptions.getState().autoscrollToSource) navigate(path, lead, false);
        }}
        multiSelect={false}
        activateExpandable
        onActivate={(n) => !isFile(n) && navigate(path, n, true)}
        renderNode={(n, s) =>
          isFile(n) ? (
            <span className={styles.node}>
              <Icon name={fileIconName(n.name)} size={16} className={styles.badge} />
              <HighlightedText className={styles.name} text={n.name} indices={s.matches} tone="strong" />
              {!n.children.length && (
                <span className={styles.detail}>
                  <T>no symbols</T>
                </span>
              )}
            </span>
          ) : (
            <SymbolRow node={n} indices={s.matches} selected={s.selected} />
          )
        }
      />
    </div>
  );
}

function StructureToolbar() {
  const alphabetical = useStructureOptions((s) => s.alphabetical);
  const autoscroll = useStructureOptions((s) => s.autoscrollFromSource);
  const autoscrollToSource = useStructureOptions((s) => s.autoscrollToSource);
  const showInherited = useStructureOptions((s) => s.showInherited);
  const inheritedSupported = useOutline((s) => s.inheritedSupported);
  const items = useOutline((s) => s.items);
  const filterRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<MenuItem[] | null>(null);
  // Subscribed so the menu's availability and pressed state follow the options.
  const narrowed = useStructureOptions((s) => !s.showFields || !s.showNonPublic || s.sortByVisibility);
  const hasOptions = viewOptionItems(items ?? []).length > 0;
  return (
    <div className={styles.toolbar} role="toolbar" aria-label={tx("Structure actions")}>
      <IconButton
        icon="sort"
        title="Sort Alphabetically"
        size="small"
        iconSize={16}
        pressed={alphabetical}
        onClick={() => useStructureOptions.setState({ alphabetical: !alphabetical })}
      />
      {hasOptions && (
        <IconButton
          ref={filterRef}
          icon="filter"
          title="View Options"
          size="small"
          iconSize={16}
          pressed={narrowed}
          onClick={() => setMenu(viewOptionItems(useOutline.getState().items ?? []))}
        />
      )}
      {inheritedSupported && (
        <IconButton
          icon="hierarchy"
          title="Show Inherited"
          size="small"
          iconSize={16}
          pressed={showInherited}
          onClick={() => useStructureOptions.setState({ showInherited: !showInherited })}
        />
      )}
      <Menu open={!!menu} anchor={filterRef} items={menu ?? []} onClose={() => setMenu(null)} />
      <span className={styles.sep} />
      <IconButton
        icon="autoscroll-to-source"
        title="Autoscroll to Source"
        size="small"
        iconSize={16}
        pressed={autoscrollToSource}
        onClick={() => useStructureOptions.setState({ autoscrollToSource: !autoscrollToSource })}
      />
      <IconButton
        icon="autoscroll-from-source"
        title="Autoscroll from Source"
        size="small"
        iconSize={16}
        pressed={autoscroll}
        onClick={() => useStructureOptions.setState({ autoscrollFromSource: !autoscroll })}
      />
      <span className={styles.grow} />
      <IconButton
        icon="expand-all"
        title="Expand All"
        size="small"
        iconSize={16}
        onClick={() => useCollapsed.setState({ keys: new Set() })}
      />
      <IconButton
        icon="collapse-all"
        title="Collapse All"
        size="small"
        iconSize={16}
        onClick={() => useCollapsed.setState({ keys: new Set(allKeys(keyOutline(items ?? []))) })}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// ⌘F12 File Structure popup

export const useFileStructurePopup = create<{ open: boolean }>(() => ({ open: false }));

export function FileStructureOverlay() {
  const open = useFileStructurePopup((s) => s.open);
  return open ? <FileStructureDialog /> : null;
}

const POPUP_ROW = 22;

function FileStructureDialog() {
  useLiveOutline();
  const path = useOutline((s) => s.path);
  const items = useOutline((s) => s.items);
  const loading = useOutline((s) => s.loading);
  const alphabetical = useStructureOptions((s) => s.alphabetical);
  const narrowDown = useStructureOptions((s) => s.narrowDown);
  const showFields = useStructureOptions((s) => s.showFields);
  const showNonPublic = useStructureOptions((s) => s.showNonPublic);
  const showInherited = useStructureOptions((s) => s.showInherited);
  const inheritedSupported = useOutline((s) => s.inheritedSupported);
  const nodes = useOutlineNodes();
  const [query, setQuery] = useState("");
  // IDEA opens the popup fully expanded.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const caret = useMemo(() => useTracking.getState().caret, []);
  const tree = useRef<TreeHandle>(null);

  const filter = useMemo(() => filterOutline(nodes, query, narrowDown), [nodes, query, narrowDown]);
  const parents = useMemo(() => parentKeys(filter.nodes), [filter.nodes]);
  const byKey = useMemo(() => {
    const m = new Map<string, OutlineNode>();
    const walk = (list: readonly OutlineNode[]) => list.forEach((n) => (m.set(n.key, n), walk(n.children)));
    walk(filter.nodes);
    return m;
  }, [filter.nodes]);
  const expanded = useMemo(() => new Set(allKeys(filter.nodes).filter((k) => !collapsed.has(k))), [filter.nodes, collapsed]);

  // Preselect the symbol at the caret, then the best match while filtering.
  const caretKey = useMemo(
    () => (caret && caret.path === path ? (symbolPathAt(nodes, { line: caret.line, col: caret.col }).pop() ?? null) : null),
    [caret, path, nodes],
  );
  const preselect = query.trim() ? filter.best : caretKey;
  useEffect(() => {
    const key = preselect ?? filter.nodes[0]?.key;
    if (key) tree.current?.reveal(key);
  }, [preselect, filter.nodes]);

  const close = () => useFileStructurePopup.setState({ open: false });
  const choose = (node: OutlineNode | undefined) => {
    if (!node || !path) return;
    close();
    setTimeout(() => navigate(path, node, true), 0);
  };
  const setExpanded = (key: string, open: boolean) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (open) next.delete(key);
      else next.add(key);
      return next;
    });

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const lead = tree.current?.leadKey() ?? null;
    const node = lead ? byKey.get(lead) : undefined;
    switch (e.key) {
      case "Enter":
        choose(node);
        break;
      case "Escape":
        // The first Esc clears the filter, the next one closes the popup.
        if (!query) return;
        e.stopPropagation();
        setQuery("");
        break;
      case "ArrowDown":
      case "ArrowUp": {
        const dir = e.key === "ArrowDown" ? 1 : -1;
        if (query.trim() && !narrowDown && filter.order.length) {
          // Highlight mode: ↑/↓ jump between matches.
          const at = lead ? filter.order.indexOf(lead) : -1;
          const n = filter.order.length;
          const next = filter.order[at < 0 ? (dir > 0 ? 0 : n - 1) : (at + dir + n) % n]!;
          for (let p = parents.get(next); p; p = parents.get(p) ?? null) if (collapsed.has(p)) setExpanded(p, true);
          setTimeout(() => tree.current?.reveal(next), 0);
        } else tree.current?.moveSelection(dir);
        break;
      }
      case "ArrowRight":
        if (!node || !node.children.length) return;
        if (!expanded.has(node.key)) setExpanded(node.key, true);
        else tree.current?.reveal(node.children[0]!.key);
        break;
      case "ArrowLeft": {
        if (!node) return;
        if (node.children.length && expanded.has(node.key)) setExpanded(node.key, false);
        else {
          const parent = parents.get(node.key);
          if (parent) tree.current?.reveal(parent);
        }
        break;
      }
      default:
        return;
    }
    e.preventDefault();
  };

  const height = Math.min(420, Math.max(1, visibleCount(filter.nodes, collapsed)) * POPUP_ROW + 8);
  return (
    <Dialog
      open
      onClose={close}
      width={460}
      position="top"
      transparentBackdrop
      aria-label="File Structure"
      title={
        <span className={styles.popupTitle}>
          {path ? basename(path) : tx("File Structure")}
          <span className={styles.popupHint}>{shortcutLabel("navigate.fileStructure")}</span>
        </span>
      }
    >
      <div className={styles.filterRow}>
        <input
          data-autofocus
          className={styles.filter}
          value={query}
          placeholder={path ? "Type to filter symbols" : "No active editor"}
          aria-label={tx("Filter symbols")}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            setQuery(e.target.value);
            setCollapsed(new Set());
          }}
          onKeyDown={onKeyDown}
        />
        <IconButton
          icon="sort"
          title="Sort Alphabetically"
          size="small"
          pressed={alphabetical}
          onClick={() => useStructureOptions.setState({ alphabetical: !alphabetical })}
        />
      </div>
      <div className={styles.popupOptions}>
        <Checkbox
          label="Narrow down on typing"
          checked={narrowDown}
          onChange={(v) => useStructureOptions.setState({ narrowDown: v })}
        />
        {(hasFields(items ?? []) || !showFields) && (
          <Checkbox
            label="Show fields"
            checked={showFields}
            onChange={(v) => useStructureOptions.setState({ showFields: v })}
          />
        )}
        {hasVisibility(items ?? []) && (
          <Checkbox
            label="Show non-public"
            checked={showNonPublic}
            onChange={(v) => useStructureOptions.setState({ showNonPublic: v })}
          />
        )}
        {inheritedSupported && (
          <Checkbox
            label="Show inherited members"
            checked={showInherited}
            onChange={(v) => useStructureOptions.setState({ showInherited: v })}
          />
        )}
      </div>
      <div className={styles.popupList} style={{ height }}>
        <Tree<OutlineNode>
          handleRef={tree}
          aria-label="Symbols"
          roots={filter.nodes}
          getKey={(n) => n.key}
          getLabel={(n) => n.item.name}
          getChildren={(n) => (n.children.length ? n.children : undefined)}
          isExpandable={(n) => n.children.length > 0}
          expanded={expanded}
          onExpandedChange={(_next, n, open) => setExpanded(n.key, open)}
          multiSelect={false}
          speedSearch={false}
          activateExpandable
          onActivate={(n) => choose(n)}
          rowHeight={POPUP_ROW}
          indent={16}
          empty={<span className={styles.popupEmpty}>{!path ? tx("Open a file first") : loading && !items ? tx("Loading…") : tx("No symbols")}</span>}
          renderNode={(n, s) => {
            const matched = filter.matches.get(n.key);
            return <SymbolRow node={n} indices={matched} selected={s.selected} dim={!!query.trim() && !matched} />;
          }}
        />
      </div>
    </Dialog>
  );
}
