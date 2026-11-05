/**
 * Bookmark popups: the mnemonic chooser (⌥F3 / Ctrl+F11), the Bookmarks
 * popup (⌘F3: line, file and folder bookmarks by list + preview; Enter jumps), the Edit Description dialog
 * (F2 / Rename) and the bookmark list name dialog (New List / Rename List).
 */
import { useMemo, useState, type KeyboardEvent, type MouseEvent } from "react";
import clsx from "clsx";
import { executeAction } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { Dialog, Icon, Input, List, Popup, T, fileIconName, type DialogButton } from "@/ui";
import { CodePreview } from "../find/parts";
import { basename, openLocation, relPath } from "../common/open";
import {
  MNEMONICS,
  assignMnemonic,
  bookmarkAt,
  bookmarkLabel,
  createList,
  describeBookmark,
  renameList,
  updateBookmarkData,
  validateListName,
  removeBookmarks,
  updateBookmarks,
  useBookmarkPopups,
  useBookmarks,
  type Bookmark,
  type BookmarkList,
  type PathBookmark,
} from "./store";
import styles from "./BookmarkPopups.module.css";

export function BookmarkPopupsOverlay() {
  const chooser = useBookmarkPopups((s) => s.chooser);
  const list = useBookmarkPopups((s) => s.list);
  const editing = useBookmarkPopups((s) => s.editing);
  const naming = useBookmarkPopups((s) => s.naming);
  return (
    <>
      {chooser && <MnemonicChooser key={`${chooser.path}:${chooser.line}`} />}
      {list && <BookmarksPopup />}
      {editing && <EditDescriptionDialog key={`${editing.path}:${editing.line}`} />}
      {naming && <ListNameDialog key={naming.listId ?? "new"} />}
    </>
  );
}

// --- mnemonic chooser ---------------------------------------------------------

const DIGITS = MNEMONICS.filter((m) => /\d/.test(m));
const LETTERS = MNEMONICS.filter((m) => /[A-Z]/.test(m));

function MnemonicChooser() {
  const target = useBookmarkPopups((s) => s.chooser)!;
  const items = useBookmarks((s) => s.items);
  const current = bookmarkAt(items, target.path, target.line);
  const assigned = useMemo(
    () => new Set(items.filter((b) => b.mnemonic && b !== current).map((b) => b.mnemonic!)),
    [items, current],
  );
  const [description, setDescription] = useState(current?.description ?? "");
  const close = () => useBookmarkPopups.setState({ chooser: null });
  const choose = (mnemonic: string) => {
    updateBookmarks((list) => assignMnemonic(list, target.path, target.line, target.text, mnemonic, description));
    close();
  };
  const title = !current ? "Add Mnemonic Bookmark" : current.mnemonic ? "Change Mnemonic" : "Assign Mnemonic";

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const inInput = (e.target as HTMLElement).tagName === "INPUT";
    if (e.key === "Enter" && inInput) {
      e.preventDefault();
      if (current?.mnemonic) choose(current.mnemonic);
      else if (current) {
        updateBookmarks((list) => describeBookmark(list, target.path, target.line, description));
        close();
      }
      return;
    }
    if (inInput || e.key.length !== 1) return;
    const key = e.key.toUpperCase();
    if (!MNEMONICS.includes(key)) return;
    e.preventDefault();
    choose(key);
  };

  const button = (m: string) => (
    <button
      key={m}
      type="button"
      className={clsx(styles.key, m === current?.mnemonic && styles.keyCurrent, assigned.has(m) && styles.keyAssigned)}
      aria-pressed={m === current?.mnemonic}
      onClick={() => choose(m)}
    >
      {m}
    </button>
  );

  return (
    <Popup
      open
      anchor={target.at ?? { x: window.innerWidth / 2 - 160, y: window.innerHeight / 3 }}
      placement="bottom-start"
      onClose={close}
      trapFocus
      aria-label={title}
    >
      <div className={styles.chooser} onKeyDown={onKeyDown}>
        <div className={styles.chooserTitle}>
          <T>{title}</T>
        </div>
        <div className={styles.grids}>
          <div className={styles.digits} data-autofocus tabIndex={-1}>
            {DIGITS.map(button)}
          </div>
          <div className={styles.letters}>{LETTERS.map(button)}</div>
        </div>
        <Input
          className={styles.description}
          value={description}
          placeholder="Description"
          aria-label="Bookmark description"
          onChange={(e) => setDescription(e.target.value)}
        />
        <div className={styles.legend}>
          <span className={clsx(styles.dot, styles.keyAssigned)} />
          <T>Assigned bookmark</T>
          <span className={styles.legendGap} />
          <span className={clsx(styles.dot, styles.keyCurrent)} />
          <T>Current bookmark</T>
        </div>
      </div>
    </Popup>
  );
}

