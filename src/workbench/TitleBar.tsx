import { ContributedToolbar } from "./ContributedToolbar";
import { useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { useActions } from "@/platform/actions";
import { shortcutLabel, useKeymap } from "@/platform/keymap";
import { useProject } from "@/platform/project";
import { BarButton, Icon, IconButton, Menu, type MenuItem, showContextMenu, T } from "@/ui";
import { useContributions, useWorkbenchSlots, type TitleItemContribution } from "./contributions";
import { ErrorBoundary, Slot } from "./ErrorBoundary";
import { MainMenu } from "./MainMenu";
import {
  editableToolbar,
  entryAction,
  isActionEntry,
  PROJECT_WIDGET,
  resolveToolbar,
  saveToolbar,
  SEARCH_ENTRY,
  toggleWidget,
  useMainToolbarSettings,
  VCS_WIDGET,
  widgetTitle,
} from "./mainToolbar";
import { WindowControls } from "./WindowControls";
import { useFullscreen } from "./useFullscreen";
import { usePlatform } from "@/platform/platformInfo";
import { projectInitials } from "./projectColor";
import { keymapItems, themeItems, themePreview, type ThemePreview, VIEW_MODE_ITEMS } from "./quickSwitch";
import { useContributedThemes } from "@/platform/themes";
import { currentThemeChoice, useThemeOverride } from "./theme";
import styles from "./TitleBar.module.css";
import { useNativeTitlebar } from "./nativeTitlebar";
import { useDocumentTitle } from "./documentTitle";
import { windowDragRegion } from "./window-drag";

export function orderTitleItems(items: Iterable<TitleItemContribution>) {
  const all = [...items];
  return {
    left: all.filter((i) => i.align === "left").sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id)),
    right: all.filter((i) => i.align === "right").sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id)),
  };
}

function TitleItem({ item }: { item: TitleItemContribution }) {
  const C = item.component;
  return (
    <div className={styles.item} data-title-item={item.id}>
      <ErrorBoundary name={`title item ${item.id}`}>
        <C />
      </ErrorBoundary>
    </div>
  );
}

function ProjectButton() {
  const name = useProject((s) => s.project?.displayName || s.project?.name);
  const root = useProject((s) => s.project?.root);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const actions = useActions((s) => s.actions);
  const Popup = useWorkbenchSlots((s) => s.projectPopup);
  const items = useMemo<MenuItem[]>(() => {
    const list: MenuItem[] = [];
    if (actions.has("file.newProject")) list.push({ kind: "action", action: "file.newProject", label: "New Project…" });
    list.push({ kind: "action", action: "file.openProject", label: "Open…" });
    if (actions.has("welcome.recentProjects")) list.push({ kind: "action", action: "welcome.recentProjects" });
    list.push({ kind: "separator" }, { kind: "action", action: "file.closeProject" });
    return list;
  }, [actions]);
  const label = name ?? "OpenIDEA";
  return (
    <>
      <BarButton
        ref={ref}
        variant="title"
        className={styles.widget}
        tooltip={root}
        aria-label={label}
        aria-haspopup={Popup ? "dialog" : "menu"}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={styles.avatar} aria-hidden="true">
          {projectInitials(label)}
        </span>
        <span className={styles.widgetText}>{label}</span>
        <Icon name="chevron-down" size={12} className={styles.chevron} />
      </BarButton>
      {Popup ? (
        open && <Slot component={Popup} anchor={ref} onClose={() => setOpen(false)} />
      ) : (
        <Menu open={open} onClose={() => setOpen(false)} anchor={ref} items={items} aria-label="Project" />
      )}
    </>
  );
}

const VCS_FALLBACK_ACTIONS = ["vcs.clone", "vcs.localHistory", "vcs.showLog"];

/** "Version Control ▾" shown while no VCS widget is contributed (project without a repository). */
function VcsFallback() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const actions = useActions((s) => s.actions);
  const items = useMemo<MenuItem[]>(
    () => VCS_FALLBACK_ACTIONS.filter((id) => actions.has(id)).map((action) => ({ kind: "action", action })),
    [actions],
  );
  if (!items.length) return null;
  return (
    <>
      <BarButton
        ref={ref}
        variant="title"
        className={styles.widget}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={styles.widgetText}>
          <T>Version Control</T>
        </span>
        <Icon name="chevron-down" size={12} className={styles.chevron} />
      </BarButton>
      <Menu open={open} onClose={() => setOpen(false)} anchor={ref} items={items} aria-label="Version Control" />
    </>
  );
}

