/**
 * Keymaps and keyboard dispatch.
 *
 * Binding syntax: modifiers `Meta Ctrl Alt Shift` joined with `+` to a key, e.g.
 * `Meta+Shift+O`, `Alt+F7`, `F8`. Space separates chord strokes
 * (`Meta+K Meta+C`). A modifier pressed twice is `Shift Shift` (IDEA's double
 * Shift, `Ctrl Ctrl`…); pressed twice and held, then a key, `Alt Alt+Up`.
 * Keys are matched by physical position (`KeyboardEvent.code`), so ⌥-letter
 * combos work on macOS where `event.key` would be a symbol. Mouse shortcuts
 * name the button 1-based (`Button1` = left, `Button4` = back side button, `Button5` = forward),
 * optionally with modifiers (`Alt+Button4`); they are single strokes.
 */
import { create } from "zustand";
import { executeAction, executeActionFrom, getAction, isActionKeyEnabled } from "./actions";
import { evaluateWhen, getContext } from "./context";
import { intellijMacos } from "./keymaps/intellij-macos";
import { intellijWindows } from "./keymaps/intellij-windows";
import { eclipseMacos } from "./keymaps/eclipse-macos";
import { eclipseWindows } from "./keymaps/eclipse-windows";
import { vscodeMacos } from "./keymaps/vscode-macos";
import { vscodeWindows } from "./keymaps/vscode-windows";
import { usePlatform } from "./platformInfo";
import { tx } from "./i18n";
import { isImeKey } from "./ime";
import { isPageSwipe, PAGE_SWIPE_EVENT } from "./pageSwipe";

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
  /** Extensions' default bindings (plugins), below the preset. */
  extensions: Keymap;
}

export const useKeymap = create<KeymapState>(() => ({ preset: defaultPreset(), overrides: {}, extensions: {} }));

const MOUSE_KEY_RE = /^Button(\d+)$/i;

/** A mouse shortcut (`Button4`, `Shift+Button5`) rather than a keystroke. */
export function isMouseBinding(binding: string): boolean {
  const b = binding.trim();
  return !/\s/.test(b) && MOUSE_KEY_RE.test(b.split("+").pop()!);
}

/**
 * Middle/side buttons, or a left click with Ctrl/Alt/Meta. Plain and Shift-only
 * left clicks keep selection semantics; right clicks keep the context menu.
 */