// --- Bookmarks popup ------------------------------------------------------------

type Row =
  | { kind: "list"; key: string; name: string }
  /** A file with line bookmarks only (a section header). */
  | { kind: "file"; key: string; path: string }
  /** A bookmarked file or folder. */
  | { kind: "path"; key: string; path: string; dir: boolean }
  | { kind: "mark"; key: string; bookmark: Bookmark };

/**
 * Rows of the popup: each list (a header when there are lists) with its folders,
 * then its files by path, each file followed by its line bookmarks.
 */
export function bookmarkRows(
  items: readonly Bookmark[],
  paths: readonly PathBookmark[] = [],
  lists: readonly BookmarkList[] = [],
): Row[] {
  const rows: Row[] = [];
  const group = (list: string | null, marks: readonly Bookmark[], marked: readonly PathBookmark[]) => {
    const files = new Map<string, { bookmarked: boolean; marks: Bookmark[] }>();
    const file = (path: string) => files.get(path) ?? files.set(path, { bookmarked: false, marks: [] }).get(path)!;
    for (const p of marked) if (!p.dir) file(p.path).bookmarked = true;
    for (const b of marks) file(b.path).marks.push(b);
    const k = list ?? "";
    for (const p of marked.filter((p) => p.dir).sort((a, b) => a.path.localeCompare(b.path)))
      rows.push({ kind: "path", key: `d:${k}:${p.path}`, path: p.path, dir: true });
    for (const [path, f] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
      rows.push(
        f.bookmarked
          ? { kind: "path", key: `p:${k}:${path}`, path, dir: false }
          : { kind: "file", key: `f:${k}:${path}`, path },
      );
      for (const b of f.marks) rows.push({ kind: "mark", key: `b:${b.path}:${b.line}`, bookmark: b });
    }
  };
  if (!lists.length) group(null, items, paths);
  for (const l of lists) {
    const marks = items.filter((b) => b.list === l.id);
    const marked = paths.filter((p) => p.list === l.id);
    if (!marks.length && !marked.length) continue;
    rows.push({ kind: "list", key: `l:${l.id}`, name: l.name });
    group(l.id, marks, marked);
  }
  return rows;
}

const isSectionRow = (r: Row) => r.kind === "file" || r.kind === "list";

