import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
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
import { useRowHeight } from "@/ui/density";
import type { OutlineItem } from "@/platform/ipc";
import { useShownLine } from "@/editor/api";
import { badgeKind, basename, openLocation } from "../common/open";
import { useTracking } from "../common/tracking";
import {
  allKeys,
  filterOutline,
  hasFields,
  hasVisibility,
  isWidgetBuild,
  parentKeys,
  symbolPathAt,
  visibleCount,
  widgetLetter,
  type OutlineNode,
} from "./outline";
import { useCollapsedStructure, useLiveOutline, useOutline, useOutlineNodes, useStructureOptions } from "./store";
import styles from "./StructureView.module.css";
import { tx } from "@/platform/i18n";

function viewOptionItems(items: readonly OutlineItem[], widgets: boolean, inheritedSupported: boolean): MenuItem[] {
  const o = useStructureOptions.getState();
  const visibility = hasVisibility(items);
  const sort: MenuItem[] = [
    {
      label: "Sort Alphabetically",
      checked: o.alphabetical,
      run: () => useStructureOptions.setState({ alphabetical: !o.alphabetical }),
    },
  ];
  if (visibility)
    sort.push({
      label: "Sort by Visibility",
      checked: o.sortByVisibility,
      run: () => useStructureOptions.setState({ sortByVisibility: !o.sortByVisibility }),
    });
  const filters: MenuItem[] = [];
  if (hasFields(items) || !o.showFields)
    filters.push({
      label: "Show Fields",
      checked: o.showFields,
      run: () => useStructureOptions.setState({ showFields: !o.showFields }),
    });
  if (visibility)
    filters.push({
      label: "Show Non-Public",
      checked: o.showNonPublic,
      run: () => useStructureOptions.setState({ showNonPublic: !o.showNonPublic }),
    });
  if (inheritedSupported)
    filters.push({
      label: "Show Inherited",
      checked: o.showInherited,
      run: () => useStructureOptions.setState({ showInherited: !o.showInherited }),
    });
  if (widgets)
    filters.push({
      label: "Show Only Widgets",
      checked: o.showOnlyWidgets,
      run: () => useStructureOptions.setState({ showOnlyWidgets: !o.showOnlyWidgets }),
    });
  return filters.length ? [...sort, { kind: "separator" }, ...filters] : sort;
}

/** The Flutter plugin's widget icon: a disc with the class's initial, pink for a private class. */
function WidgetBadge({ name }: { name: string }) {
  return (
    <span className={clsx(styles.badge, styles.widgetBadge, name.startsWith("_") && styles.privateWidget)} aria-hidden>
      {widgetLetter(name)}
    </span>
  );
}

const navigate = (path: string, node: OutlineNode, focus: boolean) => {
  const p = node.item.selection_range.start;
  void openLocation(node.inherited?.path ?? path, { line: p.line, col: p.col }, { focus });
};

