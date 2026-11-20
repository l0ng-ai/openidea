/**
 * Jump to Navigation Bar (⌘↑): IDEA's floating navigation bar over the
 * editor. ←/→ move between segments, ↓ / Enter open the segment's children
 * (folder contents, file / symbol members); Enter on a child opens it (a
 * folder becomes the next segment), Escape closes the list, then the bar.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import { create } from "zustand";
import { call, commands, isTauri, type OutlineItem } from "@/platform/ipc";
import { projectFolder, useProject } from "@/platform/project";
import { useProjectViewLead } from "@/workbench/contributions";
import { Icon, listNavigate, Popup, revealHorizontally, revealVertically, T } from "@/ui";
import { editorController, useEditorStatus } from "../controller";
import { useOutline } from "../model/document";
import { symbolChain } from "./outline";
import {
  dirChildren,
  iconOf,
  navSegments,
  stepSegment,
  symbolChildren,
  type NavChild,
  type NavSegment,
} from "./navBar";
import styles from "./NavBarPopup.module.css";
import { tx } from "@/platform/i18n";

export const useNavBarPopup = create<{ open: boolean; seq: number }>(() => ({ open: false, seq: 0 }));

export function openNavBarPopup() {
  useNavBarPopup.setState((s) => ({ open: true, seq: s.seq + 1 }));
}

const close = () => useNavBarPopup.setState({ open: false });

export function NavBarPopup() {
  const open = useNavBarPopup((s) => s.open);
  // Closed nearly always: no subscription to the caret, which moves on every keystroke.
  return open ? <OpenNavBar /> : null;
}

function OpenNavBar() {
  const seq = useNavBarPopup((s) => s.seq);
  const status = useEditorStatus((s) => s.status);
  const project = useProject((s) => s.project);
  const lead = useProjectViewLead((s) => s.lead);
  const path = lead?.path ?? status?.path ?? project?.root;
  if (!path) return null;
  return (
    <NavBar key={seq} path={path} line={status?.line ?? 0} col={status?.col ?? 0} directory={lead?.dir ?? !status} />
  );
}

async function childrenOf(seg: NavSegment, outline: readonly OutlineItem[] | undefined): Promise<NavChild[]> {
  if (seg.kind === "dir") return isTauri() ? dirChildren(await call(commands.fsReadDir(seg.path))) : [];
  if (seg.kind === "file") return symbolChildren(seg.path, outline ?? []);
  return symbolChildren(seg.path, seg.item.children);
}

function anchorPoint(): { x: number; y: number } {
  const ed = editorController().activeSlot?.view?.dom;
  const r = (ed ?? document.querySelector("[data-editor-area]"))?.getBoundingClientRect();
  return r ? { x: r.left + 8, y: r.top + 4 } : { x: 80, y: 80 };
}

function NavChildList({
  label,
  id,
  items,
  active,
  onSelect,
  onChoose,
  onKeyDown,
}: {
  label: string;
  id: string;
  items: readonly NavChild[] | null;
  active: number;
  onSelect: (index: number) => void;
  onChoose: (child: NavChild) => void;
  onKeyDown?: (e: KeyboardEvent) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const scroller = ref.current;
    const row = scroller?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!scroller || !row) return;
    const reveal = () => revealVertically(scroller, row);
    reveal();
    if (typeof ResizeObserver === "undefined") return;
    const resize = new ResizeObserver(reveal);
    resize.observe(scroller);
    return () => resize.disconnect();
  }, [active, items]);

  return (
    <div
      ref={ref}
      id={id}
      className={styles.list}
      role="listbox"
      aria-label={label}
      aria-activedescendant={items?.[active] ? `${id}-${active}` : undefined}
      tabIndex={0}
      data-autofocus
      onKeyDown={onKeyDown}
    >
      {items?.length === 0 && (
        <div className={styles.empty}>
          <T>Nothing here</T>
        </div>
      )}
      {items?.map((child, i) => (
        <div
          key={`${child.path}:${child.label}:${i}`}
          id={`${id}-${i}`}
          role="option"
          aria-selected={i === active}
          className={clsx(styles.row, i === active && styles.rowActive)}
          onMouseEnter={() => onSelect(i)}
          onClick={() => onChoose(child)}
        >
          <Icon name={iconOf(child)} size={16} className={styles.rowIcon} />
          <span className={styles.rowLabel} title={child.label}>
            {child.label}
          </span>
          {child.kind === "dir" && <Icon name="chevron-right" size={12} className={styles.rowChevron} />}
        </div>
      ))}
    </div>
  );
}

function NavBar({ path, line, col, directory }: { path: string; line: number; col: number; directory: boolean }) {
  const project = useProject((s) => s.project);
  const outline = useOutline((s) => s[path]);
  const initial = useMemo(
    () => navSegments(projectFolder(project, path), path, outline ? symbolChain(outline, line, col) : [], directory),
    // The bar is a snapshot of where ⌘↑ was pressed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [segments, setSegments] = useState<NavSegment[]>(initial);
  const [active, setActive] = useState(() =>
    Math.max(0, directory ? initial.length - 1 : initial.findIndex((s) => s.kind === "file")),
  );
  const [list, setList] = useState<{ seg: number; items: NavChild[]; active: number } | null>(null);
  const [childAnchor, setChildAnchor] = useState<HTMLButtonElement | null>(null);
  const listId = useId();
  const [anchor] = useState(anchorPoint);
  const strip = useRef<HTMLDivElement>(null);
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const request = useRef(0);
  const listSegment = list?.seg;

  const closeList = () => {
    request.current++;
    setList(null);
  };

  const openList = async (index: number, segs = segments) => {
    const seg = segs[index];
    if (!seg) return;
    const id = ++request.current;
    const items = await childrenOf(seg, outline).catch((): NavChild[] => []);
    if (id !== request.current) return;
    // Start on the child that leads to the next segment, like IDEA.
    const next = segs[index + 1];
    const at = next ? items.findIndex((c) => c.path === next.path && c.label === next.label) : -1;
    setList({ seg: index, items, active: Math.max(0, at) });
  };

  const choose = (child: NavChild) => {
    if (!list) return;
    if (child.kind === "dir") {
      const segs: NavSegment[] = [
        ...segments.slice(0, list.seg + 1),
        { kind: "dir", path: child.path, label: child.label },
      ];
      setSegments(segs);
      setActive(segs.length - 1);
      void openList(segs.length - 1, segs);
      return;
    }
    close();
    if (child.kind === "file") void editorController().openFile(child.path, { focus: true });
    else {
      const p = child.item.selection_range.start;
      void editorController().openFile(child.path, { selection: { line: p.line, col: p.col }, focus: true });
    }
  };

  const move = (delta: number) => {
    const next = stepSegment(active, segments.length, delta);
    setActive(next);
    if (list) void openList(next);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    let handled = true;
    if (e.key === "ArrowLeft") move(-1);
    else if (e.key === "ArrowRight") move(1);
    else if (list) {
      const next = listNavigate(e.key, list);
      if (next !== null) setList({ ...list, active: next });
      else if (e.key === "Enter") {
        const child = list.items[list.active];
        if (child) choose(child);
      } else handled = false;
    } else if (e.key === "ArrowDown" || e.key === "Enter") void openList(active);
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  useLayoutEffect(() => {
    const row = strip.current;
    const current = buttons.current[active];
    if (!row || !current) return;
    const reveal = () => revealHorizontally(row, current);
    reveal();
    if (typeof ResizeObserver === "undefined") return;
    const resize = new ResizeObserver(reveal);
    resize.observe(row);
    return () => resize.disconnect();
  }, [active, segments]);
  useLayoutEffect(() => {
    setChildAnchor(listSegment === undefined ? null : (buttons.current[listSegment] ?? null));
  }, [listSegment, segments]);

  return (
    <Popup
      open
      anchor={anchor}
      placement="bottom-start"
      offset={0}
      onClose={close}
      aria-label="Navigation bar"
      className={styles.barPopup}
    >
      <div
        className={styles.root}
        tabIndex={0}
        data-autofocus
        onKeyDown={onKeyDown}
        role="toolbar"
        aria-label={tx("Navigation bar")}
      >
        <div className={styles.bar} ref={strip}>
          {segments.map((s, i) => (
            <span key={`${i}:${s.path}:${s.label}`} className={styles.segmentWrap}>
              {i > 0 && <Icon name="chevron-right" size={12} className={styles.sep} />}
              <button
                ref={(el) => void (buttons.current[i] = el)}
                type="button"
                tabIndex={-1}
                className={clsx(styles.segment, i === active && styles.active)}
                aria-current={i === active ? "location" : undefined}
                aria-haspopup="listbox"
                aria-expanded={i === listSegment}
                aria-controls={i === listSegment ? listId : undefined}
                title={s.label}
                onClick={() => {
                  setActive(i);
                  void openList(i);
                }}
              >
                <Icon name={iconOf(s)} size={14} className={styles.rowIcon} />
                <span className={styles.rowLabel}>{s.label}</span>
              </button>
            </span>
          ))}
        </div>
        {list && childAnchor && (
          <Popup
            open
            anchor={childAnchor}
            placement="bottom-start"
            onClose={closeList}
            aria-label={tx("Children")}
            className={styles.childPopup}
          >
            <NavChildList
              id={listId}
              label={tx("Children")}
              items={list.items}
              active={list.active}
              onSelect={(i) => setList({ ...list, active: i })}
              onChoose={choose}
            />
          </Popup>
        )}
      </div>
    </Popup>
  );
}

/**
 * The status bar navigation bar's popup (as IDEA's navigation bar): clicking
 * a segment lists its children; a folder lists its own (← goes back), a file
 * or symbol opens.
 */
