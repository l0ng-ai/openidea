/**
 * The Project tool window: a virtualized, lazily loaded file tree with VCS
 * colours (file decorations), inline create / rename, drag & drop moves,
 * OS file drops and keyboard file operations.
 */
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { useEditorRegistry } from "@/editor/api";
import { executeAction } from "@/platform/actions";
import { setContext } from "@/platform/context";
import { tx, useTxTemplate } from "@/platform/i18n";
import { isTauri } from "@/platform/ipc";
import type { RootFolder } from "@/platform/languageSettings";
import { useEffectiveRoots } from "@/platform/projectRoots";
import { macStroke, strokeOf } from "@/platform/keymap";
import { OWNS_FILE_DROP, prepareMenuGroups, useFileDecoration } from "@/workbench/contributions";
import {
  FILES_DRAG,
  HighlightedText,
  Icon,
  Popup,
  dragSession,
  Tree,
  acquirePopup,
  fileIconName,
  folderIconName,
  showContextMenu,
  type DragSession,
  type TreeHandle,
  type TreeRowState,
} from "@/ui";
import { contextMenuItems, menuGroupContext, newMenuItems } from "./contextMenu";
import { openNewPopup } from "./newPopupModel";
import { folderKind } from "./folderKind";
import { useHomeDir } from "./home";
import { keyLike, nodeKeyFor, visibleInfo, type ProjectNode } from "./model";
import { lastFileRefactoring, undoFileRefactoring } from "./fileRefactor";
import {
  cancelEditing,
  checkEditingName,
  commitEditing,
  copyPaths,
  copySelection,
  deleteSelection,
  dropPaths,
  importExternal,
  openFile,
  openMoveDialog,
  openRenameDialog,
  openSelection,
  paste,
  refreshOsClipboard,
  targetFolder,
} from "./operations";
import { isInside, nameOf, parentOf, splitExtension, tildify } from "./paths";
import {
  VIEW_MODES,
  autoExpand,
  clearRevealRequest,
  loadDir,
  revealPath,
  selectModel,
  setDropTarget,
  setExpanded,
  toggleExpanded,
  setSelection,
  useProjectTree,
  type Editing,
} from "./store";
import styles from "./ProjectView.module.css";

function onClipboard(e: ReactClipboardEvent<HTMLDivElement>, action: string) {
  // Inline editors (rename, new file) keep native clipboard behaviour.
  if ((e.target as HTMLElement).closest("input, textarea")) return;
  e.preventDefault();
  void executeAction(action);
}

/** The mounted tree, for actions that move focus into it. */
export const treeHandle: { current: TreeHandle | null } = { current: null };

/** ⌘N in the project view: IDEA's "New" popup under the selected row. */
export function showNewPopup(): boolean {
  const lead = treeHandle.current?.leadKey();
  const row = lead ? document.querySelector<HTMLElement>(`[data-project-key="${CSS.escape(lead)}"]`) : null;
  const rect = (
    row ?? document.querySelector<HTMLElement>('[role="tree"][aria-label="Project"]')
  )?.getBoundingClientRect();
  if (!rect) return false;
  openNewPopup({ x: rect.left + 24, y: rect.bottom }, newMenuItems(targetFolder()));
  return true;
}

const getKey = (n: ProjectNode) => n.key;
const getLabel = (n: ProjectNode) => n.label;
const isExpandable = (n: ProjectNode) => n.dir && !n.placeholder;
const loadChildren = (n: ProjectNode) => loadDir(n.path);

function iconFor(node: ProjectNode, roots: readonly RootFolder[], root: string | null): string {
  if (node.placeholder) return node.placeholder === "dir" ? "folder" : "file";
  if (node.icon) return node.icon;
  if (node.root) return "module";
  if (node.dir) return folderIconName(folderKind(node, roots, root));
  return fileIconName(node.label);
}

// ---------------------------------------------------------------------------
// Inline editor (new file / folder, rename)

