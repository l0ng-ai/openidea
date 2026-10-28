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
import { usePlatform } from "@/platform/platformInfo";
import { projectInitials } from "./projectColor";
import { keymapItems, themeItems, VIEW_MODE_ITEMS } from "./quickSwitch";
import { currentThemeId, useThemeOverride } from "./theme";
import styles from "./TitleBar.module.css";

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
  const name = useProject((s) => s.project?.name);
  const root = useProject((s) => s.project?.root);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const actions = useActions((s) => s.actions);
  const Popup = useWorkbenchSlots((s) => s.projectPopup);
  const items = useMemo<MenuItem[]>(() => {
    const list: MenuItem[] = [{ kind: "action", action: "file.openProject", label: "Open…" }];
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

/** IDEA's main toolbar gear: Run Anything, Settings, Plugins, quick switches, toolbar customization, updates. */
export function gearMenuItems(
  themeId: string,
  keymapId: string,
  customKeymaps: string[],
  customize: MenuItem[] = [{ kind: "action", action: "toolbar.customize", label: "Customize Toolbar…" }],
): MenuItem[] {
  return [
    { kind: "action", action: "runAnything.show" },
    { kind: "separator" },
    { kind: "action", action: "file.settings" },
    { kind: "action", action: "plugins.settings" },
    { kind: "separator" },
    {
      id: "gear.theme",
      label: "Theme",
      submenu: [...themeItems(themeId), { kind: "separator" }, { kind: "action", action: "settings.appearance" }],
    },
    {
      id: "gear.keymap",
      label: "Keymap",
      submenu: [
        ...keymapItems(keymapId, customKeymaps),
        { kind: "separator" },
        { kind: "action", action: "settings.keymap", label: "Configure Keymap…" },
      ],
    },
    { id: "gear.viewMode", label: "View Mode", submenu: VIEW_MODE_ITEMS },
    { kind: "separator" },
    { id: "gear.customizeToolbar", label: "Customize Main Toolbar", submenu: customize },
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
  const items = gearMenuItems(
    currentThemeId(),
    typeof settings?.keymap === "string" ? settings.keymap : preset,
    customs && typeof customs === "object" ? Object.keys(customs) : [],
    customize,
  );
  return (
    <>
      <IconButton
        ref={ref}
        icon="settings"
        title="IDE and Project Settings"
        iconSize={18}
        className={styles.tool}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      />
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        anchor={ref}
        items={items}
        aria-label="IDE and Project Settings"
      />
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
        iconSize={18}
        className={styles.tool}
      />
    </div>
  );
}

/**
 * 40px main toolbar. macOS: native traffic lights overlay its left edge.
 * Windows: the window is frameless, so the bar carries IDEA's main menu (☰) and
 * the caption buttons. `dialog`: a dialog window's bar (Settings), close button only.
 * `lightEdit`: a LightEdit window's bar, its title and the menu but no toolbar widgets.
 */
export function TitleBar({
  minimal = false,
  bare = false,
  dialog = false,
  lightEdit = false,
  title,
}: {
  minimal?: boolean;
  bare?: boolean;
  dialog?: boolean;
  lightEdit?: boolean;
  title?: string;
}) {
  const overlay = usePlatform((s) => s.overlayTitleBar);
  const frameless = usePlatform((s) => s.framelessTitleBar);
  const { map, shown, menu } = useToolbar();
  const [menuExpanded, setMenuExpanded] = useState(false);
  const className = clsx(styles.bar, overlay && styles.overlay, frameless && styles.frameless);
  // Distraction Free Mode: the window frame only. Where the title bar carries the
  // main menu (Windows) it stays, or nothing would lead back out of the mode.
  if (bare)
    return (
      <header className={className} data-tauri-drag-region data-titlebar="bare">
        {frameless && (
          <>
            <MainMenu />
            <div className={styles.drag} data-tauri-drag-region />
            <WindowControls />
          </>
        )}
      </header>
    );
  const entry = (id: string) => <ToolbarEntry key={id} id={id} items={map} />;
  const toolbar = !minimal && !lightEdit;
  return (
    <header
      className={clsx(className, minimal && styles.minimal, dialog && styles.dialogBar)}
      data-tauri-drag-region
      onContextMenu={(e) => {
        if (!toolbar || e.defaultPrevented) return;
        e.preventDefault();
        showContextMenu(e, menu);
      }}
    >
      {frameless && !minimal && <MainMenu onExpandedChange={setMenuExpanded} />}
      {title && (
        <span className={styles.windowTitle} data-tauri-drag-region>
          {typeof title === "string" ? <T>{title}</T> : title}
        </span>
      )}
      {toolbar && !menuExpanded && shown.left.map(entry)}
      <div className={styles.drag} data-tauri-drag-region />
      {!minimal && (
        <>
          {toolbar && shown.right.map(entry)}
          <div className={styles.tools}>
            <GearButton customize={menu} />
          </div>
        </>
      )}
      {frameless && <WindowControls dialog={dialog} />}
    </header>
  );
}