/** A symbol row; inherited members are greyed and name their supertype. */
function SymbolRow({
  node,
  indices,
  selected,
  dim,
}: {
  node: OutlineNode;
  indices?: readonly number[] | null;
  selected: boolean;
  dim?: boolean;
}) {
  return (
    <span className={clsx(styles.node, dim && styles.ancestor, node.inherited && styles.inherited)}>
      {node.item.kind === "widget" ? (
        <WidgetBadge name={node.item.name} />
      ) : (
        <SymbolBadge kind={badgeKind(node.item.kind)} className={styles.badge} />
      )}
      <HighlightedText
        className={clsx(styles.name, isWidgetBuild(node.item) && styles.widgetBuild)}
        text={node.item.name}
        indices={indices}
        tone={selected ? "accent" : "strong"}
      />
      {node.item.detail && <span className={styles.detail}>{node.item.detail}</span>}
      {node.inherited && <span className={styles.detail}>{`↑${node.inherited.owner}`}</span>}
    </span>
  );
}

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
  const shownLine = useShownLine(path);
  const collapsed = useCollapsedStructure((s) => s.keys);
  const nodes = useOutlineNodes(true);
  const tree = useRef<TreeHandle>(null);
  const revealing = useRef(false);

  const expandable = useMemo(() => [FILE_KEY, ...allKeys(nodes)], [nodes]);
  const expanded = useMemo(() => new Set(expandable.filter((k) => !collapsed.has(k))), [expandable, collapsed]);
  const roots = useMemo<StructNode[]>(
    () => [{ key: FILE_KEY, file: true, name: path ? basename(path) : "", children: nodes }],
    [nodes, path],
  );

  // Autoscroll from source: select the innermost symbol around the caret, or
  // around the line on screen of a Markdown file shown Preview only.
  const caretPath = useMemo(() => {
    if (!autoscroll) return [];
    if (shownLine !== null) return symbolPathAt(nodes, { line: shownLine, col: 0 });
    if (!caret || caret.path !== path) return [];
    return symbolPathAt(nodes, { line: caret.line, col: caret.col });
  }, [autoscroll, caret, shownLine, path, nodes]);
  const caretKey = caretPath[caretPath.length - 1] ?? null;

  useEffect(() => {
    if (!caretKey) return;
    const hidden = caretPath.slice(0, -1).filter((k) => collapsed.has(k));
    if (hidden.length) {
      const next = new Set(collapsed);
      hidden.forEach((k) => next.delete(k));
      useCollapsedStructure.setState({ keys: next });
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
      <Tree<StructNode>
        className={styles.tree}
        aria-label="Structure"
        handleRef={tree}
        roots={roots}
        getKey={(n) => n.key}
        getLabel={(n) =>
          isFile(n) ? n.name : n.item.kind === "widget" ? `${n.item.name} ${n.item.detail ?? ""}` : n.item.name
        }
        getChildren={(n) => (n.children.length ? n.children : undefined)}
        isExpandable={(n) => n.children.length > 0}
        expanded={expanded}
        onExpandedChange={(next) =>
          useCollapsedStructure.setState({ keys: new Set(expandable.filter((k) => !next.has(k))) })
        }
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

export function StructureHeaderActions() {
  const path = useOutline((s) => (s.items === null ? null : s.path));
  return path ? <StructureViewOptions key={path} /> : null;
}

function StructureViewOptions() {
  const inheritedSupported = useOutline((s) => s.inheritedSupported);
  const flutter = useOutline((s) => s.flutter);
  const items = useOutline((s) => s.flutter ?? s.items);
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const narrowed = useStructureOptions(
    (s) =>
      s.alphabetical ||
      !s.showFields ||
      !s.showNonPublic ||
      s.sortByVisibility ||
      (inheritedSupported && s.showInherited) ||
      (!!flutter && s.showOnlyWidgets),
  );
  return (
    <>
      <IconButton
        ref={anchor}
        icon="filter"
        title="View Options"
        size="small"
        iconSize={16}
        pressed={narrowed}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      />
      <Menu
        open={open}
        anchor={anchor}
        items={open ? viewOptionItems(items ?? [], !!flutter, inheritedSupported) : []}
        onClose={() => setOpen(false)}
        placement="bottom-end"
        aria-label="View Options"
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// ⌘F12 File Structure popup

import { useFileStructurePopup } from "./popupStore";
export { useFileStructurePopup };

export function FileStructureOverlay() {
  const open = useFileStructurePopup((s) => s.open);
  return open ? <FileStructureDialog /> : null;
}

const POPUP_ROW = 22;

function FileStructureDialog() {
  useLiveOutline();
  const rowHeight = useRowHeight(POPUP_ROW);
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
  const [showOptions, setShowOptions] = useState(false);
  // IDEA opens the popup fully expanded.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const caret = useMemo(() => useTracking.getState().caret, []);
  const tree = useRef<TreeHandle>(null);
  const optionsButton = useRef<HTMLButtonElement>(null);

  const filter = useMemo(() => filterOutline(nodes, query, narrowDown), [nodes, query, narrowDown]);
  const parents = useMemo(() => parentKeys(filter.nodes), [filter.nodes]);
  const byKey = useMemo(() => {
    const m = new Map<string, OutlineNode>();
    const walk = (list: readonly OutlineNode[]) => list.forEach((n) => (m.set(n.key, n), walk(n.children)));
    walk(filter.nodes);
    return m;
  }, [filter.nodes]);
  const expanded = useMemo(
    () => new Set(allKeys(filter.nodes).filter((k) => !collapsed.has(k))),
    [filter.nodes, collapsed],
  );

  // Preselect the symbol at the caret, then the best match while filtering.
  const caretKey = useMemo(
    () =>
      caret && caret.path === path ? (symbolPathAt(nodes, { line: caret.line, col: caret.col }).pop() ?? null) : null,
    [caret, path, nodes],
  );
  const hasQuery = !!query.trim();
  useLayoutEffect(() => {
    const key = query.trim() ? filter.best : (caretKey ?? filter.nodes[0]?.key);
    if (key) tree.current?.reveal(key);
    else tree.current?.clearSelection();
  }, [query, caretKey, filter.best, filter.nodes]);

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
        if (hasQuery && !narrowDown && filter.order.length) {
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

  const height = Math.min(420, Math.max(1, visibleCount(filter.nodes, collapsed)) * rowHeight + 8);
  const name = path ? basename(path) : tx("File Structure");
  return (
    <Dialog
      open
      onClose={close}
      width={540}
      position="top"
      transparentBackdrop
      className={styles.structurePopup}
      aria-label="File Structure"
      title={
        <span className={styles.popupTitle}>
          <span className={styles.popupName} title={name}>
            {name}
          </span>
          <span className={styles.popupHint}>{shortcutLabel("navigate.fileStructure")}</span>
        </span>
      }
    >
      <div className={styles.popupToolbar}>
        <div className={styles.popupOptions} role="group" aria-label={tx("Structure actions")}>
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
        <IconButton
          ref={optionsButton}
          icon="settings"
          title="View Options"
          size="small"
          aria-haspopup="menu"
          aria-expanded={showOptions}
          onClick={() => setShowOptions((open) => !open)}
        />
        <Menu
          open={showOptions}
          onClose={() => setShowOptions(false)}
          anchor={optionsButton}
          placement="bottom-end"
          aria-label={tx("View Options")}
          items={[
            {
              label: "Sort Alphabetically",
              checked: alphabetical,
              run: () => useStructureOptions.setState({ alphabetical: !alphabetical }),
            },
            { kind: "separator" },
            {
              label: "Narrow down on typing",
              checked: narrowDown,
              run: () => useStructureOptions.setState({ narrowDown: !narrowDown }),
            },
          ]}
        />
      </div>
      <div className={styles.filterRow}>
        <Icon name="search" size={16} />
        <input
          data-autofocus
          className={styles.filter}
          value={query}
          placeholder={path ? tx("Type to filter symbols") : tx("No active editor")}
          aria-label={tx("Filter symbols")}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            setQuery(e.target.value);
            setCollapsed(new Set());
          }}
          onKeyDown={onKeyDown}
        />
        {hasQuery && !narrowDown && !filter.best && filter.nodes.length > 0 && (
          <span className={styles.filterStatus} role="status">
            {tx("No matches")}
          </span>
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
          rowHeight={rowHeight}
          indent={16}
          empty={
            <span className={styles.popupEmpty}>
              {!path ? tx("Open a file first") : loading && !items ? tx("Loading…") : tx("No symbols")}
            </span>
          }
          renderNode={(n, s) => {
            const matched = filter.matches.get(n.key);
            return <SymbolRow node={n} indices={matched} selected={s.selected} dim={hasQuery && !matched} />;
          }}
        />
      </div>
    </Dialog>
  );
}
