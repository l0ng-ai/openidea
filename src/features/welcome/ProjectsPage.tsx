/** Welcome › Projects: search, Open / Clone Repository, and the recent projects list. */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import { executeAction, useActions } from "@/platform/actions";
import { shortcutLabel } from "@/platform/keymap";
import { useProject } from "@/platform/project";
import { useRemoteProgress } from "@/platform/remote";
import { stageLabel } from "@/features/remote-dev/model";
import {
  Button,
  HighlightedText,
  Icon,
  IconButton,
  Kbd,
  SearchField,
  Spinner,
  listNavigate,
  showContextMenu,
  T,
} from "@/ui";
import { askRemoveRecent, ProjectBadge, recentMenu } from "./RecentList";
import { filterRecent, openRecent, useRecent, type RecentMatch } from "./recent";
import styles from "./Welcome.module.css";
import { tx } from "@/platform/i18n";

function HeaderButtons() {
  const canClone = useActions((s) => s.actions.has("vcs.clone"));
  const canRemote = useActions((s) => s.actions.has("remote.connect"));
  const opening = useProject((s) => s.opening);
  const openKey = shortcutLabel("file.openProject");
  return (
    <div className={styles.headerButtons}>
      <Button
        disabled={opening}
        onClick={() => void executeAction("file.openProject")}
        title={openKey ? tx`Open (${openKey})` : "Open"}
      >
        <T>Open</T>
      </Button>
      {canClone && (
        <Button onClick={() => void executeAction("vcs.clone")}>
          <T>Clone Repository</T>
        </Button>
      )}
      {canRemote && (
        <Button disabled={opening} onClick={() => void executeAction("remote.connect")}>
          <T>Remote Development</T>
        </Button>
      )}
    </div>
  );
}

/** Shown when there are no recent projects (IntelliJ's empty welcome). */
function Landing() {
  const canClone = useActions((s) => s.actions.has("vcs.clone"));
  const opening = useProject((s) => s.opening);
  const shortcut = shortcutLabel("file.openProject");
  return (
    <div className={styles.landing}>
      <div className={styles.landingTitle}>
        <T>Welcome to OpenIDEA</T>
      </div>
      <p className={styles.landingText}>
        Open a folder from disk{canClone ? " or clone a repository from version control" : ""}.
        <br />
        You can also drop a folder onto this window.
      </p>
      <div className={styles.landingActions}>
        <button
          type="button"
          className={styles.landingAction}
          disabled={opening}
          onClick={() => void executeAction("file.openProject")}
        >
          <span className={styles.landingIcon}>
            <Icon name="folder-open" size={20} />
          </span>
          <T>Open</T>
        </button>
        {canClone && (
          <button type="button" className={styles.landingAction} onClick={() => void executeAction("vcs.clone")}>
            <span className={styles.landingIcon}>
              <Icon name="branch" size={20} />
            </span>
            <T>Clone Repository</T>
          </button>
        )}
      </div>
      {shortcut && (
        <div className={styles.landingHint}>
          <T>Open a folder</T> <Kbd>{shortcut}</Kbd>
        </div>
      )}
    </div>
  );
}

function ProjectRow({
  m,
  id,
  selected,
  onSelect,
  onOpen,
}: {
  m: RecentMatch;
  id: string;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
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
      title={m.project.path}
      className={clsx(styles.project, selected && styles.projectSelected)}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        onSelect();
        onOpen();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onSelect();
        showContextMenu(e, recentMenu(m.project));
      }}
    >
      <ProjectBadge name={m.project.name} className={styles.projectBadge} />
      <span className={styles.projectText}>
        <HighlightedText className={styles.projectName} text={m.project.name} indices={m.nameMatch} tone="strong" />
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
export function handleListKey(
  e: Pick<KeyboardEvent, "key" | "metaKey" | "shiftKey">,
  ctx: { items: readonly RecentMatch[]; current: number; caretAtEnd: boolean },
): { kind: "move"; index: number } | { kind: "open" | "remove" | "menu"; match: RecentMatch } | null {
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
  const loaded = useRecent((s) => s.loaded);
  const home = useRecent((s) => s.home);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const baseId = useId();
  const items = useMemo(() => filterRecent(projects, query, home), [projects, query, home]);
  const current = Math.max(0, Math.min(active, items.length - 1));

  if (!loaded) return null;
  if (projects.length === 0) return <Landing />;

  const optionId = (i: number) => `${baseId}-p${i}`;

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const input = e.target instanceof HTMLInputElement ? e.target : null;
    const caretAtEnd =
      !input || (input.selectionStart === input.value.length && input.selectionEnd === input.value.length);
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
    if (r.kind === "move") setActive(r.index);
    else if (r.kind === "open") void openRecent(r.match.project);
    else if (r.kind === "remove") void askRemoveRecent(r.match.project);
    else {
      const el = document.getElementById(optionId(current))?.getBoundingClientRect();
      showContextMenu({ x: (el?.right ?? 0) - 40, y: (el?.top ?? 0) + 24 }, recentMenu(r.match.project));
    }
  };

  return (
    <div className={styles.projects}>
      <div className={styles.header}>
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
          aria-activedescendant={items.length ? optionId(current) : undefined}
          autoFocus
          data-autofocus
          onKeyDown={onKeyDown}
          className={styles.search}
        />
        <HeaderButtons />
      </div>
      <div
        id={`${baseId}-list`}
        role="listbox"
        aria-label="Recent projects"
        tabIndex={-1}
        className={styles.projectList}
        onKeyDown={onKeyDown}
      >
        {items.map((m, i) => (
          <ProjectRow
            key={m.project.path}
            m={m}
            id={optionId(i)}
            selected={i === current}
            onSelect={() => setActive(i)}
            onOpen={() => void openRecent(m.project)}
          />
        ))}
        {items.length === 0 && (
          <div className={styles.noMatches}>
            <T>No matching projects</T>
          </div>
        )}
      </div>
    </div>
  );
}
