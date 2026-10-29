/**
 * Keymaps and keyboard dispatch.
 *
 * Binding syntax: modifiers `Meta Ctrl Alt Shift` joined with `+` to a key, e.g.
 * `Meta+Shift+O`, `Alt+F7`, `F8`. Space separates chord strokes
 * (`Meta+K Meta+C`). A modifier pressed twice is `Shift Shift` (IDEA's double
 * Shift, `Ctrl Ctrl`…); pressed twice and held, then a key, `Alt Alt+Up`.
 * Keys are matched by physical position (`KeyboardEvent.code`), so ⌥-letter
 * combos work on macOS where `event.key` would be a symbol. Mouse shortcuts
 * name the button 1-based (`Button4` = back side button, `Button5` = forward),
 * optionally with modifiers (`Alt+Button4`); they are single strokes.
 */
import { create } from "zustand";
import { getAction, isActionKeyEnabled, executeAction } from "./actions";
import { getContext } from "./context";
import { intellijMacos } from "./keymaps/intellij-macos";
import { intellijWindows } from "./keymaps/intellij-windows";
import { eclipseMacos } from "./keymaps/eclipse-macos";
import { eclipseWindows } from "./keymaps/eclipse-windows";
import { vscodeMacos } from "./keymaps/vscode-macos";
import { vscodeWindows } from "./keymaps/vscode-windows";
import { usePlatform } from "./platformInfo";
import { isImeKey } from "./ime";

export type Keymap = Record<string, string[]>;

/** macOS spells the primary modifier ⌘ (`Meta`); Windows and Linux use Ctrl. */
export const isMacHost = () => usePlatform.getState().os === "macos";

/** The preset used when settings name none (or an unknown one): IDEA's keymap for this OS. */
export function defaultPreset(): string {
  return isMacHost() ? "intellij-macos" : "intellij-windows";
}

export const PRESETS: Record<string, Keymap> = {
  "intellij-macos": intellijMacos,
  "intellij-windows": intellijWindows,
  "vscode-macos": vscodeMacos,
  "vscode-windows": vscodeWindows,
  "eclipse-macos": eclipseMacos,
  "eclipse-windows": eclipseWindows,
};

/** Display names of the presets, in menu order. */
export const PRESET_TITLES: Record<string, string> = {
  "intellij-macos": "macOS",
  "intellij-windows": "Windows",
  "vscode-macos": "VS Code (macOS)",
  "vscode-windows": "VS Code (Windows)",
  "eclipse-macos": "Eclipse (macOS)",
  "eclipse-windows": "Eclipse",
};

/** ⌘ held on macOS, Ctrl elsewhere: the modifier of ⌘/Ctrl-click and copy/paste. */
export function hasPrimaryModifier(e: Pick<KeyboardEvent, "metaKey" | "ctrlKey">): boolean {
  return isMacHost() ? e.metaKey : e.ctrlKey;
}

/** A binding written for macOS (`Meta+C`) as this OS spells it (`Ctrl+C` on Windows/Linux). */
export function hostBinding(binding: string): string {
  return isMacHost() ? binding : binding.replace(/Meta\+/g, "Ctrl+");
}

/** `strokeOf` output in macOS spelling, so tables keyed `Meta+C` also match Ctrl+C on Windows/Linux. */
export function macStroke(stroke: string): string {
  return isMacHost() ? stroke : normalizeBinding(stroke.replace(/Ctrl\+/g, "Meta+"));
}

interface KeymapState {
  preset: string;
  /** User overrides: action id → bindings (empty array removes defaults). */
  overrides: Keymap;
}

export const useKeymap = create<KeymapState>(() => ({ preset: defaultPreset(), overrides: {} }));

const MOUSE_KEY_RE = /^Button(\d+)$/i;

/** A mouse shortcut (`Button4`, `Shift+Button5`) rather than a keystroke. */
export function isMouseBinding(binding: string): boolean {
  const b = binding.trim();
  return !/\s/.test(b) && MOUSE_KEY_RE.test(b.split("+").pop()!);
}

