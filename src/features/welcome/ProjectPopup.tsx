import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import clsx from "clsx";
import { executeAction, useActions } from "@/platform/actions";
import { call, commands, isTauri, type OpenProject, type RecentProject } from "@/platform/ipc";
import { HighlightedText, Icon, Popup, showContextMenu, type IconName, T } from "@/ui";
import type { ProjectPopupProps } from "@/workbench/contributions";
import { askRemoveRecent, ProjectBadge, recentMenu } from "./RecentList";
import { filterRecent, loadRecent, openRecent, useRecent, type RecentMatch } from "./recent";
import styles from "./ProjectPopup.module.css";
import { tx } from "@/platform/i18n";

type Entry =
  | { kind: "action"; id: string; label: string; icon: IconName }
  | { kind: "project"; open: boolean; m: RecentMatch };

const ACTIONS: { id: string; label: string; icon: IconName }[] = [
  { id: "file.openProject", label: "Open…", icon: "folder" },
  { id: "vcs.clone", label: "Clone Repository…", icon: "branch" },
  { id: "remote.connect", label: "Remote Development…", icon: "terminal" },
];

function useOpenProjects(): OpenProject[] {
  const [open, setOpen] = useState<OpenProject[]>([]);
  useEffect(() => {
    if (!isTauri()) return;
    let live = true;
    void call(commands.windowOpenProjects())
      .then((list) => live && setOpen(list))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return open;
}

/** The title bar project widget's popup, after IDEA's ProjectWidget: actions, open projects, recent projects; type to filter. */
export function ProjectPopup({ anchor, onClose }: ProjectPopupProps) {
  const actions = useActions((s) => s.actions);
  const recent = useRecent((s) => s.projects);
  const home = useRecent((s) => s.home);
  const openProjects = useOpenProjects();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => void loadRecent(), []);

  const entries = useMemo<Entry[]>(() => {
    const openPaths = new Set(openProjects.map((p) => p.root));
    const asRecent = (p: OpenProject): RecentProject =>
      recent.find((r) => r.path === p.root) ?? { path: p.root, name: p.name, openedAtMs: null, branch: null };
    const open = filterRecent(openProjects.map(asRecent), query, home).map((m) => ({
      kind: "project" as const,
      open: true,
      m,
    }));
    const rest = filterRecent(
      recent.filter((r) => !openPaths.has(r.path)),
      query,
      home,
    ).map((m) => ({ kind: "project" as const, open: false, m }));
    const acts = query ? [] : ACTIONS.filter((a) => actions.has(a.id)).map((a) => ({ kind: "action" as const, ...a }));
    return [...acts, ...open, ...rest];
  }, [actions, recent, home, openProjects, query]);
  const current = Math.min(active, entries.length - 1);

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const activate = (e: Entry | undefined) => {
    if (!e) return;
    onClose();
    if (e.kind === "action") void executeAction(e.id);
    else if (e.open) void call(commands.windowOpenProject(e.m.project.path, false, [])).catch(() => undefined);
    else void openRecent(e.m.project);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const n = entries.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (n) setActive((current + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setActive(e.key === "Home" ? 0 : n - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      activate(entries[current]);
    } else if (e.key === "Escape" && query) {
      e.preventDefault();
      e.stopPropagation();
      setQuery("");
      setActive(0);
    } else if (e.key === "Backspace" && query) {
      e.preventDefault();
      setQuery((q) => (e.metaKey ? "" : q.slice(0, -1)));
      setActive(0);
    } else if (e.key === "Delete" || (e.key === "Backspace" && e.metaKey)) {
      const entry = entries[current];
      if (entry?.kind === "project" && !entry.open) {
        e.preventDefault();
        void askRemoveRecent(entry.m.project);
      }
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && (query || e.key !== " ")) {
      e.preventDefault();
      const ch = e.key;
      setQuery((q) => q + ch);
      setActive(0);
    }
  };

  const firstOpen = entries.findIndex((e) => e.kind === "project" && e.open);
  const firstRecent = entries.findIndex((e) => e.kind === "project" && !e.open);

  return (
    <Popup open anchor={anchor} onClose={onClose} role="dialog" aria-label="Projects" className={styles.popup}>
      <div
        ref={listRef}
        tabIndex={-1}
        data-autofocus
        onKeyDown={onKeyDown}
        className={styles.inner}
        role="listbox"
        aria-label={tx("Projects")}
      >
        {query && (
          <div className={styles.search} aria-live="polite">
            <Icon name="search" size={14} />
            <span>{query}</span>
          </div>
        )}
        {entries.map((e, i) => (
          <div key={e.kind === "action" ? e.id : `${e.open}:${e.m.project.path}`} className={styles.group}>
            {i === firstOpen && (
              <Header first={i === 0}>
                <T>Open Projects</T>
              </Header>
            )}
            {i === firstRecent && (
              <Header first={i === 0}>
                <T>Recent Projects</T>
              </Header>
            )}
            <div
              role="option"
              aria-selected={i === current}
              data-index={i}
              className={clsx(styles.row, e.kind === "project" && styles.projectRow, i === current && styles.active)}
              onMouseMove={() => i !== current && setActive(i)}
              onClick={() => activate(e)}
              onContextMenu={(ev) => {
                if (e.kind !== "project" || e.open) return;
                ev.preventDefault();
                setActive(i);
                showContextMenu(ev, recentMenu(e.m.project, onClose));
              }}
            >
              {e.kind === "action" ? (
                <>
                  <Icon name={e.icon} size={16} className={styles.actionIcon} />
                  <span className={styles.label}>{e.label}</span>
                </>
              ) : (
                <ProjectRow m={e.m} active={i === current} />
              )}
            </div>
          </div>
        ))}
        {query && !entries.length && (
          <div className={styles.empty}>
            <T>No matching projects</T>
          </div>
        )}
      </div>
    </Popup>
  );
}

function Header({ first, children }: { first: boolean; children: ReactNode }) {
  return (
    <>
      {!first && <div className={styles.separator} role="separator" />}
      <div className={styles.header}>{children}</div>
    </>
  );
}

function ProjectRow({ m, active }: { m: RecentMatch; active: boolean }) {
  return (
    <>
      <ProjectBadge name={m.project.name} className={styles.badge} />
      <span className={styles.text}>
        <span className={styles.top}>
          <HighlightedText
            className={styles.name}
            text={m.project.name}
            indices={m.nameMatch}
            tone={active ? "accent" : "strong"}
          />
          {m.project.branch && (
            <span className={styles.branch}>
              <Icon name="branch" size={11} />
              {m.project.branch}
            </span>
          )}
        </span>
        <HighlightedText className={styles.path} text={m.displayPath} indices={m.pathMatch} />
      </span>
    </>
  );
}
