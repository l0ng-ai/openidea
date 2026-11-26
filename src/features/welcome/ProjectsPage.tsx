/**
 * Welcome › Projects and Files: stacked primary actions (Open, New ▾, Clone Repository,
 * Remote Development), search field, and the recent projects / groups list.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import clsx from "clsx";
import { executeAction, useActions } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import type { RecentProjectGroup } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { useRemoteProgress } from "@/platform/remote";
import { stageLabel } from "@/features/remote-dev/model";
import {
  HighlightedText,
  Icon,
  IconButton,
  Menu,
  type MenuItem,
  SearchField,
  Spinner,
  isPopupOpen,
  listNavigate,
  showContextMenu,
  T,
} from "@/ui";
import { projectWindowOverride } from "@/workbench/projectWindow";
import { askNewGroup, askRemoveRecent, groupMenu, ProjectBadge, recentMenu, unavailableTitle } from "./RecentList";
import { openRecent, recentRows, setGroupExpanded, useRecent, type RecentMatch, type RecentRow } from "./recent";
import styles from "./Welcome.module.css";

function ActionStack() {
  const actions = useActions((s) => s.actions);
  const opening = useProject((s) => s.opening);
  const canCreate = actions.has("file.newProject");
  const canNewFile = actions.has("file.newUntitled");
  const canNewMarkdown = actions.has("file.newMarkdownFile");
  const canClone = actions.has("vcs.clone");
  const canRemote = actions.has("remote.connect");
  const [newOpen, setNewOpen] = useState(false);
  const newRef = useRef<HTMLButtonElement>(null);

  const newItems = useMemo<MenuItem[]>(() => {
    const items: MenuItem[] = [];
    if (canCreate) items.push({ kind: "action", action: "file.newProject", label: "New Project…", disabled: opening });
    if (canNewFile) items.push({ kind: "action", action: "file.newUntitled", label: "New File", disabled: opening });
    if (canNewMarkdown)
      items.push({ kind: "action", action: "file.newMarkdownFile", label: "New Markdown File", disabled: opening });
    if (items.length) items.push({ kind: "separator" });
    items.push({ id: "newGroup", label: "New Project Group…", icon: "folder", run: () => void askNewGroup() });
    return items;
  }, [canCreate, canNewFile, canNewMarkdown, opening]);

  return (
    <div className={styles.actionStack} role="group" aria-label={tx("Project actions")}>
      <button
        type="button"
        className={styles.actionButton}
        disabled={opening}
        onClick={() => void executeAction("file.openProject")}
      >
        <Icon name="folder-open" size={16} />
        <span className={styles.actionLabel}>
          <T>Open</T>
        </span>
      </button>
      <button
        ref={newRef}
        type="button"
        className={styles.actionButton}
        aria-haspopup="menu"
        aria-expanded={newOpen}
        onClick={() => setNewOpen((v) => !v)}
      >
        <Icon name="plus" size={16} />
        <span className={styles.actionLabel}>
          <T>New</T>
        </span>
        <Icon name="chevron-down" size={12} className={styles.actionChevron} />
      </button>
      <Menu
        open={newOpen}
        onClose={() => setNewOpen(false)}
        anchor={newRef}
        items={newItems}
        placement="bottom-start"
        aria-label="New"
      />
      {canClone && (
        <button type="button" className={styles.actionButton} onClick={() => void executeAction("vcs.clone")}>
          <Icon name="branch" size={16} />
          <span className={styles.actionLabel}>
            <T>Clone Repository</T>
          </span>
        </button>
      )}
      {canRemote && (
        <button
          type="button"
          className={styles.actionButton}
          disabled={opening}
          onClick={() => void executeAction("remote.connect")}
        >
          <Icon name="remote" size={16} />
          <span className={styles.actionLabel}>
            <T>Remote Development</T>
          </span>
        </button>
      )}
    </div>
  );
}

/** A project group: click or Enter folds it, its menu renames or removes it. */
function GroupRow({
  group,
  count,
  id,
  selected,
  onSelect,
}: {
  group: RecentProjectGroup;
  count: number;
  id: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);
  return (
    <div
      ref={ref}
      id={id}
      role="option"
      aria-selected={selected}
      aria-expanded={group.expanded}
      className={clsx(styles.project, styles.group, selected && styles.projectSelected)}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        onSelect();
        void setGroupExpanded(group.name, !group.expanded);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onSelect();
        showContextMenu(e, groupMenu(group));
      }}
    >
      <Icon name={group.expanded ? "chevron-down" : "chevron-right"} size={16} />
      <Icon name="folder" size={16} />
      <span className={styles.groupName}>{group.name}</span>
      <span className={styles.groupCount}>{count}</span>
      <IconButton
        icon="more"
        title="Group actions"
        aria-haspopup="menu"
        iconSize={16}
        className={styles.projectMore}
        tabIndex={-1}
        onClick={(e) => {
          e.stopPropagation();
          onSelect();
          const r = e.currentTarget.getBoundingClientRect();
          showContextMenu({ x: r.left, y: r.bottom + 2 }, groupMenu(group));
        }}
      />
    </div>
  );
}