/**
 * The mouse stroke of a press of a non-primary button: DOM `button` 3 / 4
 * (back / forward side buttons) → `Button4` / `Button5`. Left, middle and
 * right buttons have their own meaning everywhere, so they are not shortcuts.
 */
export function mouseStrokeOf(
  e: Pick<MouseEvent, "button" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
): string | null {
  if (!Number.isInteger(e.button) || e.button < 3) return null;
  const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Meta"].filter(Boolean);
  return [...mods, `Button${e.button + 1}`].join("+");
}

const STROKE_RE = /^(?:(?:Ctrl|Alt|Shift|Meta)\+)*[^\s+]+$|^(?:(?:Ctrl|Alt|Shift|Meta)\+)*\+$/i;

const MODIFIERS = ["Ctrl", "Alt", "Shift", "Meta"] as const;
export type Modifier = (typeof MODIFIERS)[number];
const DOUBLE_RE = /^(Ctrl|Alt|Shift|Meta) (Ctrl|Alt|Shift|Meta)(?:\+([^\s+]+|\+))?$/i;
const modifierNamed = (name: string) => MODIFIERS.find((m) => m.toLowerCase() === name.toLowerCase())!;

/** A double-modifier gesture: `Shift Shift` (key null) or `Alt Alt+Up`. */
export function parseDoubleModifier(binding: string): { modifier: Modifier; key: string | null } | null {
  const m = DOUBLE_RE.exec(binding.trim());
  if (!m || m[1]!.toLowerCase() !== m[2]!.toLowerCase()) return null;
  const key = m[3] ?? null;
  return { modifier: modifierNamed(m[1]!), key: key && key.length === 1 ? key.toUpperCase() : key };
}

/** Syntactic check: one or two strokes of `Mod+…+Key`, or a double-modifier gesture. */
export function isValidBinding(binding: unknown): binding is string {
  if (typeof binding !== "string") return false;
  const b = binding.trim();
  if (parseDoubleModifier(b)) return true;
  const strokes = b.split(/\s+/);
  return strokes.length >= 1 && strokes.length <= 2 && strokes.every((s) => STROKE_RE.test(s));
}

/**
 * Applies keymap settings (preset id + per-action overrides) to `useKeymap`.
 * Input comes from settings files, so it is validated: an unknown preset falls
 * back to the default, malformed bindings are dropped.
 */
export function applyKeymapSettings(preset: unknown, overrides: unknown, customKeymaps?: unknown): void {
  // A user keymap (`customKeymaps[id]`) is its parent preset plus its own overrides.
  const custom =
    typeof preset === "string" && customKeymaps && typeof customKeymaps === "object"
      ? ((customKeymaps as Record<string, unknown>)[preset] as { parent?: unknown; overrides?: unknown } | undefined)
      : undefined;
  if (custom && typeof custom === "object" && !PRESETS[preset as string]) {
    preset = custom.parent;
    overrides = custom.overrides;
  }
  const id = typeof preset === "string" && PRESETS[preset] ? preset : defaultPreset();
  const clean: Keymap = {};
  if (overrides && typeof overrides === "object" && !Array.isArray(overrides)) {
    for (const [action, keys] of Object.entries(overrides as Record<string, unknown>)) {
      if (!Array.isArray(keys)) continue;
      clean[action] = [...new Set(keys.filter(isValidBinding).map(normalizeBinding))];
    }
  }
  const prev = useKeymap.getState();
  if (prev.preset === id && JSON.stringify(prev.overrides) === JSON.stringify(clean)) return;
  useKeymap.setState({ preset: id, overrides: clean });
}

let suspended = 0;

/**
 * Decides whether a keystroke belongs to the focused component rather than to
 * the IDE keymap (e.g. Vim mode's shortcut conflicts set to "Vim"). `stroke`
 * is the canonical first stroke (`Ctrl+R`).
 */
export type KeyClaim = (e: KeyboardEvent, stroke: string) => boolean;

const keyClaims = new Set<KeyClaim>();

