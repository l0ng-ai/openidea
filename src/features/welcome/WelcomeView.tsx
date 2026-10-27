/** IntelliJ-style welcome window: brand + navigation on the left, the selected page on the right. */
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { executeAction } from "@/platform/actions";
import { useT, useTx } from "@/platform/i18n";
import { isTauri } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { useRemoteProgress } from "@/platform/remote";
import { stageLabel } from "@/features/remote-dev/model";
import { Icon, IconButton, Menu, ProgressBar, Spinner, type MenuItem, T } from "@/ui";
import { useSettingsPages } from "@/workbench/contributions";
import { ErrorBoundary, Slot } from "@/workbench/ErrorBoundary";
import logo from "../../../src-tauri/icons/128x128.png";
import { CustomizePage } from "./CustomizePage";
import { ProjectsPage } from "./ProjectsPage";
import { loadRecent, useRecent } from "./recent";
import { useSession } from "./session";
import styles from "./Welcome.module.css";

export type WelcomePage = "projects" | "customize" | "plugins";

/** Settings page id contributed by the plugins feature (embedded as Welcome › Plugins). */
const PLUGINS_PAGE = "plugins";

export const GEAR_MENU: MenuItem[] = [
  { kind: "action", action: "file.settings" },
  { kind: "action", action: "settings.keymap" },
  { kind: "action", action: "plugins.installFromDisk" },
  { kind: "separator" },
  { kind: "action", action: "help.keymapReference" },
  { kind: "action", action: "help.showLog" },
  { kind: "action", action: "app.checkForUpdates" },
  { kind: "separator" },
  { kind: "action", action: "app.about" },
];

function GearButton() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <IconButton
        ref={ref}
        icon="settings"
        title="Manage"
        aria-haspopup="menu"
        aria-expanded={open}
        iconSize={16}
        className={styles.gear}
        onClick={() => setOpen((v) => !v)}
      />
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        anchor={ref}
        items={GEAR_MENU}
        placement="top-start"
        aria-label="Manage"
      />
    </>
  );
}

function NavItem({
  id,
  label,
  page,
  onSelect,
}: {
  id: WelcomePage;
  label: string;
  page: WelcomePage;
  onSelect: (p: WelcomePage) => void;
}) {
  return (
    <button
      type="button"
      className={styles.navItem}
      aria-current={page === id ? "page" : undefined}
      onClick={() => onSelect(id)}
    >
      {label}
    </button>
  );
}

/** Folders dropped from the OS open as a project (Tauri drag-drop events carry real paths). */
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
          if (p.type === "drop" && p.paths[0] && !useProject.getState().project)
            void executeAction("file.openProjectPath", p.paths[0]);
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

/** The last session's project opening at startup; a remote one shows how far connecting is. */
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
    </div>
  );
}

export function WelcomeView() {
  const t = useT();
  const version = useRecent((s) => s.version);
  const reopening = useSession((s) => s.reopening);
  const opening = useProject((s) => s.opening);
  const Plugins = useSettingsPages((s) => s.pages.get(PLUGINS_PAGE)?.component);
  const [page, setPage] = useState<WelcomePage>("projects");
  const dropping = useFolderDrop();
  const shown = page === "plugins" && !Plugins ? "projects" : page;

  useEffect(() => {
    void loadRecent();
  }, []);

  if (reopening) return <Reopening location={reopening} />;

  return (
    <div className={styles.welcome}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <img className={styles.logo} src={logo} alt="" draggable={false} />
          <span className={styles.brandText}>
            <span className={styles.appName}>
              <T>OpenIDEA</T>
            </span>
            {version && <span className={styles.version}>{version}</span>}
          </span>
        </div>
        <p className={styles.tagline}>{t("app.about.tagline")}</p>
        <nav className={styles.nav} aria-label="Welcome">
          <NavItem id="projects" label="Projects" page={shown} onSelect={setPage} />
          <NavItem id="customize" label="Customize" page={shown} onSelect={setPage} />
          {Plugins && <NavItem id="plugins" label="Plugins" page={shown} onSelect={setPage} />}
        </nav>
        <div className={styles.sidebarSpacer} />
        <div className={styles.sidebarFooter}>
          <GearButton />
        </div>
      </aside>
      <section
        className={clsx(styles.content, shown === "plugins" && styles.contentPlugins)}
        aria-label={shown === "projects" ? "Projects" : shown === "customize" ? "Customize" : "Plugins"}
        aria-busy={opening || undefined}
      >
        {shown === "projects" && <ProjectsPage />}
        {shown === "customize" && <CustomizePage />}
        {shown === "plugins" && Plugins && (
          <ErrorBoundary name="welcome plugins page">
            <Slot component={Plugins} />
          </ErrorBoundary>
        )}
        {dropping && (
          <div className={styles.dropOverlay} aria-hidden>
            <Icon name="folder-open" size={20} />
            <T>Drop a folder to open it as a project</T>
          </div>
        )}
      </section>
    </div>
  );
}
