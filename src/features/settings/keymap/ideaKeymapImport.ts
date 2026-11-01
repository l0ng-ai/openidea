/**
 * Import of an IntelliJ IDEA keymap file (`keymaps/<name>.xml` in the IDE's
 * config directory). An IDEA keymap lists only the actions it changes over its
 * parent; each listed action's shortcuts replace the parent's.
 */
import { IDEA_ACTIONS } from "@/features/vim/rc";
import { defaultPreset, isValidBinding, normalizeBinding, type Keymap } from "@/platform/keymap";
import { withBindings } from "./model";

export interface ImportedIdeaKeymap {
  name: string;
  /** OpenIDEA preset the keymap is based on. */
  parent: string;
  overrides: Keymap;
  /** IDEA action ids applied. */
  applied: number;
  /** IDEA action ids without an OpenIDEA counterpart. */
  unknownActions: string[];
  /** Shortcuts that cannot be expressed here (wheel, double click, unknown keys). */
  skippedShortcuts: number;
}

/** IDEA's bundled keymap names (`<keymap name=…>`) → our presets. */
function presetOf(parent: string | null): string {
  const p = parent ?? "";
  const mac = /mac/i.test(p);
  if (/^eclipse/i.test(p)) return mac ? "eclipse-macos" : "eclipse-windows";
  if (/^vs ?code/i.test(p)) return mac ? "vscode-macos" : "vscode-windows";
  if (mac) return "intellij-macos";
  if (p === "$default" || /^default for/i.test(p)) return "intellij-windows";
  return defaultPreset();
}

/** Swing `KeyEvent.VK_*` names (as IDEA writes them, without `VK_`) → our key names. */
const SWING_KEYS: Record<string, string> = {
  ENTER: "Enter",
  ESCAPE: "Escape",
  TAB: "Tab",
  SPACE: "Space",
  BACK_SPACE: "Backspace",
  DELETE: "Delete",
  INSERT: "Insert",
  HOME: "Home",
  END: "End",
  PAGE_UP: "PageUp",
  PAGE_DOWN: "PageDown",
  UP: "Up",
  DOWN: "Down",
  LEFT: "Left",
  RIGHT: "Right",
  OPEN_BRACKET: "[",
  CLOSE_BRACKET: "]",
  COMMA: ",",
  PERIOD: ".",
  SLASH: "/",
  BACK_SLASH: "\\",
  SEMICOLON: ";",
  QUOTE: "'",
  BACK_QUOTE: "`",
  MINUS: "-",
  EQUALS: "=",
  ADD: "NumpadAdd",
  SUBTRACT: "NumpadSubtract",
  MULTIPLY: "NumpadMultiply",
  DIVIDE: "NumpadDivide",
};

const SWING_MODS: Record<string, string> = { shift: "Shift", ctrl: "Ctrl", control: "Ctrl", alt: "Alt", meta: "Meta" };

/** `"shift meta O"` / `"ctrl pressed OPEN_BRACKET"` → `"Meta+Shift+O"`, or null when not expressible. */
export function fromSwingStroke(stroke: string): string | null {
  const words = stroke
    .trim()
    .split(/\s+/)
    .filter((w) => !/^(pressed|released|typed)$/i.test(w));
  const key = words.pop();
  if (!key || words.some((w) => !SWING_MODS[w.toLowerCase()])) return null;
  const name = /^([A-Z0-9]|F\d{1,2})$/.test(key) ? key : SWING_KEYS[key];
  return name ? [...words.map((w) => SWING_MODS[w.toLowerCase()]), name].join("+") : null;
}

/** `"meta alt button1"` → `"Meta+Alt+Button1"`; wheel and multi-click gestures → null. */
function fromMouseStroke(stroke: string): string | null {
  const words = stroke.trim().split(/\s+/);
  const button = words.pop();
  if (!button || !/^button\d$/i.test(button) || words.some((w) => !SWING_MODS[w.toLowerCase()])) return null;
  return [...words.map((w) => SWING_MODS[w.toLowerCase()]), `Button${button.slice(6)}`].join("+");
}

/** Parses an IDEA keymap XML; throws when the file is not a keymap. */
export function parseIdeaKeymap(xml: string): ImportedIdeaKeymap {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const root = doc.documentElement;
  if (doc.getElementsByTagName("parsererror").length || root.tagName !== "keymap")
    throw new Error("Not an IntelliJ IDEA keymap file");
  const parent = presetOf(root.getAttribute("parent"));
  const collected = new Map<string, string[]>();
  const unknownActions: string[] = [];
  let applied = 0;
  let skippedShortcuts = 0;
  for (const action of Array.from(root.getElementsByTagName("action"))) {
    const ideaId = action.getAttribute("id") ?? "";
    const id = IDEA_ACTIONS[ideaId];
    if (!id) {
      if (ideaId) unknownActions.push(ideaId);
      continue;
    }
    applied++;
    const keys = collected.get(id) ?? [];
    for (const s of Array.from(action.children)) {
      let binding: string | null = null;
      if (s.tagName === "keyboard-shortcut") {
        const first = fromSwingStroke(s.getAttribute("first-keystroke") ?? "");
        const raw = s.getAttribute("second-keystroke");
        const second = raw == null ? "" : fromSwingStroke(raw);
        binding = first && second !== null ? `${first} ${second}`.trim() : null;
      } else if (s.tagName === "mouse-shortcut") {
        binding = fromMouseStroke(s.getAttribute("keystroke") ?? "");
      } else continue;
      if (binding && isValidBinding(binding)) keys.push(normalizeBinding(binding));
      else skippedShortcuts++;
    }
    // An `<action id=…/>` without shortcuts removes the parent's.
    collected.set(id, keys);
  }
  let overrides: Keymap = {};
  for (const [id, keys] of collected) overrides = withBindings({ preset: parent, overrides }, id, keys);
  return {
    name: root.getAttribute("name")?.trim() || "Imported keymap",
    parent,
    overrides,
    applied,
    unknownActions,
    skippedShortcuts,
  };
}
