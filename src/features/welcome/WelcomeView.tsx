/**
 * IntelliJ IDEA Home-style welcome view: left tool window stripe + collapsible
 * "Projects and Files" island, main workspace canvas with quick file/terminal
 * actions and bottom Plugins/Theme/Keymap pickers, and right Notifications stripe.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import clsx from "clsx";
import { executeAction, useActions } from "@/platform/actions";
import { useTx } from "@/platform/i18n";
import { call, commands, isTauri } from "@/platform/ipc";
import { PRESET_TITLES, useKeymap } from "@/platform/keymap";
import { useProject } from "@/platform/project";
import { useRemoteProgress } from "@/platform/remote";
import { useContributedThemes } from "@/platform/themes";
import { stageLabel, useConnectDialog } from "@/features/remote-dev/model";
import { Button, Icon, IconButton, Menu, ProgressBar, Spinner, type MenuItem, T } from "@/ui";
import { notifications, useSettingsPages } from "@/workbench/contributions";
import { ErrorBoundary, Slot } from "@/workbench/ErrorBoundary";
import { markAllNotificationsRead } from "@/workbench/notificationStore";
import { NotificationsToolWindow, useUnreadNotifications } from "@/workbench/Notifications";
import { keymapItems, keymapState, themeItems, themePreview } from "@/workbench/quickSwitch";
import { currentTheme, currentThemeChoice, useThemeChoices, useThemeOverride } from "@/workbench/theme";
import { ProjectsPage } from "./ProjectsPage";
import { askNewGroup } from "./RecentList";
import { loadRecent, useRecent } from "./recent";
import { cancelReopen, useSession } from "./session";
import styles from "./Welcome.module.css";

/** Settings page id contributed by the plugins feature. */
const PLUGINS_PAGE = "plugins";
const DEFAULT_PANEL_WIDTH = 320;
const MIN_PANEL_WIDTH = 220;
const MAX_PANEL_WIDTH = 520;

const clampPanelWidth = (w: number) => Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, w));

async function toggleSyncWithOs(on: boolean) {
  if (!isTauri()) return;
  try {
    let settings = await call(commands.settingsSet("global", "appearance.syncWithOs", JSON.stringify(on)));
    if (!on && settings.appearance?.theme === "system") {
      settings = await call(commands.settingsSet("global", "appearance.theme", JSON.stringify("light")));
    }
    useProject.setState({ settings });
  } catch (e) {
    notifications().notify({
      level: "error",
      title: "Cannot save setting",
      body: e instanceof Error ? e.message : String(e),
      key: "welcome.setting:appearance.syncWithOs",
    });
  }
}

/**
 * Paths dropped from the OS (Tauri drag-drop events carry real paths): a folder opens
 * as a project, files open in LightEdit.
 */
