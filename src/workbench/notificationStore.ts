/** Notification center: balloons + history, backing `NotificationService`. */
import type { ReactNode } from "react";
import { create } from "zustand";
import { call, commands, onIdeEvent } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import type { NotificationService } from "./contributions";

export type NotificationLevel = "info" | "warning" | "error";

export interface IdeNotification {
  id: number;
  key?: string;
  level: NotificationLevel;
  title: string;
  body?: ReactNode;
  actions?: Array<{ label: string; run: () => void }>;
  time: number;
  read: boolean;
  /** Currently shown as a balloon. */
  balloon: boolean;
  sticky: boolean;
  group: string;
  /** Listed in the Notifications tool window (the group's "Show in tool window"). */
  logged: boolean;
}

/** Notification groups shown in Settings › Appearance & Behavior › Notifications. */
export const NOTIFICATION_GROUPS: ReadonlyArray<{ id: string; title: string }> = [
  { id: "system", title: "System Messages" },
  { id: "lsp", title: "Language Servers" },
  { id: "vcs", title: "Version Control" },
  { id: "run", title: "Run and Debug" },
  { id: "tools", title: "External Tools" },
  { id: "search", title: "Find in Files" },
  { id: "plugins", title: "Plugins" },
  { id: "updates", title: "IDE Updates" },
  { id: "distractionFree", title: "Distraction Free Mode" },
];

export type NotificationDisplay = "balloon" | "sticky" | "none";

interface NotificationPrefs {
  balloons: boolean;
  sound: boolean;
  display: NotificationDisplay;
  log: boolean;
}

/** Settings › Notifications for one group (raw settings: the shell does not depend on the settings feature). */
export function notificationPrefs(group: string): NotificationPrefs {
  const n = useProject.getState().settings?.notifications;
  const g = n?.groups?.[group];
  const display = g?.display === "sticky" || g?.display === "none" ? g.display : "balloon";
  return { balloons: n?.balloons !== false, sound: n?.sound === true, display, log: g?.log !== false };
}

/** Errors always show; other notifications offer "Don't Show Again" for their group. */
export function canSuppress(n: Pick<IdeNotification, "level" | "group">): boolean {
  return n.level !== "error" && notificationPrefs(n.group).display !== "none";
}

/**
 * "Don't Show Again": the group's balloons are turned off (Settings ›
 * Notifications › "No popup"); its notifications are still logged.
 */
export async function suppressGroup(group: string): Promise<void> {
  const groups = { ...(useProject.getState().settings?.notifications?.groups ?? {}) };
  groups[group] = { ...(groups[group] ?? {}), display: "none", log: groups[group]?.log ?? true };
  const settings = await call(commands.settingsSet("global", "notifications.groups", JSON.stringify(groups)));
  useProject.setState({ settings });
  useNotifications.setState((s) => ({
    items: s.items.flatMap((x) => (x.group !== group || !x.balloon ? [x] : x.logged ? [{ ...x, balloon: false }] : [])),
  }));
}

function groupOf(n: { group?: string; key?: string }): string {
  if (n.group) return n.group;
  if (n.key?.startsWith("app.update")) return "updates";
  if (n.key?.startsWith("lsp")) return "lsp";
  return "system";
}

let audio: AudioContext | null = null;

/** Short notification chime ("Play sound"). */
function playSound() {
  try {
    audio ??= new AudioContext();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.08, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.25);
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 0.25);
  } catch {
    /* no audio output */
  }
}

interface NotificationState {
  items: IdeNotification[];
}

export const useNotifications = create<NotificationState>(() => ({ items: [] }));

/** IDEA fades balloons out after 10 s; errors are sticky balloons (as IDEA's error groups). */
export const BALLOON_TIMEOUT: Record<NotificationLevel, number | null> = { info: 10000, warning: 10000, error: null };
/**
 * Sticky balloons fade too, after 5 minutes of active window time, as in IDEA:
 * the notification stays unread in the Notifications tool window. One that the
 * tool window does not list stays until dismissed.
 */
export const STICKY_BALLOON_TIMEOUT = 5 * 60 * 1000;

/** Fade-out delay of a balloon, or null when it stays until dismissed. */
export function balloonTimeout(n: Pick<IdeNotification, "level" | "sticky" | "logged">): number | null {
  if (n.sticky || BALLOON_TIMEOUT[n.level] === null) return n.logged ? STICKY_BALLOON_TIMEOUT : null;
  return BALLOON_TIMEOUT[n.level];
}
const MAX_HISTORY = 200;
let seq = 0;

export function notify(n: Parameters<NotificationService["notify"]>[0]): number {
  const id = ++seq;
  const group = groupOf(n);
  const prefs = notificationPrefs(group);
  const balloon = prefs.balloons && prefs.display !== "none";
  const sticky = prefs.display === "sticky" || (n.sticky ?? BALLOON_TIMEOUT[n.level] === null);
  // Neither shown nor listed: dropped, as IDEA's "No popup" + no log.
  if (!balloon && !prefs.log) return id;
  const item: IdeNotification = {
    id,
    key: n.key,
    level: n.level,
    title: n.title,
    body: n.body,
    actions: n.actions,
    time: Date.now(),
    read: false,
    balloon,
    sticky,
    group,
    logged: prefs.log,
  };
  useNotifications.setState((s) => {
    const rest = n.key ? s.items.filter((x) => x.key !== n.key) : s.items;
    return { items: [item, ...rest].slice(0, MAX_HISTORY) };
  });
  if (balloon && prefs.sound) playSound();
  return id;
}

export function dismissBalloon(id: number) {
  useNotifications.setState((s) => ({
    // Unlogged notifications only existed for their balloon.
    items: s.items.flatMap((x) => (x.id !== id ? [x] : x.logged ? [{ ...x, balloon: false }] : [])),
  }));
}

/** Hides the balloon for `key`: the condition it reported no longer holds. */
export function expireNotification(key: string) {
  useNotifications.setState((s) => ({
    items: s.items.flatMap((x) => (x.key !== key || !x.balloon ? [x] : x.logged ? [{ ...x, balloon: false }] : [])),
  }));
}

export function removeNotification(id: number) {
  useNotifications.setState((s) => ({ items: s.items.filter((x) => x.id !== id) }));
}

export function clearNotifications() {
  useNotifications.setState({ items: [] });
}

/** The list was seen: everything is read and no longer shown as a balloon. */
export function markAllNotificationsRead() {
  useNotifications.setState((s) => ({
    items: s.items
      .filter((x) => x.logged)
      .map((x) => (x.read && !x.balloon ? x : { ...x, read: true, balloon: false })),
  }));
}

export const notificationServiceImpl: NotificationService = {
  notify: (n) => void notify(n),
  expire: expireNotification,
};

export function installNotifyEvents(): () => void {
  return onIdeEvent("notify", (e) => void notify({ level: e.level, title: e.title, body: e.body ?? undefined }));
}