/** Registers a key claim; the dispatcher leaves claimed keystrokes to their target. */
export function registerKeyClaim(claim: KeyClaim): () => void {
  keyClaims.add(claim);
  return () => void keyClaims.delete(claim);
}

function isClaimed(e: KeyboardEvent, stroke: string): boolean {
  for (const claim of keyClaims)
    try {
      if (claim(e, stroke)) return true;
    } catch (err) {
      console.error("key claim failed", err);
    }
  return false;
}

/**
 * Pauses the global keyboard dispatcher (e.g. while recording a shortcut).
 * Returns a function that resumes it; calls nest.
 */
export function suspendKeyboardDispatch(): () => void {
  suspended++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    suspended--;
  };
}

export function bindingsFor(actionId: string): string[] {
  const { preset, overrides } = useKeymap.getState();
  return overrides[actionId] ?? PRESETS[preset]?.[actionId] ?? [];
}

/** Every (binding, actionId) pair of the effective keymap. */
export function effectiveBindings(): Array<[string, string]> {
  const { preset, overrides } = useKeymap.getState();
  const merged: Keymap = { ...PRESETS[preset], ...overrides };
  return Object.entries(merged).flatMap(([id, keys]) => keys.map((k) => [normalizeBinding(k), id] as [string, string]));
}

const MOD_ORDER = MODIFIERS;

/** Canonical form: modifiers in fixed order, so `Shift+Meta+o` == `Meta+Shift+O`. */
export function normalizeBinding(binding: string): string {
  const double = parseDoubleModifier(binding);
  if (double) return `${double.modifier} ${double.modifier}${double.key ? `+${double.key}` : ""}`;
  return binding
    .trim()
    .split(/\s+/)
    .map((stroke) => {
      const parts = stroke.split("+");
      const key = parts.pop()!;
      const mods = MOD_ORDER.filter((m) => parts.some((p) => p.toLowerCase() === m.toLowerCase()));
      const mouse = MOUSE_KEY_RE.exec(key);
      return [...mods, mouse ? `Button${mouse[1]}` : key.length === 1 ? key.toUpperCase() : key].join("+");
    })
    .join(" ");
}

const CODE_NAMES: Record<string, string> = {
  Space: "Space",
  Enter: "Enter",
  NumpadEnter: "Enter",
  Escape: "Escape",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  NumpadAdd: "NumpadAdd",
  NumpadSubtract: "NumpadSubtract",
  NumpadMultiply: "NumpadMultiply",
  NumpadDivide: "NumpadDivide",
};

/**
 * The uppercase ASCII letter of a key event: the character it types when Alt
 * is not held (on AZERTY the Z key sits on the physical KeyW, so Ctrl+Z must
 * not read as Ctrl+W), or the physical `KeyX` when Alt is held (⌥ on macOS and
 * AltGr may type a symbol) or `e.key` is not an ASCII letter.
 */
export function letterOf(e: Pick<KeyboardEvent, "code" | "key"> & { altKey?: boolean }): string | null {
  if (/^[a-zA-Z]$/.test(e.key) && !e.altKey) return e.key.toUpperCase();
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3);
  return null;
}

/** Converts a keydown event into a canonical stroke, or null for bare modifiers. */
export function strokeOf(
  e: Pick<KeyboardEvent, "code" | "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
): string | null {
  let key: string | undefined;
  const letter = letterOf(e);
  if (letter) key = letter;
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (/^Numpad\d$/.test(e.code)) key = e.code.slice(6);
  else if (/^F\d{1,2}$/.test(e.code)) key = e.code;
  else key = CODE_NAMES[e.code];
  if (!key) {
    if (["Shift", "Meta", "Control", "Alt"].includes(e.key)) return null;
    key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  }
  const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Meta"].filter(Boolean);
  return [...mods, key].join("+");
}