function ProjectRow({
  m,
  id,
  selected,
  nested,
  onSelect,
  onOpen,
}: {
  m: RecentMatch;
  id: string;
  selected: boolean;
  /** Listed under a group. */
  nested?: boolean;
  onSelect: () => void;
  /** Its modifier keys pick the window ({@link projectWindowOverride}). */
  onOpen: (e: MouseEvent<HTMLDivElement>) => void;
}) {
  const opening = useRecent((s) => s.opening === m.project.path);
  // Opening a remote project: which stage of connecting it is at.
  const progress = useRemoteProgress((s) => (opening ? s.progress : null));
  const stage = progress
    ? tx(stageLabel(progress.stage)) + (progress.fraction == null ? "" : ` ${Math.round(progress.fraction * 100)}%`)
    : null;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);
  return (
    <div
      ref={ref}
      id={id}
      role="option"
      aria-selected={selected}
      title={unavailableTitle(m.project) ?? m.project.path}
      className={clsx(styles.project, nested && styles.projectNested, selected && styles.projectSelected)}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        onSelect();
        onOpen(e);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onSelect();
        showContextMenu(e, recentMenu(m.project));
      }}
    >
      <ProjectBadge
        name={m.project.name}
        path={m.project.path}
        className={styles.projectBadge}
        missing={!!m.project.missing}
      />
      <span className={styles.projectText}>
        <HighlightedText
          className={clsx(styles.projectName, m.project.missing && styles.unavailable)}
          text={m.project.name}
          indices={m.nameMatch}
          tone="strong"
        />
        {stage ? (
          <span className={styles.projectPath} role="status">
            {stage}
          </span>
        ) : (
          <HighlightedText className={styles.projectPath} text={m.displayPath} indices={m.pathMatch} />
        )}
        {m.project.branch && (
          <span className={styles.projectBranch}>
            <Icon name="branch" size={14} />
            <span className={styles.projectBranchName}>{m.project.branch}</span>
          </span>
        )}
      </span>
      {opening ? (
        <Spinner size={14} className={styles.projectSpinner} />
      ) : (
        <IconButton
          icon="more"
          title="Project actions"
          aria-haspopup="menu"
          iconSize={16}
          className={styles.projectMore}
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            onSelect();
            const r = e.currentTarget.getBoundingClientRect();
            showContextMenu({ x: r.left, y: r.bottom + 2 }, recentMenu(m.project));
          }}
        />
      )}
    </div>
  );
}

/** Keys shared by the search field and the list. Returns true when handled. */
export function handleListKey<T>(
  e: Pick<KeyboardEvent, "key" | "metaKey" | "shiftKey">,
  ctx: { items: readonly T[]; current: number; caretAtEnd: boolean },
): { kind: "move"; index: number } | { kind: "open" | "remove" | "menu"; match: T } | null {
  const m = ctx.items[ctx.current];
  if (e.key === "Enter") return m ? { kind: "open", match: m } : null;
  if (m && ((e.key === "Delete" && ctx.caretAtEnd) || (e.key === "Backspace" && e.metaKey)))
    return { kind: "remove", match: m };
  if (m && (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey))) return { kind: "menu", match: m };
  const next = listNavigate(e.key, { items: ctx.items, active: ctx.current, pageSize: 8 });
  return next === null ? null : { kind: "move", index: next };
}

