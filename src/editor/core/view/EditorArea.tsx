import { useFilePresentationIcons } from "@/platform/filePresentation";
/**
 * The editor area: split layout of panes, each with IDEA-style tabs (preview
 * tab in italics, pinned tabs, modified dot, file icons coloured by file
 * decorations, middle-click close, Alt+click close others, double-click to
 * keep a preview / maximize the editor, context menu) and the active editor.
 */
import { Fragment, useEffect, useMemo, useRef, useState, type FocusEvent, type ReactNode } from "react";
import clsx from "clsx";
import { useShallow } from "zustand/react/shallow";
import { executeAction } from "@/platform/actions";
import { setContext } from "@/platform/context";
import { useEditorPrefs } from "@/platform/editorSettings";
import { basename, dirname } from "@/platform/project";
import {
  EDITOR_TAB_MIME,
  acceptsEditorDrop,
  dropOnEditor,
  getFileDecoration,
  prepareMenuGroups,
  textEditorWrapperFor,
  useContributions,
  useFileDecorations,
  useEditorDocumentRevision,
  useTextEditorWrappers,
  type EditorInput,
} from "@/workbench/contributions";
import { useDistractionFree } from "@/workbench/distractionFree";
import { EmptyEditor } from "@/workbench/EditorArea";
import {
  EmptyState,
  Icon,
  IconButton,
  Menu,
  SplitGroup,
  SplitHandle,
  SplitPanel,
  Tabs,
  showContextMenu,
  registerDropTarget,
  FILES_DRAG,
  type TabItem,
  type TabsDnd,
} from "@/ui";
import { editorController, isTextInput, tabIcon, tabTitle, useTabs, type VirtualInputData } from "../controller";
import { useDocMeta } from "../model/document";
import { inputDirty } from "../model/customDocuments";
import type { LayoutNode, SplitEdge, Tab } from "../model/tabs";
import { disambiguateTitles } from "../model/tabTitles";
import { TextEditorHost } from "./TextEditorHost";
import { FindBar } from "./FindBar";
import { EditorBanners, VirtualBanner } from "./Banner";
import { CodeBreadcrumbs } from "./StatusItems";
import styles from "./EditorArea.module.css";
import { tx } from "@/platform/i18n";

export function EditorAreaView() {
  const layout = useTabs((s) => s.layout);
  const empty = useTabs((s) => Object.values(s.panes).every((p) => p.tabs.length === 0));
  if (empty && layout.kind === "pane") return <EmptyEditorArea />;
  return (
    <div className={styles.area}>
      <LayoutView node={layout} />
    </div>
  );
}

/** The empty editor still accepts drops: reopening tabs, opening files, feature drags (agent tasks). */
function EmptyEditorArea() {
  const ref = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return registerDropTarget(el, {
      accepts: (type) => type === EDITOR_TAB_MIME || type === FILES_DRAG || acceptsEditorDrop(type),
      over: () => setOver(true),
      leave: () => setOver(false),
      drop: (data) => {
        setOver(false);
        const paneId = Object.keys(useTabs.getState().panes)[0];
        if (!paneId) return;
        if (data.type === FILES_DRAG) {
          void editorController().openFilesIn(data.payload.split("\n").filter(Boolean), paneId, "center");
          return;
        }
        if (data.type !== EDITOR_TAB_MIME) {
          dropOnEditor(data);
          return;
        }
        const p = parseTabPayload(data.payload);
        if (p) editorController().moveTab(p.paneId, p.tabId, paneId, 0);
      },
    });
  }, []);
  return (
    <div ref={ref} className={styles.area}>
      <EmptyEditor />
      {over && <div className={clsx(styles.dropZone, styles["drop-center"])} aria-hidden="true" />}
    </div>
  );
}

function LayoutView({ node }: { node: LayoutNode }): ReactNode {
  if (node.kind === "pane") return <PaneView paneId={node.paneId} />;
  return (
    <SplitGroup orientation={node.dir === "row" ? "horizontal" : "vertical"} className={styles.group} id={node.id}>
      {node.children.map((child, i) => (
        <Fragment key={child.kind === "pane" ? child.paneId : child.id}>
          {i > 0 && <SplitHandle />}
          <SplitPanel id={child.kind === "pane" ? child.paneId : child.id} minSize={120}>
            <LayoutView node={child} />
          </SplitPanel>
        </Fragment>
      ))}
    </SplitGroup>
  );
}

type DropZone = SplitEdge | "center";

