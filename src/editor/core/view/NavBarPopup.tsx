/**
 * Jump to Navigation Bar (⌘↑): IDEA's floating navigation bar over the
 * editor. ←/→ move between segments, ↓ / Enter open the segment's children
 * (folder contents, file / symbol members); Enter on a child opens it (a
 * folder becomes the next segment), Escape closes the list, then the bar.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import { create } from "zustand";
import { call, commands, isTauri, type OutlineItem } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { Icon, Popup, T } from "@/ui";
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
  if (!status) return null;
  return <NavBar key={seq} path={status.path} line={status.line} col={status.col} />;
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

function NavBar({ path, line, col }: { path: string; line: number; col: number }) {
  const project = useProject((s) => s.project);
  const outline = useOutline((s) => s[path]);
  const initial = useMemo(
    () =>
      navSegments(
        project ? { root: project.root, name: project.name } : null,
        path,
        outline ? symbolChain(outline, line, col) : [],
      ),
    // The bar is a snapshot of where ⌘↑ was pressed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [segments, setSegments] = useState<NavSegment[]>(initial);
  const [active, setActive] = useState(() => initial.findIndex((s) => s.kind === "file"));
  const [list, setList] = useState<{ seg: number; items: NavChild[]; active: number; left: number } | null>(null);
  const [anchor] = useState(anchorPoint);
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const request = useRef(0);

  const openList = async (index: number, segs = segments) => {
    const seg = segs[index];
    if (!seg) return;
    const id = ++request.current;
    const items = await childrenOf(seg, outline).catch((): NavChild[] => []);
    if (id !== request.current) return;
    // Start on the child that leads to the next segment, like IDEA.
    const next = segs[index + 1];
    const at = next ? items.findIndex((c) => c.path === next.path && c.label === next.label) : -1;
    setList({ seg: index, items, active: Math.max(0, at), left: buttons.current[index]?.offsetLeft ?? 0 });
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
    else if (e.key === "ArrowDown" && !list) void openList(active);
    else if (e.key === "ArrowDown" && list)
      setList({ ...list, active: Math.min(list.items.length - 1, list.active + 1) });
    else if (e.key === "ArrowUp" && list) setList({ ...list, active: Math.max(0, list.active - 1) });
    else if (e.key === "Enter" && list) {
      const child = list.items[list.active];
      if (child) choose(child);
    } else if (e.key === "Enter") void openList(active);
    else if (e.key === "Escape" && list) setList(null);
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  useLayoutEffect(() => {
    buttons.current[active]?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [active]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [list]);

  return (
    <Popup
      open
      anchor={anchor}
      placement="bottom-start"
      offset={0}
      onClose={close}
      aria-label="Navigation bar"
      className={styles.popup}
    >
      <div
        className={styles.root}
        tabIndex={0}
        data-autofocus
        onKeyDown={onKeyDown}
        role="toolbar"
        aria-label={tx("Navigation bar")}
      >
        <div className={styles.bar}>
          {segments.map((s, i) => (
            <span key={`${i}:${s.path}:${s.label}`} className={styles.segmentWrap}>
              {i > 0 && <Icon name="chevron-right" size={12} className={styles.sep} />}
              <button
                ref={(el) => void (buttons.current[i] = el)}
                type="button"
                tabIndex={-1}
                className={clsx(styles.segment, i === active && styles.active)}
                aria-current={i === active ? "location" : undefined}
                onClick={() => {
                  setActive(i);
                  void openList(i);
                }}
              >
                <Icon name={iconOf(s)} size={14} />
                <span>{s.label}</span>
              </button>
            </span>
          ))}
        </div>
        {list && (
          <div
            ref={listRef}
            className={styles.list}
            style={{ marginLeft: list.left }}
            role="listbox"
            aria-label={tx("Children")}
          >
            {list.items.length === 0 && (
              <div className={styles.empty}>
                <T>Nothing here</T>
              </div>
            )}
            {list.items.map((c, i) => (
              <div
                key={`${c.path}:${c.label}:${i}`}
                role="option"
                aria-selected={i === list.active}
                className={clsx(styles.row, i === list.active && styles.rowActive)}
                onMouseEnter={() => setList({ ...list, active: i })}
                onClick={() => choose(c)}
              >
                <Icon name={iconOf(c)} size={14} />
                <span className={styles.rowLabel}>{c.label}</span>
              </div>
            ))}
          </div>
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
  onClose,
}: {
  segment: NavSegment;
  anchor: HTMLElement;
  onClose: () => void;
}) {
  const [stack, setStack] = useState<NavSegment[]>([segment]);
  const top = stack[stack.length - 1]!;
  const outline = useOutline((s) => s[top.path]);
  const [loaded, setLoaded] = useState<{ top: NavSegment; items: NavChild[] } | null>(null);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
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
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [active, items]);

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
    const n = items?.length ?? 0;
    let handled = true;
    if (e.key === "ArrowDown" && n) setActive((a) => (a + 1) % n);
    else if (e.key === "ArrowUp" && n) setActive((a) => (a - 1 + n) % n);
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
    <Popup open anchor={anchor} placement="top-start" onClose={onClose} aria-label={top.label} className={styles.popup}>
      <div
        ref={listRef}
        className={styles.childList}
        role="listbox"
        aria-label={top.label}
        tabIndex={0}
        data-autofocus
        aria-activedescendant={items?.length ? `navbar-child-${active}` : undefined}
        onKeyDown={onKeyDown}
      >
        {stack.length > 1 && (
          <div className={styles.childHeader}>
            <Icon name={iconOf(top)} size={14} />
            <span className={styles.rowLabel}>{top.label}</span>
          </div>
        )}
        {items?.length === 0 && (
          <div className={styles.empty}>
            <T>Nothing here</T>
          </div>
        )}
        {items?.map((c, i) => (
          <div
            key={`${c.path}:${c.label}:${i}`}
            id={`navbar-child-${i}`}
            role="option"
            aria-selected={i === active}
            className={clsx(styles.row, i === active && styles.rowActive)}
            onMouseEnter={() => setActive(i)}
            onClick={() => choose(c)}
          >
            <Icon name={iconOf(c)} size={14} />
            <span className={styles.rowLabel}>{c.label}</span>
            {c.kind === "dir" && <Icon name="chevron-right" size={12} className={styles.rowChevron} />}
          </div>
        ))}
      </div>
    </Popup>
  );
}
