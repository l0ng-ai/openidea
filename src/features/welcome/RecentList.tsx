import { useMemo, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import clsx from "clsx";
import { call, commands, type RecentProject, type RecentProjectGroup } from "@/platform/ipc";
import { parseRemoteLocation } from "@/platform/remote";
import {
  HighlightedText,
  Icon,
  IconButton,
  List,
  SearchField,
  Spinner,
  listNavigate,
  showContextMenu,
  type MenuItem,
} from "@/ui";
import { promptInput } from "@/workbench/inputDialogs";
import { confirm } from "@/workbench/messages";
import { projectColorVars, projectInitials } from "@/workbench/projectColor";
import {
  createGroup,
  filterRecent,
  groupNameError,
  groupOf,
  moveToGroup,
  openRecent,
  removeGroup,
  removeRecent,
  renameGroup,
  useRecent,
  type RecentMatch,
} from "./recent";
import styles from "./Welcome.module.css";
import { tx } from "@/platform/i18n";

/** IDEA's "Remove Recent Project" confirmation, then removes it from the list. */
export async function askRemoveRecent(project: RecentProject) {
  const ok = await confirm({
    title: "Remove Recent Project",
    message: tx`Remove '${project.name}' from the list of recent projects?`,
    ok: "Remove",
  });
  if (ok) await removeRecent(project.path);
}

/** Rounded-square project avatar; same colour slot and initials as the title bar's project widget. */
export function ProjectBadge({ name, className }: { name: string; className?: string }) {
  return (
    <span className={clsx(styles.tile, className)} style={projectColorVars(name)} aria-hidden>
      {projectInitials(name)}
    </span>
  );
}

/** New Project Group…: asks for a name; with `path`, that project moves into the new group. */
export async function askNewGroup(path?: string) {
  const name = await promptInput({
    title: "New Project Group",
    label: "Group name:",
    okLabel: "Create",
    validate: (v) => groupNameError(v),
  });
  if (name !== null) await createGroup(name, path);
}

/** Move to Group: the other groups, a new one, or out of its group. */
function moveToGroupMenu(project: RecentProject): MenuItem {
  const groups = useRecent.getState().groups;
  const current = groupOf(project.path, groups)?.name ?? null;
  const others = groups.filter((g) => g.name !== current);
  const submenu: MenuItem[] = [
    ...others.map((g): MenuItem => ({
      label: g.name,
      verbatim: true,
      run: () => void moveToGroup(project.path, g.name),
    })),
    ...(others.length ? [{ kind: "separator" } as const] : []),
    { label: "New Group…", run: () => void askNewGroup(project.path) },
    ...(current
      ? [{ label: tx`Remove from '${current}'`, verbatim: true, run: () => void moveToGroup(project.path, null) }]
      : []),
  ];
  return { label: "Move to Group", icon: "folder", submenu };
}

/** A project group's actions. */
export function groupMenu(group: RecentProjectGroup): MenuItem[] {
  return [
    {
      label: "Rename Group…",
      icon: "edit",
      run: () =>
        void promptInput({
          title: "Rename Project Group",
          label: "Group name:",
          initial: group.name,
          okLabel: "Rename",
          validate: (v) => groupNameError(v, group.name),
        }).then((name) => (name === null ? undefined : renameGroup(group.name, name))),
    },
    { label: "New Project Group…", icon: "plus", run: () => void askNewGroup() },
    { kind: "separator" },
    {
      label: "Remove Group",
      icon: "close",
      danger: true,
      run: () => void removeGroup(group.name),
    },
  ];
}

export function recentMenu(project: RecentProject, onOpened?: () => void): MenuItem[] {
  // A remote project has no local folder.
  const remote = parseRemoteLocation(project.path);
  const items: MenuItem[] = [
    {
      id: "open",
      label: "Open",
      icon: "folder-open",
      run: () => void openRecent(project).then((ok) => ok && onOpened?.()),
    },
    remote
      ? {
          id: "openInNewWindow",
          label: "Open in New Window",
          icon: "folder-open",
          run: () =>
            void call(commands.windowOpenRemote(remote.target, remote.path, true))
              .then(() => onOpened?.())
              .catch(() => undefined),
        }
      : { kind: "action", action: "file.openInNewWindow", arg: project.path, label: "Open in New Window" },
    {
      id: "reveal",
      label: "Show in Finder",
      icon: "external-link",
      run: () =>
        void import("@tauri-apps/plugin-opener").then((m) => m.revealItemInDir(project.path)).catch(() => undefined),
    },
    {
      id: "copy",
      label: "Copy Path",
      icon: "copy",
      run: () => void navigator.clipboard?.writeText(project.path).catch(() => undefined),
    },
    { kind: "separator" },
    // Groups hold local projects (remote ones live in this window's own list).
    ...(remote ? [] : [moveToGroupMenu(project), { kind: "separator" } as const]),
    {
      id: "remove",
      label: "Remove from Recent Projects…",
      icon: "close",
      danger: true,
      run: () => void askRemoveRecent(project),
    },
  ];
  return remote ? items.filter((i) => !("id" in i && i.id === "reveal")) : items;
}

function relativeTime(ms: number | null): string | null {
  if (!ms) return null;
  const diff = Date.now() - ms;
  const min = 60_000,
    hour = 60 * min,
    day = 24 * hour;
  if (diff < hour) return "just now";
  if (diff < day) return `${Math.round(diff / hour)}h ago`;
  if (diff < 30 * day) return `${Math.round(diff / day)}d ago`;
  return new Date(ms).toLocaleDateString();
}

function RecentRow({
  m,
  active,
  compact,
  onOpened,
}: {
  m: RecentMatch;
  active: boolean;
  compact?: boolean;
  onOpened?: () => void;
}) {
  const opening = useRecent((s) => s.opening === m.project.path);
  const when = relativeTime(m.project.openedAtMs);
  return (
    <div className={clsx(styles.recent, compact && styles.recentCompact)}>
      <ProjectBadge name={m.project.name} />
      <span className={styles.recentText}>
        <span className={styles.recentTop}>
          <HighlightedText
            className={styles.recentName}
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
        <HighlightedText className={styles.recentPath} text={m.displayPath} indices={m.pathMatch} />
      </span>
      {opening ? (
        <Spinner size={14} />
      ) : (
        <>
          {!compact && when && <span className={styles.when}>{when}</span>}
          <IconButton
            icon="more"
            title="Project actions"
            size="small"
            iconSize={14}
            className={styles.rowMore}
            tabIndex={-1}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              showContextMenu({ x: r.left, y: r.bottom + 2 }, recentMenu(m.project, onOpened));
            }}
          />
        </>
      )}
    </div>
  );
}

