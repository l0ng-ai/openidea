import { useLayoutEffect, useRef, useState } from "react";
import { executeAction } from "@/platform/actions";
import { useTx } from "@/platform/i18n";
import { reorderedTabs, useWindowGroup } from "@/platform/windowGroups";
import { IconButton, showContextMenu } from "@/ui";
import { notifications } from "./contributions";
import styles from "./WindowGroupTabs.module.css";

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
  const drag = useRef<{ label: string; x: number; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const tx = useTx();
  const bar = useRef<HTMLDivElement>(null);
  const grouped = tabs.length > 1;
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
      <div className={styles.tabs} role="tablist" aria-label={tx("Project windows")}>
        {tabs.map((tab) => (
          <div
            className={`${styles.item} ${tab.current ? styles.selected : ""} ${dragging === tab.label ? styles.dragging : ""}`}
            key={tab.label}
            data-project-tab={tab.label}
            onPointerDown={(e) => {
              drag.current = null;
              if (e.button === 0 && (e.target as Element).closest('[role="tab"]'))
                drag.current = { label: tab.label, x: e.clientX, moved: false };
            }}
            onPointerMove={(e) => {
              if (drag.current && !(e.buttons & 1)) drag.current = null; // reordered macOS tap, not a drag
              if (drag.current && Math.abs(e.clientX - drag.current.x) > 5) {
                drag.current.moved = true;
                e.currentTarget.setPointerCapture(e.pointerId);
                setDragging(tab.label);
              }
            }}
            onPointerUp={(e) => {
              const source = drag.current;
              if (source?.moved) {
                const target = document
                  .elementFromPoint(e.clientX, e.clientY)
                  ?.closest<HTMLElement>("[data-project-tab]")?.dataset.projectTab;
                if (target) run(executeAction("window.reorderTabs", reorderedTabs(tabs, source.label, target)));
              }
              setDragging(null);
              // Keep the moved flag through the click following pointerup.
              if (!source?.moved) drag.current = null;
            }}
            onPointerCancel={() => {
              drag.current = null;
              setDragging(null);
            }}
            onClickCapture={(e) => {
              if (drag.current?.moved) {
                e.preventDefault();
                e.stopPropagation();
                drag.current = null;
              }
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              const index = tabs.indexOf(tab);
              showContextMenu(e, [
                {
                  label: "Move Tab to New Window",
                  run: () => executeAction("window.detachTab", tab.label),
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
              onClick={() => run(executeAction("window.selectTab", tab.label))}
              onKeyDown={(e) => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
                e.preventDefault();
                const index = tabs.indexOf(tab);
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