export function ProjectsPage() {
  const projects = useRecent((s) => s.projects);
  const groups = useRecent((s) => s.groups);
  const loaded = useRecent((s) => s.loaded);
  const home = useRecent((s) => s.home);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const baseId = useId();
  const items = useMemo(() => recentRows(projects, groups, query, home), [projects, groups, query, home]);
  const current = Math.max(0, Math.min(active, items.length - 1));

  const optionId = (i: number) => `${baseId}-p${i}`;

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const input = e.target instanceof HTMLInputElement ? e.target : null;
    const caretAtEnd =
      !input || (input.selectionStart === input.value.length && input.selectionEnd === input.value.length);
    const row = items[current];
    // A group folds with ← / → (and Enter, below), like a tree node.
    if (row?.kind === "group" && !input && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      void setGroupExpanded(row.group.name, e.key === "ArrowRight");
      return;
    }
    const r = handleListKey(e, { items, current, caretAtEnd });
    if (!r) {
      // Typing in the list goes to the search field.
      if (!input && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setQuery((q) => q + e.key);
        setActive(0);
        search.current?.focus();
      }
      return;
    }
    e.preventDefault();
    if (r.kind === "move") {
      setActive(r.index);
      return;
    }
    const match: RecentRow = r.match;
    if (match.kind === "group") {
      if (r.kind === "open") void setGroupExpanded(match.group.name, !match.group.expanded);
      else if (r.kind === "menu") {
        const el = document.getElementById(optionId(current))?.getBoundingClientRect();
        showContextMenu({ x: (el?.right ?? 0) - 40, y: (el?.top ?? 0) + 24 }, groupMenu(match.group));
      }
      return;
    }
    if (r.kind === "open") void openRecent(match.m.project, projectWindowOverride(e));
    else if (r.kind === "remove") void askRemoveRecent(match.m.project);
    else {
      const el = document.getElementById(optionId(current))?.getBoundingClientRect();
      showContextMenu({ x: (el?.right ?? 0) - 40, y: (el?.top ?? 0) + 24 }, recentMenu(match.m.project));
    }
  };

  return (
    <div className={styles.projects}>
      <ActionStack />
      <div className={styles.searchHeader}>
        <SearchField
          ref={search}
          variant="bare"
          value={query}
          onChange={(q) => {
            setQuery(q);
            setActive(0);
          }}
          placeholder="Search projects"
          aria-label="Search projects"
          aria-controls={`${baseId}-list`}
          aria-activedescendant={loaded && items.length ? optionId(current) : undefined}
          autoFocus={!isPopupOpen()}
          data-autofocus
          onKeyDown={onKeyDown}
          className={styles.search}
        />
      </div>
      <div
        id={`${baseId}-list`}
        role="listbox"
        aria-label={tx("Recent projects")}
        tabIndex={-1}
        className={styles.projectList}
        onKeyDown={onKeyDown}
      >
        {loaded &&
          items.map((row, i) =>
            row.kind === "group" ? (
              <GroupRow
                key={`group:${row.group.name}`}
                group={row.group}
                count={row.count}
                id={optionId(i)}
                selected={i === current}
                onSelect={() => setActive(i)}
              />
            ) : (
              <ProjectRow
                key={row.m.project.path}
                m={row.m}
                id={optionId(i)}
                selected={i === current}
                nested={row.group !== null}
                onSelect={() => setActive(i)}
                onOpen={(e) => void openRecent(row.m.project, projectWindowOverride(e))}
              />
            ),
          )}
        {loaded && projects.length === 0 && (
          <div className={styles.emptyProjects}>
            <div>
              <T>No recent projects</T>
            </div>
            <div className={styles.emptyHint}>
              <T>Drop a folder here to open it</T>
            </div>
          </div>
        )}
        {loaded && projects.length > 0 && items.length === 0 && (
          <div className={styles.noMatches}>
            <T>No matching projects</T>
          </div>
        )}
      </div>
    </div>
  );
}