const SYMBOLS: Record<string, string> = {
  Meta: "⌘",
  Ctrl: "⌃",
  Alt: "⌥",
  Shift: "⇧",
  Enter: "↵",
  Escape: "⎋",
  Tab: "⇥",
  Backspace: "⌫",
  Delete: "⌦",
  Up: "↑",
  Down: "↓",
  Left: "←",
  Right: "→",
  Space: "Space",
  PageUp: "⇞",
  PageDown: "⇟",
};

const KEY_LABELS: Record<string, string> = {
  NumpadAdd: "NumPad +",
  NumpadSubtract: "NumPad -",
  NumpadMultiply: "NumPad *",
  NumpadDivide: "NumPad /",
};

/**
 * Human display. macOS: `Meta+Shift+O` → `⇧⌘O`, `Shift Shift` → `⇧⇧`, `Alt Alt+Up` → `⌥⌥↑`.
 * Windows/Linux: `Ctrl+Shift+N`, chords as `Ctrl+K, Ctrl+I`, `Shift, Shift`, `Ctrl, Ctrl+Up`.
 */
export function formatBinding(binding: string, mac = isMacHost()): string {
  if (isMouseBinding(binding)) {
    const parts = normalizeBinding(binding).split("+");
    const button = `${parts.pop()} Click`;
    return mac ? parts.map((p) => SYMBOLS[p] ?? p).join("") + button : [...parts, button].join("+");
  }
  if (!mac)
    return normalizeBinding(binding)
      .split(" ")
      .map((stroke) => stroke.replace(/[^+]+$/, (key) => KEY_LABELS[key] ?? key))
      .join(", ");
  const double = parseDoubleModifier(binding);
  if (double) return SYMBOLS[double.modifier]!.repeat(2) + (double.key ? (SYMBOLS[double.key] ?? double.key) : "");
  return normalizeBinding(binding)
    .split(" ")
    .map((stroke) => {
      const parts = stroke.split("+");
      const key = parts.pop()!;
      // macOS menu order: ⌃⌥⇧⌘
      return parts.map((p) => SYMBOLS[p] ?? p).join("") + (SYMBOLS[key] ?? KEY_LABELS[key] ?? key);
    })
    .join(" ");
}

/** The first keyboard binding of an action: what menus and tooltips show. */
export function primaryKeyBinding(actionId: string): string | undefined {
  return bindingsFor(actionId).find((b) => !isMouseBinding(b));
}

export function shortcutLabel(actionId: string): string | undefined {
  const b = primaryKeyBinding(actionId);
  return b ? formatBinding(b) : undefined;
}

// ---------------------------------------------------------------------------
// Dispatcher

/** How long IDEA waits for the second stroke of a chord. */
const CHORD_TIMEOUT = 2000;
/** IDEA's double-modifier timing: each press/release step. */
const DOUBLE_TAP_STEP_MS = 300;
/** A modifier tap this soon after typing another key is part of typing, not a gesture. */
const DOUBLE_TAP_TYPING_GUARD_MS = 100;

const KEY_MODIFIER: Record<string, Modifier> = { Shift: "Shift", Control: "Ctrl", Alt: "Alt", Meta: "Meta" };

function modifierHeld(e: Pick<KeyboardEvent, "ctrlKey" | "altKey" | "shiftKey" | "metaKey">, m: Modifier): boolean {
  return m === "Ctrl" ? e.ctrlKey : m === "Alt" ? e.altKey : m === "Shift" ? e.shiftKey : e.metaKey;
}

const otherModifiers = (e: Pick<KeyboardEvent, "ctrlKey" | "altKey" | "shiftKey" | "metaKey">, m: Modifier) =>
  MODIFIERS.some((x) => x !== m && modifierHeld(e, x));

function isPlainTextField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  if (el.closest?.(".cm-editor")) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
}

function isTextTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return !!el.closest?.(".cm-editor") || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
}

/**
 * AltGr (reported as Ctrl+Alt on Windows) typing a character into a text field
 * or editor, e.g. `}` on a German or `ł` on a Polish layout: the character wins
 * over a Ctrl+Alt shortcut on the same key, as in IDEA.
 */