/** Where a tab dropped at (x, y) over an editor goes: an edge (new split) or the pane itself. */
export function dropZoneAt(
  x: number,
  y: number,
  rect: { left: number; top: number; width: number; height: number },
): DropZone {
  const fx = (x - rect.left) / Math.max(1, rect.width);
  const fy = (y - rect.top) / Math.max(1, rect.height);
  const edges: Array<[SplitEdge, number]> = [
    ["left", fx],
    ["right", 1 - fx],
    ["top", fy],
    ["bottom", 1 - fy],
  ];
  const [edge, dist] = edges.reduce((a, b) => (b[1] < a[1] ? b : a));
  return dist < 0.25 ? edge : "center";
}

function parseTabPayload(raw: string): { paneId: string; tabId: string } | null {
  try {
    const v = JSON.parse(raw) as { paneId?: unknown; tabId?: unknown };
    return typeof v.paneId === "string" && typeof v.tabId === "string" ? { paneId: v.paneId, tabId: v.tabId } : null;
  } catch {
    return null;
  }
}

/** Directory hints for open files sharing a name, across all panes. */
function useTitleHints(): Map<string, string> {
  const paths = useTabs(
    useShallow((s) => {
      const out: string[] = [];
      for (const p of Object.values(s.panes))
        for (const t of p.tabs) if (t.input.kind === "file" && t.input.path) out.push(t.input.path);
      return out.sort();
    }),
  );
  return useMemo(() => disambiguateTitles(paths), [paths]);
}

const virtualData = (input: EditorInput) => input.data as VirtualInputData | undefined;

