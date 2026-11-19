import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import clsx from "clsx";
import { executeAction, useActions } from "@/platform/actions";
import { call, commands, isTauri, type OpenProject, type RecentProject } from "@/platform/ipc";
import { HighlightedText, Icon, Popup, showContextMenu, type IconName, T } from "@/ui";
import type { ProjectPopupProps } from "@/workbench/contributions";
import { askRemoveRecent, ProjectBadge, recentMenu, unavailableTitle } from "./RecentList";
import { filterRecent, loadRecent, openRecent, recentRows, useRecent, type RecentMatch } from "./recent";
import styles from "./ProjectPopup.module.css";
import { tx } from "@/platform/i18n";
import { parseRemoteLocation, remoteLocation } from "@/platform/remote";

type Entry =
  | { kind: "action"; id: string; label: string; icon: IconName }
  | { kind: "project"; open: boolean; m: RecentMatch; group?: string | null };

const ACTIONS: { id: string; label: string; icon: IconName }[] = [
  { id: "file.newProject", label: "New Project…", icon: "plus" },
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

/**
 * The title bar project widget's popup, after IDEA's ProjectWidget: actions, open projects, recent
 * projects (under the Welcome screen's project groups, then the ungrouped ones); type to filter.
 */
export function ProjectPopup({ anchor, onClose }: ProjectPopupProps) {
  const actions = useActions((s) => s.actions);
  const recent = useRecent((s) => s.projects);
  const groups = useRecent((s) => s.groups);
  const home = useRecent((s) => s.home);
  const openProjects = useOpenProjects();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => void loadRecent(), []);

  const entries = useMemo<Entry[]>(() => {
    // A remote window's project is keyed like its recent entry (`wsl://…`, `ssh://…`).
    const location = (p: OpenProject) => (p.remote ? remoteLocation(p.remote, p.root) : p.root);
    const openPaths = new Set(openProjects.map(location));
    const asRecent = (p: OpenProject): RecentProject => {
      const path = location(p);
      return recent.find((r) => r.path === path) ?? { path, name: p.name, openedAtMs: null, branch: null };
    };
    const open = filterRecent(openProjects.map(asRecent), query, home).map((m) => ({
      kind: "project" as const,
      open: true,
      m,
    }));
    // Every group lists its projects here, collapsed on the Welcome screen or not; a search is flat.
    const expanded = groups.map((g) => ({ ...g, expanded: true }));
    const rest = recentRows(
      recent.filter((r) => !openPaths.has(r.path)),
      expanded,
      query,
      home,
    ).flatMap((r) => (r.kind === "project" ? [{ kind: "project" as const, open: false, m: r.m, group: r.group }] : []));
    const acts = query ? [] : ACTIONS.filter((a) => actions.has(a.id)).map((a) => ({ kind: "action" as const, ...a }));
    return [...acts, ...open, ...rest];
  }, [actions, recent, groups, home, openProjects, query]);
  const current = Math.min(active, entries.length - 1);

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const activate = (e: Entry | undefined) => {
    if (!e) return;
    onClose();
    if (e.kind === "action") void executeAction(e.id);
    else if (e.open && !parseRemoteLocation(e.m.project.path))
      void call(commands.windowOpenProject(e.m.project.path, false, [])).catch(() => undefined);
    // Opening a remote location focuses the window already connected to it.
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
        void askRemoveRecent(entry.m.project, onClose);
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
            {e.kind === "project" && !e.open && <GroupBoundary entry={e} previous={entries[i - 1]} />}
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
                showContextMenu(ev, recentMenu(e.m.project, onClose, onClose));
              }}
            >
              {e.kind === "action" ? (
                <>
                  <Icon name={e.icon} size={16} className={styles.actionIcon} />
                  <span className={styles.label}>{tx(e.label)}</span>
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

/** A project group's name above its first project; a separator where the ungrouped projects start. */
function GroupBoundary({
  entry,
  previous,
}: {
  entry: Extract<Entry, { kind: "project" }>;
  previous: Entry | undefined;
}) {
  const before = previous?.kind === "project" && !previous.open ? (previous.group ?? null) : null;
  const group = entry.group ?? null;
  if (group === before) return null;
  if (group === null) return <div className={styles.separator} role="separator" />;
  return (
    <div className={styles.groupHeader}>
      <Icon name="folder" size={14} />
      <span className={styles.label}>{group}</span>
    </div>
  );
}

function ProjectRow({ m, active }: { m: RecentMatch; active: boolean }) {
  return (
    <>
      <ProjectBadge
        name={m.project.name}
        path={m.project.path}
        className={styles.badge}
        missing={!!m.project.missing}
      />
      <span className={styles.text} title={unavailableTitle(m.project)}>
        <span className={styles.top}>
          <HighlightedText
            className={clsx(styles.name, m.project.missing && styles.unavailable)}
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