export function isAltGrTyping(
  e: Pick<KeyboardEvent, "key" | "code" | "target" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"> & {
    getModifierState?: (key: string) => boolean;
  },
): boolean {
  if (isMacHost() || !e.getModifierState?.("AltGraph")) return false;
  if (e.key !== "Dead" && e.key.length !== 1) return false;
  if (!isTextTarget(e.target)) return false;
  // Ctrl+Alt+L on a layout with no AltGr character there still reports `l`: that is a shortcut.
  const key = strokeOf(e)?.split("+").pop();
  return e.key === "Dead" || e.key.toUpperCase() !== key;
}

function runIfEnabled(id: string): boolean {
  const action = getAction(id);
  if (!action || !isActionKeyEnabled(action)) return false;
  void executeAction(id);
  return true;
}

/**
 * Installs the global keydown dispatcher (capture phase, so IDE shortcuts win
 * over CodeMirror defaults). Returns an uninstall function. `now` is the clock
 * for the double-modifier gestures.
 */
export function installKeyboardDispatcher(
  target: Window = window,
  now: () => number = () => performance.now(),
): () => void {
  let pending: string[] = [];
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Double modifier: step 1 pressed, 2 released, 3 pressed again. A bare
   * gesture (`Shift Shift`) fires on the second release; while the second
   * press is held, keys fire their `Alt Alt+Up` gestures.
   */
  let tap: { modifier: Modifier; step: 1 | 2 | 3; at: number; typed: boolean; keyUsed: boolean } | null = null;
  let otherKeyAt = -Infinity;

  const reset = () => {
    pending = [];
    clearTimeout(pendingTimer);
  };
  const resetTap = () => {
    tap = null;
  };

  const onModifierDown = (e: KeyboardEvent, modifier: Modifier) => {
    const t = now();
    if (e.repeat && tap?.step === 3 && tap.modifier === modifier) return;
    if (e.repeat || otherModifiers(e, modifier)) return resetTap();
    const typed = t - otherKeyAt < DOUBLE_TAP_TYPING_GUARD_MS;
    if (tap && (tap.modifier !== modifier || t - tap.at > DOUBLE_TAP_STEP_MS)) resetTap();
    if (!tap) tap = { modifier, step: 1, at: t, typed, keyUsed: false };
    else if (tap.step === 2) tap = { ...tap, step: 3, at: t, typed: tap.typed || typed };
    else resetTap();
  };

  /** A key pressed while the second press of a modifier is held: its `Alt Alt+Up` gesture. */
  const runHeldGesture = (e: KeyboardEvent): boolean => {
    if (tap?.step !== 3 || !modifierHeld(e, tap.modifier) || otherModifiers(e, tap.modifier)) return false;
    const key = strokeOf(e)?.split("+").pop();
    if (!key) return false;
    const binding = normalizeBinding(`${tap.modifier} ${tap.modifier}+${key}`);
    const ids = effectiveBindings()
      .filter(([b]) => b === binding)
      .map(([, id]) => id);
    for (const id of ids.reverse()) {
      const action = getAction(id);
      if (!action || !isActionKeyEnabled(action)) continue;
      e.preventDefault();
      e.stopPropagation();
      tap.keyUsed = true;
      void executeAction(id);
      return true;
    }
    return false;
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (suspended > 0) {
      reset();
      resetTap();
      return;
    }
    const modifier = KEY_MODIFIER[e.key];
    if (modifier) return onModifierDown(e, modifier);
    if (runHeldGesture(e)) return reset();
    resetTap();
    otherKeyAt = e.key === "Escape" || e.key === "Tab" ? -Infinity : now();
    if (isImeKey(e)) return;
    const stroke = strokeOf(e);
    if (!stroke) return;
    const chord = pending.length > 0;
    if (!chord) {
      if (isAltGrTyping(e)) return;
      const hasCommandMod = e.metaKey || e.ctrlKey || e.altKey;
      if (!hasCommandMod && isPlainTextField(e.target) && !/^(Shift\+)?(F\d{1,2}|Escape)$/.test(stroke)) return;
      if (isClaimed(e, stroke)) return;
    }

    const bindings = effectiveBindings();
    const physicalSeq = [...pending, stroke].join(" ");
    // Preserve older presets' numeric-keypad aliases unless a preset distinguishes the physical key.
    const keypadAliases: Record<string, string> = {
      NumpadAdd: "+",
      NumpadSubtract: "-",
      NumpadMultiply: "*",
      NumpadDivide: "/",
    };
    const seq = bindings.some(([b]) => b === physicalSeq || b.startsWith(physicalSeq + " "))
      ? physicalSeq
      : physicalSeq.replace(/Numpad(Add|Subtract|Multiply|Divide)/g, (key) => keypadAliases[key]!);
    const ctx = getContext();
    const exact = bindings.filter(([b]) => b === seq).map(([, id]) => id);
    // Later presets/overrides win; the first enabled match runs.
    for (const id of exact.reverse()) {
      const action = getAction(id);
      if (action && isActionKeyEnabled(action, ctx)) {
        e.preventDefault();
        e.stopPropagation();
        reset();
        void executeAction(id);
        return;
      }
    }
    if (bindings.some(([b]) => b.startsWith(seq + " "))) {
      e.preventDefault();
      e.stopPropagation();
      pending.push(stroke);
      clearTimeout(pendingTimer);
      pendingTimer = setTimeout(reset, CHORD_TIMEOUT);
      return;
    }
    // A second stroke that completes no chord is swallowed, as in IDEA, not typed.
    if (chord) {
      e.preventDefault();
      e.stopPropagation();
    }
    reset();
  };

  const onKeyUp = (e: KeyboardEvent) => {
    const modifier = KEY_MODIFIER[e.key];
    if (suspended > 0 || !modifier || !tap || tap.modifier !== modifier) return;
    const t = now();
    if (otherModifiers(e, modifier) || t - tap.at > DOUBLE_TAP_STEP_MS) return resetTap();
    if (tap.step === 1) {
      tap = { ...tap, step: 2, at: t };
      return;
    }
    const fire = tap.step === 3 && !tap.keyUsed && !tap.typed;
    resetTap();
    if (!fire) return;
    const ids = effectiveBindings()
      .filter(([b]) => b === `${modifier} ${modifier}`)
      .map(([, id]) => id);
    for (const id of ids.reverse()) if (runIfEnabled(id)) return;
  };

  const onMouseDown = (e: MouseEvent) => {
    // Shift+click (extend a selection) is not half of a double Shift.
    resetTap();
    if (suspended > 0) return;
    const stroke = mouseStrokeOf(e);
    if (!stroke) return;
    // Side buttons never reach the target (no editor selection, no focus change).
    e.preventDefault();
    e.stopPropagation();
    reset();
    const ids = effectiveBindings()
      .filter(([b]) => b === stroke)
      .map(([, id]) => id);
    for (const id of ids.reverse()) if (runIfEnabled(id)) return;
  };

  /** The release of a side button: swallowed so the webview doesn't navigate its own history. */
  const onMouseRelease = (e: MouseEvent) => {
    if (e.button < 3) return;
    e.preventDefault();
    e.stopPropagation();
  };

  const onBlur = () => {
    reset();
    resetTap();
  };

  target.addEventListener("keydown", onKeyDown, true);
  target.addEventListener("keyup", onKeyUp, true);
  target.addEventListener("mousedown", onMouseDown, true);
  target.addEventListener("mouseup", onMouseRelease, true);
  target.addEventListener("auxclick", onMouseRelease, true);
  target.addEventListener("blur", onBlur);
  return () => {
    target.removeEventListener("keydown", onKeyDown, true);
    target.removeEventListener("keyup", onKeyUp, true);
    target.removeEventListener("mousedown", onMouseDown, true);
    target.removeEventListener("mouseup", onMouseRelease, true);
    target.removeEventListener("auxclick", onMouseRelease, true);
    target.removeEventListener("blur", onBlur);
  };
}
