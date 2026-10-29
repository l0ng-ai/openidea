import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useTxTemplate } from "@/platform/i18n";
import { EmptyState, IconButton, Toast, T } from "@/ui";
import { NORMAL } from "@/ui/motion";
import {
  balloonTimeout,
  canSuppress,
  clearNotifications,
  dismissBalloon,
  markAllNotificationsRead,
  removeNotification,
  suppressGroup,
  useNotifications,
  type IdeNotification,
} from "./notificationStore";
import { useToolWindowLayout } from "./toolwindows/store";
import styles from "./Notifications.module.css";

const MAX_BALLOONS = 3;

function timeLabel(t: number) {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function subscribeWindowFocus(onChange: () => void) {
  window.addEventListener("focus", onChange);
  window.addEventListener("blur", onChange);
  return () => {
    window.removeEventListener("focus", onChange);
    window.removeEventListener("blur", onChange);
  };
}

/** Whether the app window is active (focused). */
function useWindowActive(): boolean {
  return useSyncExternalStore(
    subscribeWindowFocus,
    () => document.hasFocus(),
    () => true,
  );
}

const DONT_SHOW_AGAIN = "Don't Show Again";

/** The notification's own actions, then "Don't Show Again" for its group (IDEA). */
export function notificationActions(n: IdeNotification, wrap: (run: () => void) => () => void = (r) => r) {
  const own = n.actions ?? [];
  if (!canSuppress(n)) return own;
  return [...own, { label: DONT_SHOW_AGAIN, run: wrap(() => void suppressGroup(n.group).catch(() => {})) }];
}

function Balloon({ n }: { n: IdeNotification }) {
  const [hover, setHover] = useState(false);
  const active = useWindowActive();
  const remaining = useRef<number | null>(null);
  const txt = useTxTemplate();
  const ms = balloonTimeout(n);
  // IDEA's smart fade-out: the clock runs only while the window is active and the balloon not hovered.
  useEffect(() => {
    if (ms === null || hover || !active) return;
    const left = remaining.current ?? ms;
    const start = Date.now();
    const t = setTimeout(() => dismissBalloon(n.id), left);
    return () => {
      clearTimeout(t);
      remaining.current = Math.max(1, left - (Date.now() - start));
    };
  }, [n.id, ms, hover, active]);
  return (
    <Toast
      level={n.level}
      title={txt(n.title)}
      body={n.body}
      actions={notificationActions(n).map((a) => ({
        label: txt(a.label),
        run: () => {
          dismissBalloon(n.id);
          a.run();
        },
      }))}
      onClose={() => dismissBalloon(n.id)}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
    />
  );
}

const BALLOON_HIDDEN = { opacity: 0, x: 12 };

/** Bottom-right balloon stack (newest at the bottom); hidden while the Notifications tool window is open. */
export function Balloons() {
  const items = useNotifications((s) => s.items);
  const listOpen = useListVisible();
  const balloons = items
    .filter((n) => n.balloon)
    .slice(0, MAX_BALLOONS)
    .reverse();
  if (listOpen) return null;
  return (
    <div className={styles.stack} aria-live="polite">
      {/* popLayout: the balloons left behind slide into place while one fades out. */}
      <AnimatePresence mode="popLayout" initial={false}>
        {balloons.map((n) => (
          <motion.div
            key={n.id}
            layout="position"
            className={styles.balloon}
            initial={BALLOON_HIDDEN}
            animate={{ opacity: 1, x: 0 }}
            exit={BALLOON_HIDDEN}
            transition={NORMAL}
          >
            <Balloon n={n} />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

export const NOTIFICATIONS_TOOL_WINDOW = "notifications";

function useListVisible() {
  return useToolWindowLayout((s) => Object.values(s.visible).includes(NOTIFICATIONS_TOOL_WINDOW));
}

/** The Notifications tool window (right stripe, as in IDEA): history, newest first. */
export function NotificationsToolWindow() {
  const txt = useTxTemplate();
  const all = useNotifications((s) => s.items);
  const items = all.filter((n) => n.logged);
  const visible = useListVisible();
  const unread = all.some((n) => !n.read || n.balloon);
  useEffect(() => {
    if (visible && unread) markAllNotificationsRead();
  }, [visible, unread]);
  return (
    <div className={styles.list} data-autofocus="" tabIndex={-1}>
      {items.length === 0 ? (
        <EmptyState icon="bell">
          <T>No notifications</T>
        </EmptyState>
      ) : (
        items.map((n) => (
          <Toast
            key={n.id}
            className={styles.entry}
            level={n.level}
            title={txt(n.title)}
            body={n.body}
            meta={timeLabel(n.time)}
            actions={notificationActions(n).map((a) => ({ ...a, label: txt(a.label) }))}
            onClose={() => removeNotification(n.id)}
          />
        ))
      )}
    </div>
  );
}

export function NotificationsHeaderActions() {
  const count = useNotifications((s) => s.items.filter((n) => n.logged).length);
  return (
    <IconButton
      icon="trash"
      title="Clear All"
      size="small"
      iconSize={16}
      disabled={!count}
      onClick={clearNotifications}
    />
  );
}

/** Unread count on the Notifications stripe button. */
export function useUnreadNotifications(): number {
  return useNotifications((s) => s.items.filter((n) => !n.read && n.logged).length);
}
