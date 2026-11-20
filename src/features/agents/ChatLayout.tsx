/** Conversation placement within the editor area; the Agents tool window remains independent. */
import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import clsx from "clsx";
import { useTx } from "@/platform/i18n";
import { EditorShownProvider, ToolWindowShownProvider } from "@/workbench/contributions";
import { IconButton, Menu, startPointerDrag } from "@/ui";
import { HomeEditor } from "./HomeEditor";
import { SessionEditor } from "./SessionEditor";
import { SESSION_KIND, TASK_DRAG, sessionKey } from "./model";
import { chatPlacementMenu } from "./taskActions";
import { useAgents, type ChatSide } from "./store";
import styles from "./ChatLayout.module.css";

const SIZE_KEY = "openidea.agents.chatPaneSizes.v1";
const DEFAULT_SIZES = { left: 360, right: 360, top: 280, bottom: 280 };
type Sizes = Record<ChatSide, number>;
function loadSizes(): Sizes {
  try {
    const saved = JSON.parse(localStorage.getItem(SIZE_KEY) ?? "null") as Partial<Sizes> | null;
    return Object.fromEntries(
      Object.entries(DEFAULT_SIZES).map(([key, fallback]) => {
        const value = saved?.[key as ChatSide];
        return [
          key,
          typeof value === "number" && Number.isFinite(value) && value >= 120 && value <= 2400 ? value : fallback,
        ];
      }),
    ) as Sizes;
  } catch {
    return DEFAULT_SIZES;
  }
}
function saveSizes(sizes: Sizes) {
  try {
    localStorage.setItem(SIZE_KEY, JSON.stringify(sizes));
  } catch {
    /* Storage may be unavailable. */
  }
}

export function ChatLayout({ children }: { children: ReactNode }) {
  const tx = useTx();
  const side = useAgents((state) => state.chatSide);
  const location = useAgents((state) => state.sessionLocation);
  const task = useAgents((state) => state.docked);
  const home = useAgents((state) => state.homeOpen);
  const title = useAgents((state) => (task ? (state.tasks.get(task)?.title ?? task) : null));
  const shown = location === "pane" && (home || task !== null);
  const [sizes, setSizes] = useState(loadSizes);
  const sizesRef = useRef(sizes);
  const root = useRef<HTMLDivElement>(null);
  const pane = useRef<HTMLElement>(null);
  const drag = useRef<{ start: number; size: number } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const vertical = side === "left" || side === "right";
  const resizeDirection = side === "left" || side === "top" ? 1 : -1;
  const resize = (size: number, persist = false) => {
    const bounds = root.current?.getBoundingClientRect();
    const available = bounds ? (vertical ? bounds.width : bounds.height) : 2400;
    const next = {
      ...sizesRef.current,
      [side]: Math.round(Math.min(Math.max(120, size), Math.max(120, available * 0.75))),
    };
    sizesRef.current = next;
    setSizes(next);
    if (persist) saveSizes(next);
  };
  return (
    <div
      ref={root}
      className={clsx(styles.layout, shown && styles[side])}
      style={{ "--chat-pane-size": `${sizes[side]}px` } as CSSProperties}
      data-chat-side={shown ? side : undefined}
    >
      <div className={styles.editor}>{children}</div>
      <div
        className={styles.resize}
        hidden={!shown}
        role="separator"
        tabIndex={0}
        aria-label={tx("Resize conversation pane")}
        aria-orientation={vertical ? "vertical" : "horizontal"}
        aria-valuemin={120}
        aria-valuemax={2400}
        aria-valuenow={sizes[side]}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          const bounds = pane.current?.getBoundingClientRect();
          drag.current = {
            start: vertical ? event.clientX : event.clientY,
            size: bounds ? (vertical ? bounds.width : bounds.height) : sizes[side],
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          const delta = (vertical ? event.clientX : event.clientY) - drag.current.start;
          resize(drag.current.size + delta * resizeDirection);
        }}
        onPointerUp={(event) => {
          if (!drag.current) return;
          drag.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
          saveSizes(sizesRef.current);
        }}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
        onDoubleClick={() => resize(DEFAULT_SIZES[side], true)}
        onKeyDown={(event) => {
          if (event.altKey || event.ctrlKey || event.metaKey) return;
          const delta = vertical
            ? event.key === "ArrowLeft"
              ? -20
              : event.key === "ArrowRight"
                ? 20
                : 0
            : event.key === "ArrowUp"
              ? -20
              : event.key === "ArrowDown"
                ? 20
                : 0;
          if (!delta) return;
          event.preventDefault();
          event.stopPropagation();
          resize(sizes[side] + delta * resizeDirection, true);
        }}
      />
      <section ref={pane} className={styles.chat} hidden={!shown} aria-label={tx("Agent Chat")}>
        <div className={styles.header}>
          <span
            className={styles.title}
            title={home ? tx("New Agent Task") : (title ?? undefined)}
            onPointerDown={(event) => {
              if (task && !home) startPointerDrag(event, event.currentTarget, { type: TASK_DRAG, payload: task });
            }}
          >
            {home ? tx("New Agent Task") : title}
          </span>
          <IconButton icon="plus" action="agents.newTask" size="small" />
          <IconButton
            ref={menuAnchor}
            icon="more"
            title="Conversation options"
            size="small"
            aria-haspopup="menu"
            aria-expanded={menuOpen && shown}
            onClick={() => setMenuOpen((open) => !open)}
          />
          <IconButton icon="minus" action="agents.closeChatPane" size="small" />
          <Menu
            open={shown && menuOpen}
            onClose={() => setMenuOpen(false)}
            anchor={menuAnchor}
            items={menuOpen ? [chatPlacementMenu(home ? undefined : (task ?? undefined))] : []}
            aria-label="Conversation options"
            placement="bottom-end"
          />
        </div>
        <div className={styles.body}>
          <EditorShownProvider value={shown}>
            <ToolWindowShownProvider value={shown}>
              {shown &&
                (home ? (
                  <HomeEditor docked />
                ) : (
                  task && (
                    <SessionEditor
                      docked
                      input={{ kind: SESSION_KIND, key: sessionKey(task), data: { task, title } }}
                    />
                  )
                ))}
            </ToolWindowShownProvider>
          </EditorShownProvider>
        </div>
      </section>
    </div>
  );
}