/**
 * Customize Main Toolbar ›: a checkbox per widget (and added action), then the
 * dialog and Restore Default. Also the title bar's context menu.
 */
export function customizeToolbarItems(
  shown: { left: string[]; right: string[] },
  hidden: readonly string[],
  items: ReadonlyMap<string, TitleItemContribution>,
  toggle: (id: string) => void,
  reset: () => void,
): MenuItem[] {
  const entries = [...shown.left, ...shown.right, ...hidden.filter((id) => !isActionEntry(id))];
  return [
    ...entries.map<MenuItem>((id) => ({
      id: `toolbar.${id}`,
      label: widgetTitle(id, items),
      checked: !hidden.includes(id),
      run: () => toggle(id),
    })),
    { kind: "separator" },
    { kind: "action", action: "toolbar.customize", label: "Customize Toolbar…" },
    { id: "toolbar.reset", label: "Restore Default Toolbar", run: reset },
  ];
}

/**
 * IDEA's main toolbar gear: Run Anything, Settings, Plugins, quick switches, toolbar customization, updates.
 * With `preview`, a theme under the pointer shows as in Quick Switch.
 */
export function gearMenuItems(
  themeId: string,
  keymapId: string,
  customKeymaps: string[],
  customize: MenuItem[] = [{ kind: "action", action: "toolbar.customize", label: "Customize Toolbar…" }],
  preview?: ThemePreview,
): MenuItem[] {
  const restore = preview && (() => preview.restore());
  return [
    { kind: "action", action: "runAnything.show" },
    { kind: "separator" },
    { kind: "action", action: "file.settings" },
    { kind: "action", action: "plugins.settings" },
    { kind: "separator" },
    {
      id: "gear.theme",
      label: "Theme",
      submenu: [
        ...themeItems(themeId, preview),
        { kind: "separator" },
        { kind: "action", action: "settings.appearance" },
      ],
    },
    {
      id: "gear.keymap",
      label: "Keymap",
      onActive: restore,
      submenu: [
        ...keymapItems(keymapId, customKeymaps),
        { kind: "separator" },
        { kind: "action", action: "settings.keymap", label: "Configure Keymap…" },
      ],
    },
    { id: "gear.viewMode", label: "View Mode", onActive: restore, submenu: VIEW_MODE_ITEMS },
    { kind: "separator" },
    { id: "gear.customizeToolbar", label: "Customize Main Toolbar", onActive: restore, submenu: customize },
    { kind: "separator" },
    { kind: "action", action: "app.checkForUpdates" },
  ];
}

/** Toolbar entries and the customization menu, from the saved layout. */
function useToolbar() {
  const map = useContributions((s) => s.titleItems);
  const saved = useMainToolbarSettings();
  const shown = useMemo(() => resolveToolbar(saved, map.values()), [saved, map]);
  const toggle = (id: string) => {
    const layout = editableToolbar(saved, map.values());
    const side = map.get(id)?.align ?? (id === SEARCH_ENTRY ? "right" : "left");
    void saveToolbar(toggleWidget(layout, id, side));
  };
  const menu = customizeToolbarItems(shown, saved?.hidden ?? [], map, toggle, () => void saveToolbar(null));
  return { map, shown, menu };
}