function InlineEditor({ editing, initial, onDone }: { editing: Editing; initial: string; onDone: () => void }) {
  const [value, setValue] = useState(initial);
  const [submitted, setSubmitted] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  const check = useMemo(() => checkEditingName(value), [value]);
  const showError = check.error && (submitted || value !== initial) && !(editing.kind === "new" && !value);

  useLayoutEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus({ preventScroll: true });
    // IDEA selects the name without its extension on rename.
    const [stem] = editing.kind === "rename" ? splitExtension(initial) : [initial];
    input.setSelectionRange(0, stem.length);
  }, [editing.kind, initial]);

  // Escape must cancel the edit instead of moving focus to the editor.
  useEffect(() => acquirePopup(), []);

  const finish = async (commit: boolean) => {
    if (finished.current) return;
    if (!commit) {
      finished.current = true;
      cancelEditing();
      onDone();
      return;
    }
    setSubmitted(true);
    if (checkEditingName(value).error) return;
    finished.current = true;
    const ok = await commitEditing(value);
    if (!ok) finished.current = false;
  };

  return (
    <>
      <input
        ref={ref}
        className={clsx(styles.inlineInput, showError && styles.inlineInvalid)}
        value={value}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        aria-label={
          editing.kind === "rename"
            ? "New name"
            : editing.pkg
              ? "New package name"
              : editing.nodeKind === "dir"
                ? "New folder name"
                : "New file name"
        }
        aria-invalid={showError ? true : undefined}
        onChange={(e) => setValue(e.target.value)}
        onMouseDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            void finish(true);
          } else if (e.key === "Escape") {
            e.preventDefault();
            void finish(false);
          }
        }}
        onBlur={() => {
          // Like IDEA's New File popup, clicking elsewhere cancels creating; a rename commits.
          if (editing.kind === "new") return void finish(false);
          const valid = !checkEditingName(value).error && !!value.trim();
          void finish(valid && value !== initial);
        }}
      />
      {showError && (
        <Popup
          open
          anchor={ref}
          placement="bottom-start"
          offset={2}
          role="alert"
          autoFocus={false}
          restoreFocus={false}
          closeOnOutsideClick={false}
          onClose={() => void finish(false)}
          className={styles.inlineError}
        >
          {check.error}
        </Popup>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Rows

interface RowProps {
  node: ProjectNode;
  matches: number[] | null;
  editing: Editing | null;
  cut: boolean;
  dropTarget: boolean;
  detail: string | null;
  onEditDone: () => void;
  onClick: (node: ProjectNode, e: ReactMouseEvent) => void;
  onDoubleClick: (node: ProjectNode, e: ReactMouseEvent) => void;
  onPointerDown: (node: ProjectNode, e: ReactPointerEvent) => void;
}

const Row = memo(function Row({
  node,
  matches,
  editing,
  cut,
  dropTarget,
  detail,
  onEditDone,
  onClick,
  onDoubleClick,
  onPointerDown,
}: RowProps) {
  const deco = useFileDecoration(node.path);
  const roots = useEffectiveRoots();
  const root = useProjectTree((s) => s.root);
  const icon = iconFor(node, roots, root);
  const isEditing =
    !!editing && (node.placeholder ? editing.kind === "new" : editing.kind === "rename" && editing.key === node.key);
  const faded = node.ignored || deco.faded;
  // IDEA dims the icon of excluded folders only; git-ignored ones just get the ignored colour.
  const dimIcon = node.excluded;
  return (
    <span
      className={clsx(styles.content, cut && styles.cut, dropTarget && styles.dropTarget)}
      data-project-path={node.placeholder ? undefined : node.path}
      data-project-key={node.key}
      data-dir={node.dir || undefined}
      title={deco.tooltip}
      onClick={(e) => onClick(node, e)}
      onDoubleClick={(e) => onDoubleClick(node, e)}
      onPointerDown={(e) => onPointerDown(node, e)}
    >
      <Icon
        name={icon}
        size={16}
        className={clsx(styles.icon, node.dir && styles.folderIcon, dimIcon && styles.faded)}
      />
      {isEditing && editing ? (
        <InlineEditor
          editing={editing}
          initial={editing.kind === "rename" ? nameOf(editing.path) : ""}
          onDone={onEditDone}
        />
      ) : (
        <>
          <HighlightedText
            className={clsx(
              styles.label,
              // Only the project itself is bold (IDEA); contributed roots like Scratches are not.
              node.root && !node.icon && styles.rootLabel,
              faded && !deco.color && styles.excluded,
              deco.error && styles.error,
            )}
            style={deco.color ? { color: deco.color } : undefined}
            text={node.label}
            indices={matches}
            tone="accent"
          />
          {detail && <span className={styles.detail}>{detail}</span>}
          {deco.badge && <span className={styles.badge}>{deco.badge}</span>}
        </>
      )}
    </span>
  );
});

// ---------------------------------------------------------------------------
// Drag & drop

interface DragState {
  paths: string[];
  label: string;
  x: number;
  y: number;
  copy: boolean;
}

const DRAG_THRESHOLD = 4;

/** Folder under a viewport point inside `container` (a file row resolves to its folder). */
function folderAt(container: HTMLElement | null, x: number, y: number): { key: string; path: string } | null {
  if (!container) return null;
  const el = document.elementFromPoint(x, y);
  if (!el || !container.contains(el)) return null;
  const row = el.closest("[data-row]");
  const content =
    (row ?? el).querySelector<HTMLElement>("[data-project-path]") ?? el.closest<HTMLElement>("[data-project-path]");
  if (!content) return null;
  const path = content.dataset.projectPath!;
  if (content.dataset.dir) return { key: content.dataset.projectKey!, path };
  const parent = parentOf(path);
  const model = selectModel(useProjectTree.getState());
  const key = model.keyOfPath.get(parent);
  return key ? { key, path: model.byKey.get(key)?.path ?? parent } : null;
}

// ---------------------------------------------------------------------------

export function ProjectView() {
  const txTemplate = useTxTemplate();
  const root = useProjectTree((s) => s.root);
  const model = useProjectTree(selectModel);
  const expanded = useProjectTree((s) => s.expanded);
  const selected = useProjectTree((s) => s.selected);
  const editing = useProjectTree((s) => s.editing);
  const clipboard = useProjectTree((s) => s.clipboard);
  const dropTarget = useProjectTree((s) => s.dropTarget);
  const revealRequest = useProjectTree((s) => s.revealRequest);
  const options = useProjectTree((s) => s.options);
  const home = useHomeDir((s) => s.home);
  const handle = useRef<TreeHandle | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const revealing = useRef(false);

  const info = useMemo(() => visibleInfo(model, expanded), [model, expanded]);
  const mode = useProjectTree((s) => s.mode);

  // Open Files / All Changed Files: show new files' folders expanded.
  useEffect(() => autoExpand(model), [model]);

  // Load folders that are expanded (restored state, reveal, chains) but not read yet.
  useEffect(() => {
    for (const p of info.pending) void loadDir(p);
  }, [info.pending]);

  const setTreeHandle = useCallback((h: TreeHandle | null) => {
    handle.current = h;
    treeHandle.current = h;
  }, []);

  // Select a revealed path once its row exists.
  useEffect(() => {
    if (!revealRequest) return;
    const { path, focus, seq } = revealRequest;
    const exact = model.keyOfPath.get(path);
    const loadingAncestors = info.pending.some((p) => p === path || isInside(path, p));
    if (!exact && loadingAncestors) return;
    const key = exact ?? nodeKeyFor(model, path);
    clearRevealRequest(seq);
    if (!key || !info.visible.has(key)) return;
    revealing.current = true;
    handle.current?.reveal(key);
    revealing.current = false;
    if (focus) handle.current?.focus();
  }, [revealRequest, model, info]);

  // Autoscroll from source: follow the active editor.
  const activePath = useEditorRegistry((s) => s.active?.ctx.path ?? null);
  useEffect(() => {
    if (options.autoscrollFromSource && activePath) revealPath(activePath, false);
  }, [activePath, options.autoscrollFromSource]);

  const getChildren = useCallback((n: ProjectNode) => model.children.get(n.key), [model]);

  const onExpandedChange = useCallback((next: Set<string>, node: ProjectNode, open: boolean) => {
    // Expanding a compacted chain opens every folder in it, so it stays open if the chain breaks.
    if (open) for (const p of node.chain) next.add(keyLike(node.key, p));
    setExpanded(next);
  }, []);

  const onSelectionChange = useCallback((next: Set<string>, lead: ProjectNode | null) => {
    setSelection(next, lead?.key ?? null);
    const { options: o } = useProjectTree.getState();
    if (!revealing.current && o.autoscrollToSource && lead && !lead.dir && !lead.placeholder && next.size === 1)
      void openFile(lead.path, { preview: o.previewTab, focus: false });
  }, []);

  const onActivate = useCallback((node: ProjectNode) => {
    if (!node.dir && !node.placeholder) void openFile(node.path, { focus: true });
  }, []);

  const onContextMenu = useCallback((node: ProjectNode | null, sel: Set<string>, e: ReactMouseEvent) => {
    const m = selectModel(useProjectTree.getState());
    if (!node) {
      const rootNode = m.roots[0];
      if (!rootNode) return;
      setSelection(new Set([rootNode.key]), rootNode.key);
      showContextMenu(e, contextMenuItems([rootNode]));
      return;
    }
    const nodes = [...sel].map((k) => m.byKey.get(k)).filter((n): n is ProjectNode => !!n && !n.placeholder);
    const target = nodes.length ? nodes : [node];
    if (target.every((n) => n.group)) return;
    // Contributed groups may read the file first (bounded wait).
    const at = { x: e.clientX, y: e.clientY };
    void prepareMenuGroups("projectView", menuGroupContext(target)).then(() =>
      showContextMenu(at, contextMenuItems(target)),
    );
  }, []);

  const focusTree = useCallback(() => requestAnimationFrame(() => handle.current?.focus()), []);

  // A pointer drag that ends on the row it started from still clicks it.
  const dragged = useRef(false);

  const onRowClick = useCallback((node: ProjectNode, e: ReactMouseEvent) => {
    if (e.button !== 0 || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || e.detail > 1) return;
    if (node.placeholder || dragged.current) return;
    const { options: o, editing: ed } = useProjectTree.getState();
    if (ed) return;
    if (node.dir) {
      if (o.singleClickExpand) toggleExpanded(node);
      return;
    }
    if (o.singleClickOpen) void openFile(node.path, { focus: false });
    else if (o.previewTab) void openFile(node.path, { preview: true, focus: false });
  }, []);

  // Pointer-driven drag & drop (HTML5 DnD is unreliable inside the Tauri webview).
  // The single click already toggled the folder; double-click must not toggle it back.
  const onRowDoubleClick = useCallback((node: ProjectNode, e: ReactMouseEvent) => {
    if (node.dir && !node.placeholder && useProjectTree.getState().options.singleClickExpand) e.stopPropagation();
  }, []);

  const onRowPointerDown = useCallback((node: ProjectNode, e: ReactPointerEvent) => {
    if (e.button === 0) dragged.current = false;
    if (e.button !== 0 || node.root || node.placeholder || node.readOnly || useProjectTree.getState().editing) return;
    const before = useProjectTree.getState().selected;
    const lead = useProjectTree.getState().lead;
    const startX = e.clientX,
      startY = e.clientY;
    let active = false;
    let paths: string[] = [];
    // Files (not folders) can also be dropped on an editor to open them there.
    let files: DragSession | null = null;
    const move = (ev: PointerEvent) => {
      if (!active) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return;
        active = true;
        dragged.current = true;
        const m = selectModel(useProjectTree.getState());
        const keys = before.has(node.key) ? [...before] : [node.key];
        if (before.has(node.key)) setSelection(before, lead);
        const nodes = keys.map((k) => m.byKey.get(k)).filter((n): n is ProjectNode => !!n && !n.root && !n.placeholder);
        paths = nodes.map((n) => n.path);
        if (!paths.length) return cleanup();
        const filePaths = nodes.filter((n) => !n.dir).map((n) => n.path);
        if (filePaths.length) files = dragSession({ type: FILES_DRAG, payload: filePaths.join("\n") });
      }
      const target = folderAt(containerRef.current, ev.clientX, ev.clientY);
      const valid = target && !paths.some((p) => target.path === p || isInside(target.path, p));
      setDropTarget(valid ? target.key : null);
      if (target) files?.cancel();
      else files?.move(ev.clientX, ev.clientY);
      setDrag({
        paths,
        label: paths.length === 1 ? nameOf(paths[0]!) : tx`${paths.length} items`,
        x: ev.clientX,
        y: ev.clientY,
        copy: ev.altKey,
      });
    };
    const up = (ev: PointerEvent) => {
      const target = active ? folderAt(containerRef.current, ev.clientX, ev.clientY) : null;
      const valid = target && !paths.some((p) => target.path === p || isInside(target.path, p));
      const session = files;
      files = null;
      cleanup();
      if (active && valid) void dropPaths(paths, target.path, ev.altKey);
      else if (active && !target) session?.drop(ev.clientX, ev.clientY);
    };
    const key = (ev: KeyboardEvent) => {
      if (ev.key === "Escape" && active) {
        ev.preventDefault();
        ev.stopPropagation();
        cleanup();
      }
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("keydown", key, true);
      files?.cancel();
      setDropTarget(null);
      setDrag(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("keydown", key, true);
  }, []);

  // Files dropped from the OS (Tauri drag-drop events carry real paths).
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) =>
      getCurrentWebview()
        .onDragDropEvent((event) => {
          const p = event.payload;
          if (p.type === "leave") return setDropTarget(null);
          const ratio = window.devicePixelRatio || 1;
          const x = p.position.x / ratio,
            y = p.position.y / ratio;
          const target = folderAt(containerRef.current, x, y);
          if (p.type === "drop") {
            setDropTarget(null);
            if (target && p.paths.length) void importExternal(p.paths, target.path);
          } else {
            setDropTarget(target?.key ?? null);
          }
        })
        .then((u) => {
          if (disposed) u();
          else unlisten = u;
        }),
    );
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Files copied in Explorer keep Paste usable: the OS clipboard can change
  // while this window is in the background, so re-ask whenever it comes back.
  useEffect(() => {
    void refreshOsClipboard();
    const refresh = () => void refreshOsClipboard();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const stroke = strokeOf(e.nativeEvent);
    let handled = true;
    switch (stroke && macStroke(stroke)) {
      case "Delete":
      case "Meta+Backspace":
        void deleteSelection();
        break;
      case "Shift+F6":
        void openRenameDialog();
        break;
      case "F6":
        openMoveDialog();
        break;
      case "Meta+Z":
        if (lastFileRefactoring()) void undoFileRefactoring();
        else handled = false;
        break;
      case "Meta+C":
        copySelection(false);
        break;
      case "Meta+X":
        copySelection(true);
        break;
      case "Meta+V":
        void paste();
        break;
      case "Shift+Meta+C":
        void copyPaths("absolute");
        break;
      case "F4":
      case "Meta+Down":
        openSelection();
        break;
      case "Meta+N":
      case "Ctrl+Enter":
      case "Alt+Insert":
        showNewPopup();
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const cutPaths = useMemo(() => new Set(clipboard?.cut ? clipboard.paths : []), [clipboard]);
  const rootDetail = root ? tildify(root, home) : null;

  const renderNode = useCallback(
    (node: ProjectNode, state: TreeRowState) => (
      <Row
        node={node}
        matches={state.matches}
        editing={editing}
        cut={cutPaths.has(node.path)}
        dropTarget={dropTarget === node.key}
        detail={node.root && !node.icon ? rootDetail : (node.detail ?? null)}
        onEditDone={focusTree}
        onClick={onRowClick}
        onDoubleClick={onRowDoubleClick}
        onPointerDown={onRowPointerDown}
      />
    ),
    [editing, cutPaths, dropTarget, rootDetail, focusTree, onRowClick, onRowDoubleClick, onRowPointerDown],
  );

  if (!root) return null;

  return (
    <div
      ref={containerRef}
      className={styles.view}
      {...OWNS_FILE_DROP}
      onKeyDown={onKeyDown}
      // The native Edit menu may take ⌘C/⌘X/⌘V before the keymap sees them; it then sends DOM clipboard events.
      onCopy={(e) => onClipboard(e, "project.copy")}
      onCut={(e) => onClipboard(e, "project.cut")}
      onPaste={(e) => onClipboard(e, "project.paste")}
      onFocus={(e) => setContext("projectViewFocus", (e.target as HTMLElement).getAttribute("role") === "tree")}
      onBlur={() => setContext("projectViewFocus", false)}
    >
      {!model.roots.length && (
        <div className={styles.empty}>
          {txTemplate(`Nothing to show in ${VIEW_MODES.find(([id]) => id === mode)?.[1] ?? "this view"}`)}
        </div>
      )}
      <Tree<ProjectNode>
        aria-label="Project"
        handleRef={setTreeHandle}
        roots={model.roots}
        getKey={getKey}
        getLabel={getLabel}
        getChildren={getChildren}
        isExpandable={isExpandable}
        loadChildren={loadChildren}
        renderNode={renderNode}
        rowClassName={(n) => (n.excluded ? styles.excludedRow : undefined)}
        expanded={expanded}
        onExpandedChange={onExpandedChange}
        selected={selected}
        onSelectionChange={onSelectionChange}
        onActivate={onActivate}
        onContextMenu={onContextMenu}
      />
      {drag &&
        createPortal(
          <div className={styles.dragGhost} style={{ left: drag.x + 12, top: drag.y + 8 }} aria-hidden>
            <Icon name={drag.paths.length > 1 ? "list" : fileIconName(drag.label)} size={14} />
            <span>{drag.label}</span>
            {drag.copy && <Icon name="plus" size={12} />}
          </div>,
          document.body,
        )}
    </div>
  );
}