export interface RecentListProps {
  /** Hide the current project (the popup while a project is open). */
  exclude?: string | null;
  compact?: boolean;
  autoFocus?: boolean;
  onOpened?: () => void;
  className?: string;
  /** Extra controls right of the search field. */
  toolbar?: ReactNode;
}

/** Searchable, keyboard-navigable recent projects list (search field keeps focus). */
export function RecentList({ exclude, compact, autoFocus, onOpened, className, toolbar }: RecentListProps) {
  const projects = useRecent((s) => s.projects);
  const home = useRecent((s) => s.home);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const items = useMemo(
    () => filterRecent(exclude ? projects.filter((p) => p.path !== exclude) : projects, query, home),
    [projects, query, home, exclude],
  );
  const current = Math.min(active, items.length - 1);

  const open = (m: RecentMatch | undefined) => {
    if (m) void openRecent(m.project).then((ok) => ok && onOpened?.());
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      open(items[current]);
      return;
    }
    if ((e.key === "Delete" || (e.key === "Backspace" && e.metaKey)) && items[current]) {
      e.preventDefault();
      void askRemoveRecent(items[current]!.project);
      return;
    }
    if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      const m = items[current];
      const el = e.currentTarget.getBoundingClientRect();
      if (m) showContextMenu({ x: el.left + 20, y: el.bottom + 4 }, recentMenu(m.project, onOpened));
      e.preventDefault();
      return;
    }
    const next = listNavigate(e.key, { items, active: current, pageSize: compact ? 8 : 6 });
    if (next === null) return;
    e.preventDefault();
    setActive(next);
  };

  return (
    <div className={clsx(styles.recentList, className)}>
      <div className={styles.searchRow}>
        <SearchField
          value={query}
          onChange={(q) => {
            setQuery(q);
            setActive(0);
          }}
          placeholder="Search projects"
          aria-label="Search recent projects"
          autoFocus={autoFocus}
          data-autofocus={autoFocus || undefined}
          onKeyDown={onKeyDown}
          className={styles.search}
        />
        {toolbar}
      </div>
      <List<RecentMatch>
        aria-label="Recent projects"
        items={items}
        getKey={(m) => m.project.path}
        activeIndex={current}
        onActiveChange={setActive}
        focusable={false}
        rowHeight={compact ? 40 : 48}
        className={styles.list}
        onActivate={(m) => open(m)}
        onContextMenu={(m, i, e: MouseEvent) => {
          e.preventDefault();
          setActive(i);
          showContextMenu(e, recentMenu(m.project, onOpened));
        }}
        renderItem={(m, s) => <RecentRow m={m} active={s.active} compact={compact} onOpened={onOpened} />}
        empty={
          <span className={styles.noMatches}>{query ? tx("No matching projects") : tx("No recent projects")}</span>
        }
      />
    </div>
  );
}