function useFolderDrop(): boolean {
  const [over, setOver] = useState(false);
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) =>
      getCurrentWebview()
        .onDragDropEvent((event) => {
          const p = event.payload;
          if (p.type === "enter" || p.type === "over") return setOver(true);
          setOver(false);
          const { project, lightEdit } = useProject.getState();
          if (p.type === "drop" && p.paths.length && !project && !lightEdit)
            void executeAction("file.openPaths", p.paths);
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
  return over;
}

/** A project opening at startup or in a new window; a remote one shows how far connecting is. */
function Reopening({ location }: { location: string }) {
  const tx = useTx();
  const progress = useRemoteProgress((s) => s.progress);
  const name = location.slice(location.lastIndexOf("/") + 1);
  const percent = progress?.fraction == null ? "" : ` ${Math.round(progress.fraction * 100)}%`;
  return (
    <div className={styles.reopening} role="status">
      <div className={styles.reopeningTitle}>
        <Spinner size={16} />
        <span>{tx`Opening ${name}…`}</span>
      </div>
      {progress && (
        <div className={styles.reopeningStage}>
          <span>{tx(stageLabel(progress.stage)) + percent}</span>
          <ProgressBar value={progress.fraction} aria-label={tx(stageLabel(progress.stage))} />
        </div>
      )}
      <Button size="small" onClick={cancelReopen}>
        <T>Cancel</T>
      </Button>
    </div>
  );
}

function ThemeFooterButton() {
  const tx = useTx();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const appearance = useProject((s) => s.settings?.appearance);
  useThemeOverride((s) => s.theme);
  useContributedThemes((s) => s.themes);
  const themes = useThemeChoices();
  const themeId = currentThemeChoice();
  const isDark = currentTheme() === "dark";
  const syncWithOs = appearance?.syncWithOs === true || appearance?.theme === "system";
  const chosen = themes.find((c) => c.id === themeId);
  const themeLabel = chosen ? (chosen.origin ? chosen.label : tx(chosen.label)) : tx("Islands Light");
  const preview = useMemo(() => (open ? themePreview() : undefined), [open]);

  const items = useMemo<MenuItem[]>(
    () => [
      ...themeItems(themeId, preview),
      { kind: "separator" },
      {
        id: "theme.syncWithOs",
        label: "Sync with OS",
        checked: syncWithOs,
        onActive: () => preview?.restore(),
        run: () => void toggleSyncWithOs(!syncWithOs),
      },
      { kind: "separator" },
      { kind: "action", action: "settings.appearance" },
    ],
    [themeId, preview, syncWithOs],
  );

  const close = () => {
    setOpen(false);
    queueMicrotask(() => preview?.end());
  };

  return (
    <>
      <button
        ref={ref}
        type="button"
        className={styles.footerButton}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <Icon name={isDark ? "moon" : "sun"} size={14} />
        <span>{tx`Theme: ${themeLabel}`}</span>
        <Icon name="chevron-down" size={12} className={styles.footerChevron} />
      </button>
      <Menu open={open} onClose={close} anchor={ref} items={items} placement="top" aria-label="Theme" />
    </>
  );
}

function KeymapFooterButton() {
  const tx = useTx();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const settings = useProject((s) => s.settings);
  useKeymap((s) => s.preset);
  const { keymapId, customs } = keymapState();
  const customMap = settings?.customKeymaps as Record<string, { name?: string }> | undefined;
  const presetLabel = PRESET_TITLES[keymapId];
  const keymapLabel = presetLabel ? tx(presetLabel) : customMap?.[keymapId]?.name || keymapId;

  const items = useMemo<MenuItem[]>(
    () => [
      ...keymapItems(keymapId, customs),
      { kind: "separator" },
      { kind: "action", action: "settings.keymap", label: "Configure Keymap…" },
    ],
    [keymapId, customs],
  );

  return (
    <>
      <button
        ref={ref}
        type="button"
        className={styles.footerButton}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="keyboard" size={14} />
        <span>{tx`Keymap: ${keymapLabel}`}</span>
        <Icon name="chevron-down" size={12} className={styles.footerChevron} />
      </button>
      <Menu open={open} onClose={() => setOpen(false)} anchor={ref} items={items} placement="top" aria-label="Keymap" />
    </>
  );
}

export function WelcomeView() {
  const tx = useTx();
  const actions = useActions((s) => s.actions);
  const reopening = useSession((s) => s.reopening);
  // A remote project connecting with no dialog or list row to show it (a new window's).
  const connecting = useRemoteProgress((s) => s.location);
  const connectDialog = useConnectDialog((s) => s.open);
  const listOpening = useRecent((s) => s.opening);
  const opening = useProject((s) => s.opening);
  const Plugins = useSettingsPages((s) => s.pages.get(PLUGINS_PAGE)?.component);
  const unread = useUnreadNotifications();

  const [projectsOpen, setProjectsOpen] = useState(true);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [inlinePlugins, setInlinePlugins] = useState(false);
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH);
  const [stripeMoreOpen, setStripeMoreOpen] = useState(false);
  const [panelTitleOpen, setPanelTitleOpen] = useState(false);
  const [panelMoreOpen, setPanelMoreOpen] = useState(false);

  const stripeMoreRef = useRef<HTMLButtonElement>(null);
  const panelTitleRef = useRef<HTMLButtonElement>(null);
  const panelMoreRef = useRef<HTMLButtonElement>(null);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const dropping = useFolderDrop();

  useEffect(() => {
    void loadRecent();
  }, []);

  useEffect(() => {
    if (notificationsOpen && unread > 0) markAllNotificationsRead();
  }, [notificationsOpen, unread]);

  const shownInlinePlugins = inlinePlugins && !!Plugins;

  const panelMenuItems = useMemo<MenuItem[]>(
    () => [
      { id: "newGroup", label: "New Project Group…", icon: "folder", run: () => void askNewGroup() },
      { kind: "separator" },
      { kind: "action", action: "file.newUntitled", label: "New File" },
      { kind: "action", action: "file.newMarkdownFile", label: "New Markdown File" },
      { kind: "action", action: "file.openFile", label: "Open File" },
      { kind: "separator" },
      { kind: "action", action: "remote.connect", label: "Remote Development…" },
      { kind: "action", action: "file.settings", label: "Settings…" },
    ],
    [],
  );

  const stripeMoreItems = useMemo<MenuItem[]>(
    () => [
      { kind: "action", action: "file.newProject", label: "New Project…" },
      { kind: "action", action: "file.openProject", label: "Open…" },
      { kind: "action", action: "vcs.clone", label: "Clone Repository…" },
      { kind: "action", action: "remote.connect", label: "Remote Development…" },
      { kind: "separator" },
      { id: "newGroup", label: "New Project Group…", icon: "folder", run: () => void askNewGroup() },
      { kind: "action", action: "file.settings", label: "Settings…" },
    ],
    [],
  );

  const hasPluginsEntry = !!Plugins || actions.has("plugins.settings") || actions.has("file.settings");

  const openPlugins = () => {
    if (actions.has("plugins.settings")) void executeAction("plugins.settings");
    else if (actions.has("file.settings")) void executeAction("file.settings", PLUGINS_PAGE);
    else if (Plugins) setInlinePlugins(true);
  };

  const onSplitterDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startWidth: panelWidth };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onSplitterMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    setPanelWidth(clampPanelWidth(dragRef.current.startWidth + (e.clientX - dragRef.current.startX)));
  };

  const onSplitterEnd = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  const onSplitterKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      setPanelWidth((w) => clampPanelWidth(w - 16));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      setPanelWidth((w) => clampPanelWidth(w + 16));
    }
  };

  if (reopening) return <Reopening location={reopening} />;
  if (connecting && !connectDialog && !listOpening) return <Reopening location={connecting} />;

  return (
    <div className={styles.welcome} data-projects-open={projectsOpen ? "true" : "false"}>
      <aside className={clsx(styles.stripe, styles.stripeLeft)} aria-label={tx("Left tool window stripe")}>
        <button
          type="button"
          className={clsx(styles.stripeButton, projectsOpen && styles.stripeActive)}
          aria-label={tx("Projects and Files")}
          aria-pressed={projectsOpen}
          title={tx("Projects and Files")}
          onClick={() => setProjectsOpen((v) => !v)}
        >
          <Icon name="toolwindow-project" size={20} />
        </button>
        <button
          ref={stripeMoreRef}
          type="button"
          className={styles.stripeButton}
          aria-label={tx("More Actions")}
          aria-haspopup="menu"
          aria-expanded={stripeMoreOpen}
          title={tx("More Actions")}
          onClick={() => setStripeMoreOpen((v) => !v)}
        >
          <Icon name="more-horizontal" size={20} />
        </button>
        <Menu
          open={stripeMoreOpen}
          onClose={() => setStripeMoreOpen(false)}
          anchor={stripeMoreRef}
          items={stripeMoreItems}
          placement="right-start"
          aria-label="More Actions"
        />
      </aside>

      {projectsOpen && (
        <>
          <section
            className={styles.panel}
            style={{ width: `${panelWidth}px` }}
            aria-label={tx("Projects and Files")}
            aria-busy={opening || undefined}
          >
            <header className={styles.panelHeader}>
              <button
                ref={panelTitleRef}
                type="button"
                className={styles.panelTitleButton}
                aria-haspopup="menu"
                aria-expanded={panelTitleOpen}
                onClick={() => setPanelTitleOpen((v) => !v)}
              >
                <span className={styles.panelTitle}>
                  <T>Projects and Files</T>
                </span>
                <Icon name="chevron-down" size={12} className={styles.panelTitleChevron} />
              </button>
              <Menu
                open={panelTitleOpen}
                onClose={() => setPanelTitleOpen(false)}
                anchor={panelTitleRef}
                items={panelMenuItems}
                placement="bottom-start"
                aria-label="Projects and Files"
              />
              <div className={styles.panelHeaderActions}>
                <IconButton
                  ref={panelMoreRef}
                  icon="more"
                  size="small"
                  title="More Actions"
                  aria-haspopup="menu"
                  aria-expanded={panelMoreOpen}
                  onClick={() => setPanelMoreOpen((v) => !v)}
                />
                <Menu
                  open={panelMoreOpen}
                  onClose={() => setPanelMoreOpen(false)}
                  anchor={panelMoreRef}
                  items={panelMenuItems}
                  placement="bottom-end"
                  aria-label="More Actions"
                />
                <IconButton icon="hide" size="small" title="Hide" onClick={() => setProjectsOpen(false)} />
              </div>
            </header>
            <ProjectsPage />
          </section>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={tx("Resize Projects and Files")}
            aria-valuemin={MIN_PANEL_WIDTH}
            aria-valuemax={MAX_PANEL_WIDTH}
            aria-valuenow={panelWidth}
            tabIndex={0}
            className={styles.splitter}
            onPointerDown={onSplitterDown}
            onPointerMove={onSplitterMove}
            onPointerUp={onSplitterEnd}
            onPointerCancel={onSplitterEnd}
            onKeyDown={onSplitterKeyDown}
          />
        </>
      )}

      <section
        className={clsx(styles.workspace, shownInlinePlugins && styles.workspacePlugins)}
        aria-label={shownInlinePlugins ? tx("Plugins") : tx("Workspace")}
      >
        {shownInlinePlugins ? (
          <>
            <div className={styles.pluginsHeader}>
              <span className={styles.panelTitle}>
                <T>Plugins</T>
              </span>
              <IconButton icon="close" size="small" title="Close" onClick={() => setInlinePlugins(false)} />
            </div>
            <ErrorBoundary name="welcome plugins page">
              <Slot component={Plugins} />
            </ErrorBoundary>
          </>
        ) : (
          <>
            <div className={styles.workspaceCenter}>
              <div className={styles.quickActions}>
                <button
                  type="button"
                  className={styles.quickAction}
                  disabled={opening}
                  onClick={() =>
                    void executeAction(
                      actions.has("file.newMarkdownFile") ? "file.newMarkdownFile" : "file.newUntitled",
                    )
                  }
                >
                  <Icon name="file-md" size={16} />
                  <span>
                    <T>New Markdown File</T>
                  </span>
                </button>
                <button
                  type="button"
                  className={styles.quickAction}
                  disabled={opening}
                  onClick={() => void executeAction("file.openFile")}
                >
                  <Icon name="folder-open" size={16} />
                  <span>
                    <T>Open File</T>
                  </span>
                </button>
                <button
                  type="button"
                  className={styles.quickAction}
                  disabled={opening}
                  onClick={() => void executeAction("terminal.openStandalone")}
                >
                  <Icon name="terminal" size={16} />
                  <span>
                    <T>Open Terminal</T>
                  </span>
                </button>
              </div>
            </div>
            <footer className={styles.workspaceFooter}>
              {hasPluginsEntry && (
                <button type="button" className={styles.footerButton} onClick={openPlugins}>
                  <Icon name="plugin" size={14} />
                  <span>
                    <T>Plugins</T>
                  </span>
                </button>
              )}
              <ThemeFooterButton />
              <KeymapFooterButton />
            </footer>
          </>
        )}
        {dropping && (
          <div className={styles.dropOverlay} aria-hidden>
            <Icon name="folder-open" size={20} />
            <T>Drop a folder to open it as a project, or files to edit them</T>
          </div>
        )}
      </section>

      {notificationsOpen && (
        <>
          <div className={styles.panelGap} aria-hidden />
          <section className={styles.notificationsPanel} aria-label={tx("Notifications")}>
            <header className={styles.panelHeader}>
              <span className={styles.panelTitle}>
                <T>Notifications</T>
              </span>
              <div className={styles.panelHeaderActions}>
                <IconButton icon="hide" size="small" title="Hide" onClick={() => setNotificationsOpen(false)} />
              </div>
            </header>
            <NotificationsToolWindow />
          </section>
        </>
      )}

      <aside className={clsx(styles.stripe, styles.stripeRight)} aria-label={tx("Right tool window stripe")}>
        <button
          type="button"
          className={clsx(styles.stripeButton, notificationsOpen && styles.stripeActive)}
          aria-label={tx("Notifications")}
          aria-pressed={notificationsOpen}
          title={tx("Notifications")}
          onClick={() => setNotificationsOpen((v) => !v)}
        >
          <span className={styles.stripeIcon}>
            <Icon name="toolwindow-notifications" size={20} />
            {unread > 0 && <span className={styles.badge}>{unread}</span>}
          </span>
        </button>
      </aside>
    </div>
  );
}