function BookmarksPopup() {
  const items = useBookmarks((s) => s.items);
  const paths = useBookmarks((s) => s.paths);
  const lists = useBookmarks((s) => s.lists);
  const root = useProject((s) => s.project?.root ?? null);
  const rows = useMemo(() => bookmarkRows(items, paths, lists), [items, paths, lists]);
  const [index, setIndex] = useState(() => rows.findIndex((r) => !isSectionRow(r)));
  const active = Math.min(index, rows.length - 1);
  const row = rows[active];
  const selected = row?.kind === "mark" ? row.bookmark : null;
  const selectedPath = row?.kind === "path" ? row : null;
  const close = () => useBookmarkPopups.setState({ list: false });
  const jump = (r: Row | undefined) => {
    if (r?.kind !== "mark" && r?.kind !== "path") return;
    close();
    setTimeout(() => {
      if (r.kind === "mark") void openLocation(r.bookmark.path, { line: r.bookmark.line, col: 0 });
      else if (r.dir) void executeAction("navigate.selectInProjectView", r.path);
      else void openLocation(r.path);
    }, 0);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (selectedPath && (e.key === "Delete" || e.key === "Backspace")) {
      e.preventDefault();
      updateBookmarkData((d) => ({ ...d, paths: d.paths.filter((p) => p.path !== selectedPath.path) }));
      return;
    }
    if (!selected) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      updateBookmarks((list) => removeBookmarks(list, (b) => b.path === selected.path && b.line === selected.line));
    } else if (e.key === "F2") {
      e.preventDefault();
      useBookmarkPopups.setState({ editing: { path: selected.path, line: selected.line } });
    }
  };

  const fileLabel = (path: string, dir: boolean) => (
    <span className={styles.fileRow}>
      <Icon name={dir ? "folder" : fileIconName(basename(path), path)} size={14} />
      <span className={styles.fileName}>{basename(path)}</span>
      <span className={styles.dim}>{root ? relPath(path) : path}</span>
    </span>
  );
  const previewPath = selected?.path ?? (selectedPath && !selectedPath.dir ? selectedPath.path : null);

  return (
    <Dialog open onClose={close} width={820} title="Bookmarks" position="top" className={styles.listDialog}>
      <div className={styles.listBody} onKeyDown={onKeyDown}>
        <div className={styles.listPane}>
          <List<Row>
            items={rows}
            getKey={(r) => r.key}
            isSection={isSectionRow}
            activeIndex={active}
            onActiveChange={setIndex}
            onActivate={(r, _i, e) => {
              if (e.type === "click" && (e as MouseEvent).detail < 2) return;
              jump(r);
            }}
            aria-label="Bookmarks"
            rowHeight={22}
            sectionHeight={24}
            empty={<span>{items.length || paths.length ? null : <T>No bookmarks</T>}</span>}
            renderSection={(r) =>
              r.kind === "file" ? (
                fileLabel(r.path, false)
              ) : r.kind === "list" ? (
                <span className={styles.listRow}>{r.name}</span>
              ) : null
            }
            renderItem={(r) =>
              r.kind === "path" ? (
                fileLabel(r.path, r.dir)
              ) : r.kind === "mark" ? (
                <span className={styles.markRow}>
                  {r.bookmark.mnemonic ? (
                    <span className={styles.mnemonic}>{r.bookmark.mnemonic}</span>
                  ) : (
                    <Icon name="bookmark" size={14} />
                  )}
                  <span className={styles.markText}>{bookmarkLabel(r.bookmark) || <T>(empty line)</T>}</span>
                  <span className={styles.dim}>{r.bookmark.line + 1}</span>
                </span>
              ) : null
            }
          />
        </div>
        <div className={styles.previewPane}>
          <CodePreview path={previewPath} line={selected?.line ?? 0} highlights={[]} />
        </div>
      </div>
    </Dialog>
  );
}

// --- Edit Description --------------------------------------------------------------

function EditDescriptionDialog() {
  const editing = useBookmarkPopups((s) => s.editing)!;
  const bookmark = useBookmarks((s) => bookmarkAt(s.items, editing.path, editing.line));
  const [text, setText] = useState(bookmark?.description ?? bookmark?.text ?? "");
  const close = () => useBookmarkPopups.setState({ editing: null });
  const save = () => {
    updateBookmarks((list) => describeBookmark(list, editing.path, editing.line, text));
    close();
  };
  const buttons: DialogButton[] = [
    { label: "Cancel", role: "cancel" },
    { label: "OK", role: "default", onClick: save },
  ];
  return (
    <Dialog open onClose={close} title="Edit Bookmark Description" width={420} buttons={buttons}>
      <Input
        data-autofocus
        value={text}
        aria-label="Description"
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
      />
    </Dialog>
  );
}

// --- Bookmark list name ------------------------------------------------------------

function ListNameDialog() {
  const naming = useBookmarkPopups((s) => s.naming)!;
  const lists = useBookmarks((s) => s.lists);
  const current = naming.listId ? lists.find((l) => l.id === naming.listId) : undefined;
  const [name, setName] = useState(current?.name ?? "");
  const error = validateListName(lists, name, current?.id);
  const close = () => useBookmarkPopups.setState({ naming: null });
  const save = () => {
    if (error) return;
    close();
    if (current) return updateBookmarkData((d) => renameList(d, current.id, name));
    let id = "";
    updateBookmarkData((d) => {
      const made = createList(d, name);
      id = made.id;
      return made.data;
    });
    naming.then?.(id);
  };
  const buttons: DialogButton[] = [
    { label: "Cancel", role: "cancel" },
    { label: "OK", role: "default", disabled: !!error, onClick: save },
  ];
  return (
    <Dialog
      open
      onClose={close}
      title={current ? "Rename Bookmark List" : "New Bookmark List"}
      width={380}
      buttons={buttons}
    >
      <Input
        data-autofocus
        value={name}
        aria-label="List name"
        invalid={!!error && name.trim() !== ""}
        onChange={(e) => setName(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            save();
          }
        }}
      />
      {error && name.trim() !== "" && <div className={styles.dim}>{error}</div>}
    </Dialog>
  );
}