function PaneView({ paneId }: { paneId: string }) {
  const ctrl = editorController();
  const pane = useTabs((s) => s.panes[paneId]);
  const isActivePane = useTabs((s) => s.activePane === paneId);
  const multiPane = useTabs((s) => s.layout.kind === "split");
  const kinds = useContributions((s) => s.editorKinds);
  const tabs = useMemo(() => pane?.tabs ?? [], [pane]);
  const paths = tabs.map((t) => t.input.path ?? "");
  const textDirty = useDocMeta(useShallow((s) => paths.map((p) => !!s[p]?.dirty)));
  useEditorDocumentRevision();
  const dirty = tabs.map((tab, i) => inputDirty(tab.input, kinds) ?? textDirty[i] ?? false);
  const colors = useFileDecorations(useShallow(() => paths.map((p) => (p ? (getFileDecoration(p)?.color ?? "") : ""))));
  const tints = useFileDecorations(useShallow(() => paths.map((p) => (p ? (getFileDecoration(p)?.tint ?? "") : ""))));

  const hints = useTitleHints();
  const [dropZone, setDropZone] = useState<DropZone | null>(null);
  const tabPrefs = useEditorPrefs().tabs;
  const distractionFree = useDistractionFree((s) => s.active);
  const { showExtension, markModified, showCloseButton, showFileIcon, showDirectoryForNonUnique, showFullPathOnHover } =
    tabPrefs;

  const fileIcons = useFilePresentationIcons(
    showFileIcon ? tabs.flatMap((t) => (t.input.kind === "file" && t.input.path ? [t.input.path] : [])) : [],
  );
  const items: TabItem[] = useMemo(() => {
    const names = tabs.map((t) => tabTitle(t.input, kinds));
    return tabs.map((t, i) => {
      const full = names[i]!;
      const dot = full.lastIndexOf(".");
      const name = t.input.kind === "file" && !showExtension && dot > 0 ? full.slice(0, dot) : full;
      const dupe = !showDirectoryForNonUnique
        ? null
        : t.input.kind === "file" && t.input.path
          ? (hints.get(t.input.path) ?? null)
          : names.filter((n) => n === name).length > 1 && t.input.path
            ? basename(dirname(t.input.path))
            : null;
      return {
        id: t.id,
        label: (
          <>
            {markModified && dirty[i] ? `*${name}` : name}
            {dupe && <span className={styles.dupe}>{dupe}</span>}
          </>
        ),
        text: dupe ? `${name} — ${dupe}` : name,
        icon: showFileIcon
          ? t.input.kind === "file" && t.input.path
            ? fileIcons.get(t.input.path)
            : tabIcon(t.input, kinds)
          : undefined,
        italic: t.preview,
        modified: dirty[i],
        closable: showCloseButton,
        color: colors[i] || undefined,
        tint: tints[i] || undefined,
        tooltip: virtualTooltip(t.input) ?? (showFullPathOnHover ? (t.input.path ?? name) : undefined),
        trailing: t.pinned ? <Icon name="pin" size={11} className={styles.pin} label="Pinned" /> : undefined,
      };
    });
  }, [
    fileIcons,
    tabs,
    kinds,
    dirty,
    colors,
    tints,
    hints,
    showExtension,
    markModified,
    showCloseButton,
    showFileIcon,
    showDirectoryForNonUnique,
    showFullPathOnHover,
  ]);

  const pinnedCount = tabs.filter((t) => t.pinned).length;
  // Settings › Editor Tabs › Tab placement Left / Right: a vertical, scrolling column.
  const vertical = tabPrefs.placement === "left" || tabPrefs.placement === "right";
  const pinnedRow =
    tabPrefs.pinnedSeparateRow && (vertical || !tabPrefs.multipleRows) && pinnedCount > 0 && pinnedCount < tabs.length;
  const dnd = useMemo(() => {
    // A tab released outside the window detaches into a forced new window.
    const dropOutside = (raw: string) => {
      const p = parseTabPayload(raw);
      if (p) void ctrl.detachTab(p.paneId, p.tabId);
    };
    const strip = (offset: number): TabsDnd => ({
      type: EDITOR_TAB_MIME,
      payload: (tabId) => JSON.stringify({ paneId, tabId }),
      onDrop: (raw, index) => {
        const p = parseTabPayload(raw);
        if (p) ctrl.moveTab(p.paneId, p.tabId, paneId, index + offset);
      },
      onDropOutside: dropOutside,
    });
    return { all: strip(0), rest: strip(pinnedCount) };
  }, [ctrl, paneId, pinnedCount]);

  // Dropping a tab or project files on the editor: an edge splits, the middle opens / moves here.
  const contentRef = useRef<HTMLDivElement>(null);
  const hasPane = !!pane;
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const zoneAt = (x: number, y: number) => dropZoneAt(x, y, el.getBoundingClientRect());
    return registerDropTarget(el, {
      accepts: (type) => type === EDITOR_TAB_MIME || type === FILES_DRAG || acceptsEditorDrop(type),
      over: (data, x, y) =>
        setDropZone(data.type === EDITOR_TAB_MIME || data.type === FILES_DRAG ? zoneAt(x, y) : "center"),
      leave: () => setDropZone(null),
      drop: (data, x, y) => {
        const zone = zoneAt(x, y);
        setDropZone(null);
        if (data.type === FILES_DRAG) {
          void ctrl.openFilesIn(data.payload.split("\n").filter(Boolean), paneId, zone);
          return;
        }
        if (data.type !== EDITOR_TAB_MIME) {
          dropOnEditor(data);
          return;
        }
        const p = parseTabPayload(data.payload);
        if (!p) return;
        const target = useTabs.getState().panes[paneId];
        if (zone === "center") ctrl.moveTab(p.paneId, p.tabId, paneId, target?.tabs.length ?? 0);
        else ctrl.moveTabToSplit(p.paneId, p.tabId, paneId, zone);
      },
    });
  }, [ctrl, paneId, hasPane]);

  if (!pane) return null;
  const active = pane.tabs.find((t) => t.id === pane.active) ?? null;

  const onFocus = () => {
    setContext("editorFocus", true);
    if (!isActivePane) useTabs.setState((s) => ({ ...s, activePane: paneId }), true);
    ctrl.publishContext();
  };
  const onBlur = (e: FocusEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setContext("editorFocus", false);
  };

  const hidden = tabPrefs.placement === "none" || distractionFree;
  const strip = (stripItems: TabItem[], stripDnd: TabsDnd, trailing: ReactNode) => (
    <Tabs
      className={clsx(styles.tabs, !pinnedRow && hidden && styles.tabsHidden)}
      variant="editor"
      orientation={vertical ? "vertical" : "horizontal"}
      aria-label="Editor tabs"
      items={stripItems}
      activeId={pane.active}
      panelIdPrefix={`editor-${paneId}`}
      dnd={stripDnd}
      layout={tabPrefs.multipleRows ? "wrap" : tabPrefs.oneRowOverflow === "squeeze" ? "squeeze" : "scroll"}
      closePosition={tabPrefs.closeButtonPosition === "left" ? "left" : "right"}
      onSelect={(id) => ctrl.activate(paneId, id)}
      onClose={(id) => void ctrl.closeTab(paneId, id)}
      onCloseOthers={(id) => void ctrl.closeOthers(paneId, id)}
      closeOnShiftClick
      onDoubleClick={(id) => {
        // IDEA: a preview tab becomes a regular one; any other tab maximizes the editor.
        if (pane.tabs.find((t) => t.id === id)?.preview) ctrl.keepTab(paneId, id);
        else void executeAction("toolwindow.hideAll");
      }}
      onContextMenu={(id, e) => {
        const tab = pane.tabs.find((t) => t.id === id);
        if (!tab) return;
        e.preventDefault();
        // Contributed groups (Run '…') may read a background tab's file first (bounded wait).
        const at = { x: e.clientX, y: e.clientY };
        const path = tab.input.kind === "file" ? tab.input.path : undefined;
        if (!path) return showContextMenu(at, ctrl.tabMenu(paneId, tab));
        void prepareMenuGroups("editorTab", { paths: [path] }).then(() =>
          showContextMenu(at, ctrl.tabMenu(paneId, tab)),
        );
      }}
      trailing={trailing}
    />
  );
  const actions = active && !hidden ? <EditorTabActions paneId={paneId} tab={active} /> : undefined;

  return (
    <section
      className={clsx(
        styles.pane,
        multiPane && !isActivePane && styles.inactivePane,
        tabPrefs.placement === "bottom" && styles.tabsBottom,
        vertical && styles.tabsVertical,
        tabPrefs.placement === "right" && styles.tabsRight,
      )}
      data-pane-id={paneId}
      aria-label={tx("Editor")}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      {pinnedRow ? (
        // Settings › Editor Tabs › Show pinned tabs in a separate row.
        <div className={clsx(styles.tabRows, hidden && styles.tabsHidden)}>
          {strip(items.slice(0, pinnedCount), dnd.all, vertical ? actions : undefined)}
          {strip(items.slice(pinnedCount), dnd.rest, vertical ? undefined : actions)}
        </div>
      ) : (
        strip(items, dnd.all, actions)
      )}
      <div
        className={styles.content}
        role="tabpanel"
        id={active ? `editor-${paneId}-panel-${active.id}` : undefined}
        aria-labelledby={active ? `editor-${paneId}-tab-${active.id}` : undefined}
        ref={contentRef}
      >
        {active ? <PaneContent paneId={paneId} tab={active} tabsVisible={!hidden} /> : <EmptyEditor />}
        {dropZone && <div className={clsx(styles.dropZone, styles[`drop-${dropZone}`])} aria-hidden="true" />}
      </div>
    </section>
  );
}