function GearButton({ customize }: { customize: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const settings = useProject((s) => s.settings);
  useThemeOverride((s) => s.theme);
  useActions((s) => s.actions);
  const preset = useKeymap((s) => s.preset);
  const customs = settings?.customKeymaps;
  useContributedThemes((s) => s.themes);
  // One preview per opening: a theme shown from it goes away with the menu unless chosen.
  const preview = useMemo(() => (open ? themePreview() : undefined), [open]);
  const items = gearMenuItems(
    currentThemeChoice(),
    typeof settings?.keymap === "string" ? settings.keymap : preset,
    customs && typeof customs === "object" ? Object.keys(customs) : [],
    customize,
    preview,
  );
  const close = () => {
    setOpen(false);
    // A chosen theme runs right after the menu closes: let it choose first.
    queueMicrotask(() => preview?.end());
  };
  return (
    <>
      <IconButton
        ref={ref}
        icon="settings"
        title="IDE and Project Settings"
        iconSize={20}
        className={styles.tool}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      />
      <Menu open={open} onClose={close} anchor={ref} items={items} aria-label="IDE and Project Settings" />
    </>
  );
}

/** One main toolbar entry: a built-in widget, a contributed one or an added action. */
function ToolbarEntry({ id, items }: { id: string; items: ReadonlyMap<string, TitleItemContribution> }) {
  const actions = useActions((s) => s.actions);
  if (id === PROJECT_WIDGET) return <ProjectButton />;
  const item = items.get(id);
  if (item) return <TitleItem item={item} />;
  if (id === VCS_WIDGET) return <VcsFallback />;
  if (!isActionEntry(id)) return null;
  const action = actions.get(entryAction(id));
  if (!action) return null;
  return (
    <div className={styles.tools}>
      <IconButton
        icon={action.icon ?? "run"}
        action={action.id}
        title={action.title}
        shortcut={shortcutLabel(action.id) ?? (action.id === "navigate.searchEverywhere" ? "⇧⇧" : undefined)}
        iconSize={20}
        className={styles.tool}
      />
    </div>
  );
}

/** IDEA's compact header: the window title in the middle of a 30px bar. */
function CompactTitle({ title }: { title?: string }) {
  const documentTitle = useDocumentTitle();
  return (
    <span className={styles.compactTitle} {...windowDragRegion}>
      {title ?? documentTitle}
    </span>
  );
}

/**
 * 40px main toolbar. macOS: native traffic lights overlay its left edge.
 * Windows and Linux: the window is frameless, so the bar carries IDEA's main menu (☰) and
 * the caption buttons. `dialog`: a dialog window's bar (Settings), close button only.
 * `lightEdit`: a LightEdit window's bar, its title and the menu but no toolbar widgets.
 * `compact`: IDEA's compact header (Distraction Free, View › Appearance › Toolbar off).
 * `bare`: the window frame only, while a project opens.
 */
export function TitleBar({
  minimal = false,
  bare = false,
  compact = false,
  dialog = false,
  lightEdit = false,
  title,
}: {
  minimal?: boolean;
  bare?: boolean;
  compact?: boolean;
  dialog?: boolean;
  lightEdit?: boolean;
  title?: string;
}) {
  const overlay = usePlatform((s) => s.overlayTitleBar);
  const fullscreen = useFullscreen();
  const frameless = usePlatform((s) => s.framelessTitleBar);
  const { map, shown, menu } = useToolbar();
  const [menuExpanded, setMenuExpanded] = useState(false);
  const separateMenu = useProject((s) => s.settings?.appearance?.mainMenuStyle === "toolbar");
  const [bar, setBar] = useState<HTMLElement | null>(null);
  useNativeTitlebar(bar);
  const className = clsx(
    styles.bar,
    overlay && styles.overlay,
    overlay && fullscreen && styles.overlayFullscreen,
    frameless && styles.frameless,
  );
  // Where the title bar carries the main menu (Windows, Linux) it stays, or nothing
  // would lead back out of Distraction Free Mode or bring the toolbar back.
  if (bare || compact)
    return (
      <header
        ref={setBar}
        className={clsx(className, compact && styles.compactHeader)}
        {...windowDragRegion}
        data-titlebar={compact ? "compact" : "bare"}
      >
        {frameless && <MainMenu />}
        {compact ? <CompactTitle title={title} /> : frameless && <div className={styles.drag} {...windowDragRegion} />}
        {frameless && <WindowControls />}
      </header>
    );
  const entry = (id: string) => <ToolbarEntry key={id} id={id} items={map} />;
  const toolbar = !minimal && !lightEdit;
  const menuRow = frameless && !minimal && separateMenu;
  const header = (
    <header
      ref={setBar}
      className={clsx(className, minimal && styles.minimal, dialog && styles.dialogBar)}
      {...windowDragRegion}
      onContextMenu={(e) => {
        if (!toolbar || e.defaultPrevented) return;
        e.preventDefault();
        showContextMenu(e, menu);
      }}
    >
      {frameless && !minimal && !separateMenu && <MainMenu onExpandedChange={setMenuExpanded} />}
      {title && (
        <span className={styles.windowTitle} {...windowDragRegion}>
          {typeof title === "string" ? <T>{title}</T> : title}
        </span>
      )}
      {toolbar && !menuExpanded && shown.left.map(entry)}
      <div className={styles.drag} {...windowDragRegion} />
      {!minimal && (
        <>
          {toolbar && !menuExpanded && shown.right.map(entry)}
          {toolbar && !menuExpanded && <ContributedToolbar slot="mainToolbar" />}
          {!menuExpanded && (
            <div className={styles.tools}>
              <GearButton customize={menu} />
            </div>
          )}
        </>
      )}
      {frameless && <WindowControls dialog={dialog} />}
    </header>
  );
  if (!menuRow) return header;
  return (
    <>
      {header}
      <div className={styles.menuRow}>
        <MainMenu row />
      </div>
    </>
  );
}
