import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { executeAction } from "@/platform/actions";
import { useTx } from "@/platform/i18n";
import { refreshWindowGroup, reorderedTabs, useWindowGroup } from "@/platform/windowGroups";
import { dropIndex, IconButton, registerDropTarget, showContextMenu, startPointerDrag } from "@/ui";
import { notifications } from "./contributions";
import { subscribeTabColors, tabColorOverride, tabColorVars, tabColorsVersion } from "./tabColors";
import styles from "./WindowGroupTabs.module.css";

const PROJECT_TAB_DRAG = "application/x-openidea-project-tab";

/**
 * Resolves an insertion slot (`0..count`) into a tab index to move `fromIndex`
 * onto, or `null` when dropping there would leave the order unchanged.
 */
export function projectTabDropTarget(fromIndex: number, insertionIndex: number): number | null {
  if (fromIndex < 0 || insertionIndex === fromIndex || insertionIndex === fromIndex + 1) return null;
  return insertionIndex > fromIndex ? insertionIndex - 1 : insertionIndex;
}

function run(work: Promise<unknown>) {
  void work.catch((e) =>
    notifications().notify({
      level: "error",
      title: "Window group",
      body: String(e),
    }),
  );
}

export function WindowGroupTabs() {
  const tabs = useWindowGroup((state) => state.tabs);
  useSyncExternalStore(subscribeTabColors, tabColorsVersion);
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<number | null>(null);
  const tx = useTx();
  const bar = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  const cancelDrag = useRef<(() => void) | undefined>(undefined);
  const dragEnded = useRef(false);
  const latestTabs = useRef(tabs);
  useLayoutEffect(() => {
    latestTabs.current = tabs;
  });
  const grouped = tabs.length > 1;

  useEffect(() => () => cancelDrag.current?.(), [grouped]);

  useEffect(() => {
    const el = bar.current;
    if (!el || !grouped) return;
    const insertionAt = (sourceLabel: string, x: number, y: number): number | null => {
      const current = latestTabs.current;
      const fromIndex = current.findIndex((t) => t.label === sourceLabel);
      if (fromIndex < 0) return null;
      const rects = current.map((t) => {
        const r = itemRefs.current.get(t.label)?.getBoundingClientRect();
        return { left: r?.left ?? 0, top: r?.top ?? 0, width: r?.width ?? 0, height: r?.height ?? 0 };
      });
      const at = dropIndex(x, y, rects);
      return projectTabDropTarget(fromIndex, at) === null ? null : at;
    };
    return registerDropTarget(el, {
      accepts: (type) => type === PROJECT_TAB_DRAG,
      over: (data, x, y) => setDrop(insertionAt(data.payload, x, y)),
      leave: () => setDrop(null),
      drop: (data, x, y) => {
        const at = insertionAt(data.payload, x, y);
        setDrop(null);
        if (at === null) return;
        const current = latestTabs.current;
        const fromIndex = current.findIndex((t) => t.label === data.payload);
        const targetIndex = projectTabDropTarget(fromIndex, at);
        if (targetIndex === null) return;
        const targetLabel = current[targetIndex]?.label;
        if (!targetLabel) return;
        const nextLabels = reorderedTabs(current, data.payload, targetLabel);
        const byLabel = new Map(current.map((t) => [t.label, t]));
        useWindowGroup.setState({ tabs: nextLabels.map((l) => byLabel.get(l)!) });
        run(
          executeAction("window.reorderTabs", nextLabels).catch((err) => {
            void refreshWindowGroup();
            throw err;
          }),
        );
      },
    });
  }, [grouped]);

  useLayoutEffect(() => {
    const element = bar.current;
    if (!element) return;
    const frame = element.parentElement;
    if (!frame) return;
    const update = () => {
      for (const side of ["left", "right"]) {
        const stripe = frame.querySelector(`[data-stripe-side="${side}"]`);
        element.style.setProperty(
          `--window-tabs-${side}`,
          stripe ? `${stripe.getBoundingClientRect().width}px` : "var(--island-gap)",
        );
      }
    };
    const resize = new ResizeObserver(update);
    const observe = () => {
      resize.disconnect();
      frame.querySelectorAll("[data-stripe-side]").forEach((stripe) => resize.observe(stripe));
      update();
    };
    const children = new MutationObserver(observe);
    children.observe(frame, { childList: true, subtree: true });
    observe();
    return () => {
      resize.disconnect();
      children.disconnect();
    };
  }, [grouped]);

  if (tabs.length < 2) return null;
  return (
    <div ref={bar} className={styles.bar} data-window-group>
      <div
        className={styles.tabs}
        role="tablist"
        aria-label={tx("Project windows")}
        data-dragging={dragging ? "" : undefined}
      >
        {tabs.map((tab, index) => (
          <div
            ref={(el) => {
              if (el) itemRefs.current.set(tab.label, el);
              else itemRefs.current.delete(tab.label);
            }}
            className={`${styles.item} ${tab.current ? styles.selected : ""} ${dragging === tab.label ? styles.dragging : ""} ${drop === index ? styles.dropBefore : ""} ${drop === tabs.length && index === tabs.length - 1 ? styles.dropAfter : ""}`}
            key={tab.label}
            data-project-tab={tab.label}
            data-tinted={tab.root && tabColorOverride(tab.root) ? "" : undefined}
            style={tabColorVars(tab.name, tab.root ? tabColorOverride(tab.root) : null) as CSSProperties}
            onPointerDown={(e) => {
              if (!(e.target as Element).closest('[role="tab"]')) return;
              cancelDrag.current = startPointerDrag(
                e,
                e.currentTarget,
                { type: PROJECT_TAB_DRAG, payload: tab.label },
                {
                  ghostContext: styles.tabs,
                  onStart: () => setDragging(tab.label),
                  onEnd: (dragged) => {
                    cancelDrag.current = undefined;
                    setDragging(null);
                    setDrop(null);
                    if (!dragged) return;
                    dragEnded.current = true;
                    window.setTimeout(() => {
                      dragEnded.current = false;
                    }, 0);
                  },
                },
              );
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              showContextMenu(e, [
                {
                  label: "Move Tab to New Window",
                  run: () => executeAction("window.detachTab", tab.label),
                },
                {
                  label: tx("Change Project Color…"),
                  run: () => executeAction("window.setTabColor", tab.label),
                },
                { kind: "separator" },
                {
                  label: "Close Tab",
                  run: () => executeAction("window.closeTab", tab.label),
                },
                {
                  label: "Close Other Tabs",
                  run: () => executeAction("window.closeOtherTabs", tab.label),
                },
                {
                  label: "Close Tabs to the Left",
                  disabled: index <= 0,
                  run: () => executeAction("window.closeTabsToLeft", tab.label),
                },
                {
                  label: "Close Tabs to the Right",
                  disabled: index >= tabs.length - 1,
                  run: () => executeAction("window.closeTabsToRight", tab.label),
                },
              ]);
            }}
          >
            <button
              className={styles.tab}
              role="tab"
              aria-selected={tab.current}
              tabIndex={tab.current ? 0 : -1}
              title={tab.root ?? tab.name}
              onClick={() => {
                if (!dragEnded.current) run(executeAction("window.selectTab", tab.label));
              }}
              onKeyDown={(e) => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
                e.preventDefault();
                const next =
                  e.key === "Home"
                    ? 0
                    : e.key === "End"
                      ? tabs.length - 1
                      : (index + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
                run(executeAction("window.selectTab", tabs[next]!.label));
              }}
            >
              <span>{tab.name}</span>
            </button>
            <IconButton
              icon="close"
              size="small"
              className={styles.close}
              title={tx`Close ${tab.name}`}
              onClick={() => run(executeAction("window.closeTab", tab.label))}
            />
            <IconButton
              icon="external-link"
              size="small"
              className={styles.detach}
              title={tx`Move ${tab.name} to New Window`}
              onClick={() => run(executeAction("window.detachTab", tab.label))}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