/** Tab tooltip of a library class: where it comes from, then its URI. */
function virtualTooltip(input: EditorInput): string | null {
  if (input.kind !== "virtual") return null;
  const d = virtualData(input);
  return [d?.description, input.path].filter(Boolean).join("\n");
}

function PaneContent({ paneId, tab, tabsVisible }: { paneId: string; tab: Tab; tabsVisible: boolean }) {
  const kinds = useContributions((s) => s.editorKinds);
  const crumbs = !useDistractionFree((s) => s.active);
  const wrappers = useTextEditorWrappers((s) => s.wrappers);
  if (isTextInput(tab.input)) {
    const virtual = tab.input.kind === "virtual" ? virtualData(tab.input) : undefined;
    const wrapper = tab.input.kind === "file" ? textEditorWrapperFor(wrappers, tab.input.path) : undefined;
    const host = <TextEditorHost key={tab.id} tabId={tab.id} />;
    return (
      <>
        {virtual ? (
          <VirtualBanner decompiled={virtual.decompiled} description={virtual.description} />
        ) : (
          <EditorBanners path={tab.input.path} />
        )}
        <FindBar paneId={paneId} />
        {crumbs && <CodeBreadcrumbs path={tab.input.path!} tabId={tab.id} position="top" />}
        {wrapper ? (
          <wrapper.component
            key={tab.id}
            path={tab.input.path}
            tabId={tab.id}
            actionsInTabs={tabsVisible && !!wrapper.tabActions}
          >
            {host}
          </wrapper.component>
        ) : (
          host
        )}
        {crumbs && <CodeBreadcrumbs path={tab.input.path!} tabId={tab.id} position="bottom" />}
      </>
    );
  }
  const kind = kinds.get(tab.input.kind);
  if (!kind) return <EmptyState icon="file" title={tx`No editor for “${tab.input.kind}”`} />;
  const Component = kind.component;
  return (
    <div className={styles.kind} data-editor-focus="" tabIndex={-1} key={tab.id}>
      <Component input={tab.input} />
    </div>
  );
}

/** Actions at the right end of the tab row (IDEA: split, tab actions ⋮). */
function EditorTabActions({ paneId, tab }: { paneId: string; tab: Tab }) {
  const ctrl = editorController();
  const wrappers = useTextEditorWrappers((s) => s.wrappers);
  const LayoutActions =
    tab.input.kind === "file" && tab.input.path
      ? textEditorWrapperFor(wrappers, tab.input.path)?.tabActions
      : undefined;
  const [open, setOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  return (
    <div className={styles.tabActions}>
      {LayoutActions && <LayoutActions path={tab.input.path!} tabId={tab.id} />}
      <IconButton
        icon="split"
        title="Split Right"
        size="small"
        onClick={() => {
          ctrl.activate(paneId, tab.id, false);
          ctrl.split(paneId, "row");
        }}
      />
      <IconButton
        ref={moreRef}
        icon="more"
        title="Tab Actions"
        size="small"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      />
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        anchor={moreRef}
        placement="bottom-end"
        aria-label="Tab actions"
        items={ctrl.tabMenu(paneId, tab)}
      />
    </div>
  );
}
