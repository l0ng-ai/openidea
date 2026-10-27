/**
 * Distraction Free Mode (View › Appearance), IDEA semantics: tool windows,
 * stripes, main toolbar contents, status bar, editor tabs, breadcrumbs and
 * the editor gutter are hidden and the text column is centred at Settings ›
 * Editor › General › Appearance "Distraction free mode text width". The same
 * action enters and exits; Esc does not exit. Like IDEA the mode is an
 * application-wide preference that survives restarts (localStorage, next to
 * the saved tool window layouts, which keep the layout to restore on exit).
 * Published as the `distractionFree` context key; components read
 * `useDistractionFree`. Entering (or starting in) the mode shows IDEA's hint
 * on how to leave it, since the main toolbar and status bar are gone.
 */
import { create } from "zustand";
import { registerAction, type Action } from "@/platform/actions";
import { setContext } from "@/platform/context";
import { shortcutLabel } from "@/platform/keymap";
import { expireNotification, notify } from "./notificationStore";
import { enterDistractionFreeLayout, exitDistractionFreeLayout, useToolWindowLayout } from "./toolwindows/store";

/** Kept from the original id so keymaps (VS Code's ⌘K Z, user bindings) stay bound. */
export const DISTRACTION_FREE_ACTION = "editor.toggleZen";
export const DISTRACTION_FREE_CONTEXT = "distractionFree";
export const DEFAULT_DISTRACTION_FREE_WIDTH = 80;
const STORAGE_KEY = "openidea.distractionFree";
export const DISTRACTION_FREE_HINT_KEY = "distractionFree.hint";

export const useDistractionFree = create<{ active: boolean }>(() => ({ active: false }));

export function isDistractionFree(): boolean {
  return useDistractionFree.getState().active;
}

/** Text width in columns (Settings › Editor › General › Appearance), clamped like IDEA's field. */
export function distractionFreeWidth(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw)
    ? Math.min(500, Math.max(20, Math.round(raw)))
    : DEFAULT_DISTRACTION_FREE_WIDTH;
}

export function distractionFreeTitle(active: boolean): string {
  return active ? "Exit Distraction Free Mode" : "Enter Distraction Free Mode";
}

function writeStored(active: boolean) {
  try {
    if (active) localStorage.setItem(STORAGE_KEY, "1");
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable */
  }
}

function readStored(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** IDEA's "To exit Distraction Free Mode, use View | Appearance or <shortcut>". */
export function distractionFreeHint(): string {
  const own = shortcutLabel(DISTRACTION_FREE_ACTION);
  const find = shortcutLabel("navigate.findAction");
  const way = own ?? (find ? `Find Action (${find})` : "Find Action");
  return `To exit Distraction Free Mode, use View | Appearance | Exit Distraction Free Mode or ${way}.`;
}

/** Set on entering the mode; the hint shows once a project frame is there to leave. */
let hintPending = false;

function showHint() {
  if (!hintPending || !isDistractionFree() || !useToolWindowLayout.getState().scope) return;
  hintPending = false;
  notify({
    key: DISTRACTION_FREE_HINT_KEY,
    // Its own group: the balloon's "Don't Show Again" turns off this hint only (Settings › Notifications).
    group: "distractionFree",
    level: "info",
    title: "Distraction Free Mode",
    body: distractionFreeHint(),
    actions: [{ label: "Exit Distraction Free Mode", run: () => setDistractionFree(false) }],
  });
}

export function setDistractionFree(active: boolean) {
  if (active === isDistractionFree()) return;
  useDistractionFree.setState({ active });
  setContext(DISTRACTION_FREE_CONTEXT, active);
  writeStored(active);
  hintPending = active;
  if (active) enterDistractionFreeLayout();
  else exitDistractionFreeLayout();
  if (active) showHint();
  else expireNotification(DISTRACTION_FREE_HINT_KEY);
}

export function toggleDistractionFree() {
  setDistractionFree(!isDistractionFree());
}

function action(active: boolean): Action {
  return {
    id: DISTRACTION_FREE_ACTION,
    title: distractionFreeTitle(active),
    category: "View",
    keywords: ["zen", "distraction free", "toggle distraction free mode"],
    run: toggleDistractionFree,
  };
}

/**
 * Registers the action (its title follows the mode, like IDEA's
 * Enter / Exit Distraction Free Mode), restores the saved mode
 * and re-applies the hidden tool window layout when a project's layout loads.
 */
export function installDistractionFree(): () => void {
  let dispose = registerAction(action(isDistractionFree()));
  const unsubMode = useDistractionFree.subscribe((s, prev) => {
    if (s.active === prev.active) return;
    const previous = dispose;
    dispose = registerAction(action(s.active));
    previous();
  });
  const unsubLayout = useToolWindowLayout.subscribe((s, prev) => {
    if (s.scope === prev.scope || !isDistractionFree()) return;
    enterDistractionFreeLayout();
    showHint();
  });
  setContext(DISTRACTION_FREE_CONTEXT, isDistractionFree());
  if (readStored()) setDistractionFree(true);
  return () => {
    unsubMode();
    unsubLayout();
    dispose();
  };
}

/** Test helper. */
export function resetDistractionFree() {
  hintPending = false;
  useDistractionFree.setState({ active: false });
  setContext(DISTRACTION_FREE_CONTEXT, false);
  writeStored(false);
}