export function NavChildrenPopup({
  segment,
  anchor,
  openAbove = true,
  onClose,
}: {
  segment: NavSegment;
  anchor: HTMLElement;
  openAbove?: boolean;
  onClose: () => void;
}) {
  const [stack, setStack] = useState<NavSegment[]>([segment]);
  const top = stack[stack.length - 1]!;
  const outline = useOutline((s) => s[top.path]);
  const [loaded, setLoaded] = useState<{ top: NavSegment; items: NavChild[] } | null>(null);
  const [active, setActive] = useState(0);
  const listId = useId();
  const items = loaded?.top === top ? loaded.items : null;

  useEffect(() => {
    let alive = true;
    void childrenOf(top, outline)
      .catch((): NavChild[] => [])
      .then((list) => {
        if (!alive) return;
        setLoaded({ top, items: list });
        setActive(0);
      });
    return () => {
      alive = false;
    };
  }, [top, outline]);
  const choose = (child: NavChild) => {
    if (child.kind === "dir") return setStack((s) => [...s, { kind: "dir", path: child.path, label: child.label }]);
    onClose();
    if (child.kind === "file") void editorController().openFile(child.path, { focus: true });
    else {
      const p = child.item.selection_range.start;
      void editorController().openFile(child.path, { selection: { line: p.line, col: p.col }, focus: true });
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const next = items ? listNavigate(e.key, { items, active, wrap: true }) : null;
    let handled = true;
    if (next !== null) setActive(next);
    else if (e.key === "Enter" || (e.key === "ArrowRight" && items?.[active]?.kind === "dir")) {
      const child = items?.[active];
      if (child) choose(child);
    } else if (e.key === "ArrowLeft" && stack.length > 1) setStack((s) => s.slice(0, -1));
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  return (
    <Popup
      open
      anchor={anchor}
      placement={openAbove ? "top-start" : "bottom-start"}
      onClose={onClose}
      aria-label={top.label}
      className={styles.childPopup}
    >
      {stack.length > 1 && (
        <div className={styles.childHeader}>
          <Icon name={iconOf(top)} size={16} className={styles.rowIcon} />
          <span className={styles.rowLabel} title={top.label}>
            {top.label}
          </span>
        </div>
      )}
      <NavChildList
        id={listId}
        label={top.label}
        items={items}
        active={active}
        onSelect={setActive}
        onChoose={choose}
        onKeyDown={onKeyDown}
      />
    </Popup>
  );
}