export function mouseStrokeOf(
  e: Pick<MouseEvent, "button" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
): string | null {
  if (!Number.isInteger(e.button) || e.button < 0) return null;
  if (e.button === 2 || (e.button === 0 && !(e.ctrlKey || e.altKey || e.metaKey))) return null;
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
  if (strokes.some((s) => /swipe(left|right)$/i.test(s))) {
    return strokes.length === 1 && /^swipe(left|right)$/i.test(b);
  }
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

/** Linux reserves middle paste by default; explicit overrides bypass this filter. */
function platformPreset(preset: string): Keymap {
  const own = PRESETS[preset] ?? {};
  const id = "editor.createRectangularSelectionOnMouseDrag";
  if (usePlatform.getState().os !== "linux" || !own[id]) return own;
  return { ...own, [id]: own[id].filter((binding) => binding !== "Button2") };
}

export function bindingsFor(actionId: string): string[] {
  const { preset, overrides, extensions } = useKeymap.getState();
  return overrides[actionId] ?? platformPreset(preset)[actionId] ?? usableExtensionBindings(extensions)[actionId] ?? [];
}

let bindingsCache: {
  preset: string;
  overrides: Keymap;
  extensions: Keymap;
  os: string;
  pairs: Array<[string, string]>;
} | null = null;

/** Every (binding, actionId) pair of the effective keymap. */
export function effectiveBindings(): Array<[string, string]> {
  const { preset, overrides, extensions } = useKeymap.getState();
  const { os } = usePlatform.getState();
  // The dispatcher asks for these on every keystroke; merging and normalizing
  // the whole keymap each time costs more than handling the key. The store
  // replaces `overrides` / `extensions` wholesale, so identity tracks changes.
  if (
    bindingsCache?.preset === preset &&
    bindingsCache.os === os &&
    bindingsCache.overrides === overrides &&
    bindingsCache.extensions === extensions
  )
    return bindingsCache.pairs;
  const merged: Keymap = { ...usableExtensionBindings(extensions), ...platformPreset(preset), ...overrides };
  const pairs = Object.entries(merged).flatMap(([id, keys]) =>
    keys.map((k) => [normalizeBinding(k), id] as [string, string]),
  );
  bindingsCache = { preset, overrides, extensions, os, pairs };
  return pairs;
}

let extensionCache: { source: Keymap; preset: string; overrides: Keymap; os: string; usable: Keymap } | null = null;

/**
 * Plugin default bindings that stay: those of actions the preset and the
 * user leave unbound, on keystrokes nothing else uses (the IDE's own
 * shortcuts always win).
 */
function usableExtensionBindings(extensions: Keymap | undefined = {}): Keymap {
  const { preset, overrides } = useKeymap.getState();
  const { os } = usePlatform.getState();
  if (
    extensionCache?.source === extensions &&
    extensionCache.preset === preset &&
    extensionCache.os === os &&
    extensionCache.overrides === overrides
  )
    return extensionCache.usable;
  const builtIn: Keymap = { ...platformPreset(preset), ...overrides };
  const taken = new Set(Object.values(builtIn).flatMap((keys) => keys.map(normalizeBinding)));
  const usable: Keymap = {};
  for (const [id, keys] of Object.entries(extensions)) {
    if (id in builtIn) continue;
    const free = keys.filter((k) => !taken.has(normalizeBinding(k)));
    for (const k of free) taken.add(normalizeBinding(k));
    if (free.length) usable[id] = free;
  }
  extensionCache = { source: extensions, preset, overrides, os, usable };
  return usable;
}

/**
 * Default bindings contributed by an extension (a plugin's `keymaps`), below
 * the preset and the user's: dropped when the keystroke is already taken.
 * Returns a disposer.
 */
export function registerExtensionBindings(actionId: string, bindings: string[]): () => void {
  const valid = bindings.filter(isValidBinding);
  useKeymap.setState((s) => ({ extensions: { ...(s.extensions ?? {}), [actionId]: valid } }));
  return () =>
    useKeymap.setState((s) => {
      if (s.extensions?.[actionId] !== valid) return s;
      const { [actionId]: _, ...rest } = s.extensions ?? {};
      return { extensions: rest };
    });
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
      const swipe = /^swipe(left|right)$/i.exec(key);
      if (swipe) return `Swipe${swipe[1]!.toLowerCase() === "left" ? "Left" : "Right"}`;
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
    const key = parts.pop();
    const button = key === "Button1" ? "Left Click" : key === "Button2" ? tx("Middle Click") : `${key} Click`;
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
  return bindingsFor(actionId).find((b) => !isMouseBinding(b) && !isPageSwipe(b));
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

/** Recognizes the same modifier sequences for dispatch and shortcut capture. */
export function createDoubleModifierRecognizer(now: () => number = () => performance.now()) {
  // Step 1 pressed, 2 released, 3 pressed again. A bare gesture completes on the second release.
  let tap: { modifier: Modifier; step: 1 | 2 | 3; at: number; typed: boolean; keyUsed: boolean } | null = null;
  let otherKeyAt = -Infinity;
  const reset = () => {
    tap = null;
  };

  const pressModifier = (e: KeyboardEvent, modifier: Modifier) => {
    const t = now();
    if (e.repeat && tap?.step === 3 && tap.modifier === modifier) return;
    if (e.repeat || otherModifiers(e, modifier)) return reset();
    const typed = t - otherKeyAt < DOUBLE_TAP_TYPING_GUARD_MS;
    if (tap && (tap.modifier !== modifier || t - tap.at > DOUBLE_TAP_STEP_MS)) reset();
    if (!tap) tap = { modifier, step: 1, at: t, typed, keyUsed: false };
    else if (tap.step === 2) tap = { ...tap, step: 3, at: t, typed: tap.typed || typed };
    else reset();
  };

  return {
    keyDown(e: KeyboardEvent, heldAction?: (event: KeyboardEvent, binding: string) => (() => void) | undefined) {
      const modifier = KEY_MODIFIER[e.key];
      if (modifier) {
        pressModifier(e, modifier);
        return true;
      }
      if (heldAction && tap?.step === 3 && modifierHeld(e, tap.modifier) && !otherModifiers(e, tap.modifier)) {
        const key = strokeOf(e)?.split("+").pop();
        const action = key ? heldAction(e, normalizeBinding(`${tap.modifier} ${tap.modifier}+${key}`)) : undefined;
        if (action) {
          tap.keyUsed = true;
          action();
          return true;
        }
      }
      reset();
      otherKeyAt = e.key === "Escape" || e.key === "Tab" ? -Infinity : now();
      return false;
    },
    keyUp(e: KeyboardEvent) {
      const modifier = KEY_MODIFIER[e.key];
      if (!modifier || !tap || tap.modifier !== modifier) return null;
      const t = now();
      if (otherModifiers(e, modifier) || t - tap.at > DOUBLE_TAP_STEP_MS) {
        reset();
        return null;
      }
      if (tap.step === 1) {
        tap = { ...tap, step: 2, at: t };
        return null;
      }
      const completed = tap.step === 3 && !tap.keyUsed && !tap.typed;
      reset();
      return completed ? `${modifier} ${modifier}` : null;
    },
    reset,
  };
}

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
  void executeActionFrom("keyboard", id);
  return true;
}

/** Run a configured mouse binding; editors prepare the clicked caret and focus first. */
export function dispatchMouseShortcut(e: MouseEvent, prepare?: (id: string) => boolean, arg?: unknown): boolean {
  if (suspended > 0) return false;
  const stroke = mouseStrokeOf(e);
  if (!stroke) return false;
  const ids = effectiveBindings()
    .filter(([b]) => b === stroke)
    .map(([, id]) => id);
  for (const id of ids.reverse()) {
    const action = getAction(id);
    if (!action || !isActionKeyEnabled(action)) continue;
    // A rectangular selection needs the drag; do not consume it as an ordinary click.
    if (id === "editor.createRectangularSelectionOnMouseDrag") return false;
    if (prepare && !prepare(id)) return false;
    void executeAction(id, arg);
    return true;
  }
  return false;
}

/**
 * Actions a shortcut passed on by a plugin's frame may run (`dispatchForwardedKey`) when the plugin
 * does not hold `ide.commands`: saving, closing the editor tab, settings, and those that only move
 * the caret or focus, or show a popup or tool window. The frame's page may send any key at any time,
 * so nothing that runs, changes or sends something is listed: not themes, schemes, zoom or
 * bookmarks, nor opening, merging or closing windows and tabs, nor the terminal (showing it starts
 * a shell). Exact ids, never prefixes; a test checks that each one is still registered.
 */
export const FORWARDABLE_ACTIONS: ReadonlySet<string> = new Set([
  "file.save",
  "file.settings",
  "editor.closeTab",
  "navigate.back",
  "navigate.forward",
  "navigate.lastEditLocation",
  "navigate.nextEditLocation",
  "navigate.gotoLine",
  "navigate.gotoClass",
  "navigate.gotoFile",
  "navigate.gotoSymbol",
  "navigate.searchEverywhere",
  "navigate.findAction",
  "navigate.searchText",
  "navigate.recentFiles",
  "navigate.recentLocations",
  "navigate.switcher",
  "navigate.switcherBack",
  "navigate.fileStructure",
  "navigate.navigationBar",
  "navigate.selectIn",
  "navigate.selectInProjectView",
  "navigate.showFilePath",
  "navigate.showBookmarks",
  ...Array.from({ length: 10 }, (_, d) => `navigate.gotoBookmark${d}`),
  "navigate.declaration",
  "navigate.typeDeclaration",
  "navigate.implementation",
  "navigate.superMethod",
  "navigate.callHierarchy",
  "navigate.typeHierarchy",
  "navigate.nextError",
  "navigate.prevError",
  "navigate.nextMethod",
  "navigate.previousMethod",
  "navigate.nextOccurrence",
  "navigate.prevOccurrence",
  "navigate.nextHighlightedUsage",
  "navigate.prevHighlightedUsage",
  "toolwindow.project",
  "toolwindow.structure",
  "toolwindow.problems",
  "toolwindow.find",
  "toolwindow.bookmarks",
  "toolwindow.git",
  "toolwindow.commit",
  "toolwindow.run",
  "toolwindow.debug",
  "toolwindow.hideActive",
  "toolwindow.hideAll",
  "toolwindow.jumpToLast",
  "toolwindow.focusEditor",
  "toolwindow.maximize",
  "toolwindow.resizeUp",
  "toolwindow.resizeDown",
  "toolwindow.resizeLeft",
  "toolwindow.resizeRight",
  "window.next",
  "window.previous",
  "window.nextTab",
  "window.previousTab",
]);

const restrictedKeys = new WeakSet<Event>();

/**
 * Dispatches on `target` a shortcut that a plugin's sandboxed frame says was pressed in it and left
 * alone, for the keymap. The page can post one at any time, so unless the plugin may run any IDE
 * action (`anyAction`: it holds `ide.commands`), the keymap runs only `FORWARDABLE_ACTIONS` from it,
 * and it neither starts nor finishes a chord and takes no part in a double-modifier gesture.
 */
export function dispatchForwardedKey(target: EventTarget, init: KeyboardEventInit, anyAction = false): void {
  const e = new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true });
  if (!anyAction) restrictedKeys.add(e);
  target.dispatchEvent(e);
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
  const doubleModifier = createDoubleModifierRecognizer(now);

  const reset = () => {
    pending = [];
    clearTimeout(pendingTimer);
  };

  /** A key pressed while the second press of a modifier is held: its `Alt Alt+Up` gesture. */
  const heldAction = (e: KeyboardEvent, binding: string) => {
    const ids = effectiveBindings()
      .filter(([b]) => b === binding)
      .map(([, id]) => id);
    for (const id of ids.reverse()) {
      const action = getAction(id);
      if (!action || !isActionKeyEnabled(action)) continue;
      return () => {
        e.preventDefault();
        e.stopPropagation();
        void executeActionFrom("keyboard", id);
        reset();
      };
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (suspended > 0) {
      reset();
      doubleModifier.reset();
      return;
    }
    const restricted = restrictedKeys.has(e);
    if (restricted) {
      reset();
      if (KEY_MODIFIER[e.key]) return;
    }
    if (doubleModifier.keyDown(e, restricted ? undefined : heldAction)) return;
    if (isImeKey(e)) return;
    const stroke = strokeOf(e);
    if (!stroke) return;
    const chord = pending.length > 0;
    if (!chord) {
      if (isAltGrTyping(e)) return;
      const hasCommandMod = e.metaKey || e.ctrlKey || e.altKey;
      if (isPlainTextField(e.target)) {
        // Native deletion stays in the field; Shift bindings and terminal keys keep their own routing.
        if ((e.key === "Backspace" || e.key === "Delete") && !e.shiftKey && !(e.target as Element).closest?.(".xterm"))
          return;
        if (!hasCommandMod && !/^(Shift\+)?(F\d{1,2}|Escape)$/.test(stroke)) return;
      }
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
    // Later presets/overrides win; the first enabled match runs. When several
    // actions share the sequence, a binding whose `keyWhen` matches the current
    // context runs before one without it: the context-specific claim beats the
    // context-free one at equal specificity, so Eclipse's Alt+Shift+R renames
    // in the project view instead of reaching the Git log's Edit Commit
    // Message. An unmatching `keyWhen` fails the enablement check below, and
    // when no `keyWhen` matches, the preset/override order decides as before.
    const keyWhenMatches = (id: string) => {
      const action = getAction(id);
      return !!action?.keyWhen && evaluateWhen(action.keyWhen, ctx);
    };
    const ordered = exact.reverse();
    const preferred: string[] = [];
    const fallback: string[] = [];
    for (const id of ordered) {
      if (keyWhenMatches(id)) preferred.push(id);
      else fallback.push(id);
    }
    for (const id of [...preferred, ...fallback]) {
      const action = getAction(id);
      if (action && isActionKeyEnabled(action, ctx) && (!restricted || FORWARDABLE_ACTIONS.has(id))) {
        e.preventDefault();
        e.stopPropagation();
        reset();
        void executeActionFrom("keyboard", id);
        return;
      }
    }
    if (!restricted && bindings.some(([b]) => b.startsWith(seq + " "))) {
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
    if (suspended > 0) return;
    const binding = doubleModifier.keyUp(e);
    if (!binding) return;
    const ids = effectiveBindings()
      .filter(([b]) => b === binding)
      .map(([, id]) => id);
    for (const id of ids.reverse()) if (runIfEnabled(id)) return;
  };

  const onMouseDown = (e: MouseEvent) => {
    // Shift+click (extend a selection) is not half of a double Shift.
    doubleModifier.reset();
    if (suspended > 0) {
      reset();
      return;
    }
    // Editors arbitrate middle click/drag; other components may use middle paste.
    if (e.button === 1) return;
    const stroke = mouseStrokeOf(e);
    if (!stroke) return;
    if (e.button === 0) {
      // The editor sets the caret under the pointer before dispatching the action.
      if (e.target instanceof Element && e.target.closest(".cm-content")) return;
      if (!dispatchMouseShortcut(e)) return;
      e.preventDefault();
      e.stopPropagation();
      reset();
      return;
    }
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

  /** macOS force click: no system Look Up popover over IDE text; the editor navigates instead. */
  const onForceWillBegin = (e: Event) => e.preventDefault();

  const onBlur = () => {
    reset();
    doubleModifier.reset();
  };

  const onSwipe = (event: Event) => {
    const stroke = (event as CustomEvent).detail;
    if (suspended > 0 || !isPageSwipe(stroke)) return;
    reset();
    doubleModifier.reset();
    const ids = effectiveBindings()
      .filter(([binding]) => binding === stroke)
      .map(([, id]) => id);
    for (const id of ids.reverse()) if (runIfEnabled(id)) return;
  };
  target.addEventListener(PAGE_SWIPE_EVENT, onSwipe);
  target.addEventListener("keydown", onKeyDown, true);
  target.addEventListener("keyup", onKeyUp, true);
  target.addEventListener("mousedown", onMouseDown, true);
  target.addEventListener("mouseup", onMouseRelease, true);
  target.addEventListener("auxclick", onMouseRelease, true);
  target.addEventListener("webkitmouseforcewillbegin", onForceWillBegin, true);
  target.addEventListener("blur", onBlur);
  return () => {
    target.removeEventListener(PAGE_SWIPE_EVENT, onSwipe);
    target.removeEventListener("keydown", onKeyDown, true);
    target.removeEventListener("keyup", onKeyUp, true);
    target.removeEventListener("mousedown", onMouseDown, true);
    target.removeEventListener("mouseup", onMouseRelease, true);
    target.removeEventListener("auxclick", onMouseRelease, true);
    target.removeEventListener("webkitmouseforcewillbegin", onForceWillBegin, true);
    target.removeEventListener("blur", onBlur);
  };
}

/** A keymap being edited: a bundled preset and the overrides on top of it. */
export interface KeymapDraft {
  preset: string;
  overrides: Keymap;
}

/**
 * The defaults of `id`: the preset's, or for an action the preset leaves out,
 * the shortcut its plugin declares (`keymaps`). Removing or changing one is an
 * override like any other.
 */
export function presetBindings(preset: string, id: string): string[] {
  const own = platformPreset(preset);
  const keys = own && id in own ? own[id] : useKeymap.getState().extensions?.[id];
  return (keys ?? []).map(normalizeBinding);
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Sets the full binding list of `id`; drops the override when it equals the preset. */
export function withBindings(draft: KeymapDraft, id: string, bindings: readonly string[]): Keymap {
  const list = [...new Set(bindings.map(normalizeBinding))];
  const overrides = { ...draft.overrides };
  if (sameList(list, presetBindings(draft.preset, id))) delete overrides[id];
  else overrides[id] = list;
  return overrides;
}

/** A free id for a user keymap called `name`. */
export function customKeymapId(name: string, customs: Record<string, unknown>): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "keymap";
  let id = `custom.${slug}`;
  for (let i = 2; customs[id] || PRESETS[id]; i++) id = `custom.${slug}-${i}`;
  return id;
}
