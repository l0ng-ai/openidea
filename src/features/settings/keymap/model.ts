/**
 * Keymap editing logic (pure): effective bindings for a staged preset +
 * overrides, add / remove / reset, conflict detection with `when` overlap,
 * and shortcut search.
 */
import type { Action } from "@/platform/actions";
import { evaluateWhen, type ContextKeys } from "@/platform/context";
import { defaultPreset, normalizeBinding, PRESET_TITLES, PRESETS, type Keymap } from "@/platform/keymap";

export interface KeymapDraft {
  preset: string;
  overrides: Keymap;
}

export function presetBindings(preset: string, id: string): string[] {
  return (PRESETS[preset]?.[id] ?? []).map(normalizeBinding);
}

export function resolveBindings(draft: KeymapDraft, id: string): string[] {
  return (draft.overrides[id] ?? PRESETS[draft.preset]?.[id] ?? []).map(normalizeBinding);
}

export function isModified(draft: KeymapDraft, id: string): boolean {
  return id in draft.overrides;
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

export function addBinding(draft: KeymapDraft, id: string, binding: string): Keymap {
  return withBindings(draft, id, [...resolveBindings(draft, id), binding]);
}

export function removeBinding(draft: KeymapDraft, id: string, binding: string): Keymap {
  const b = normalizeBinding(binding);
  return withBindings(
    draft,
    id,
    resolveBindings(draft, id).filter((x) => x !== b),
  );
}

export function resetBindings(draft: KeymapDraft, id: string): Keymap {
  const overrides = { ...draft.overrides };
  delete overrides[id];
  return overrides;
}

/** Re-bases overrides on another preset: drops overrides that now equal the new defaults. */
export function switchPreset(draft: KeymapDraft, preset: string): KeymapDraft {
  const next: KeymapDraft = { preset, overrides: {} };
  for (const [id, keys] of Object.entries(draft.overrides)) next.overrides = withBindings(next, id, keys);
  return next;
}

// ---------------------------------------------------------------------------
// `when` overlap

const COMPARISON = /([\w.\-:/]+)\s*(==|!=)\s*('[^']*'|"[^"]*"|[\w.\-:/]+)/g;
const IDENT = /[A-Za-z_][\w.\-:/]*/g;
const MAX_COMBINATIONS = 4096;

function literal(raw: string): string | number | boolean {
  if (/^['"]/.test(raw)) return raw.slice(1, -1);
  if (raw === "true") return true;
  if (raw === "false") return false;
  return Number.isFinite(+raw) ? +raw : raw;
}

type Value = string | number | boolean | undefined;

/**
 * Whether two `when` clauses can be true at the same time. Enumerates the
 * context keys they mention (true / unset / each compared literal / other) and
 * evaluates both. Focus keys are modelled as one focus location: `editor…Focus`
 * keys only hold in the editor, a view key (`projectViewFocus`, `terminalFocus`…)
 * only in that view, `toolWindowFocus` in any view. Too many keys, or an
 * unparsable clause, counts as overlapping.
 */
export function whensOverlap(a: string | undefined, b: string | undefined): boolean {
  if (!a?.trim() || !b?.trim() || a.trim() === b.trim()) return true;
  const domain = new Map<string, Set<Value>>();
  const add = (key: string, v?: Value) => {
    let set = domain.get(key);
    if (!set) domain.set(key, (set = new Set<Value>([true, undefined, "\u0000other"])));
    if (v !== undefined) set.add(v);
  };
  for (const src of [a, b]) {
    const rest = src.replace(COMPARISON, (_m, key: string, _op, raw: string) => {
      add(key, literal(raw));
      return " ";
    });
    for (const m of rest.match(IDENT) ?? []) add(m);
  }
  const focus = [...domain.keys()].filter((k) => /Focus$/.test(k));
  const editorKeys = focus.filter((k) => k.startsWith("editor"));
  const viewKeys = focus.filter((k) => !k.startsWith("editor") && k !== "toolWindowFocus");
  const locations = ["none", "editor", "toolWindow", ...viewKeys];
  // Free variables: everything except the derived view / tool-window focus keys.
  const free = [...domain.keys()].filter((k) => !viewKeys.includes(k) && k !== "toolWindowFocus");
  const values = free.map((k) => (editorKeys.includes(k) ? [true, false] : [...domain.get(k)!]));
  const total = values.reduce((n, v) => n * v.length, 1) * locations.length;
  if (total > MAX_COMBINATIONS) return true;
  try {
    for (const loc of locations) {
      for (let i = 0; i < total / locations.length; i++) {
        const ctx: ContextKeys = {};
        let rem = i;
        free.forEach((k, ki) => {
          const vs = values[ki]!;
          ctx[k] = vs[rem % vs.length];
          rem = Math.floor(rem / vs.length);
        });
        for (const k of editorKeys) if (loc !== "editor") ctx[k] = false;
        for (const k of viewKeys) ctx[k] = loc === k;
        ctx.toolWindowFocus = loc === "toolWindow" || viewKeys.includes(loc);
        if (evaluateWhen(a, ctx) && evaluateWhen(b, ctx)) return true;
      }
    }
  } catch {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Conflicts

export interface Conflict {
  actionId: string;
  title: string;
  category?: string;
  binding: string;
  /** `same`: identical binding; `prefix`: one is the first stroke of the other's chord. */
  kind: "same" | "prefix";
}

/** Other actions whose bindings clash with `binding` in an overlapping `when` context. */
export function findConflicts(
  draft: KeymapDraft,
  binding: string,
  actionId: string,
  actions: readonly Pick<Action, "id" | "title" | "category" | "when">[],
): Conflict[] {
  const b = normalizeBinding(binding);
  const self = actions.find((x) => x.id === actionId);
  const out: Conflict[] = [];
  for (const other of actions) {
    if (other.id === actionId) continue;
    for (const ob of resolveBindings(draft, other.id)) {
      const kind = ob === b ? "same" : ob.startsWith(b + " ") || b.startsWith(ob + " ") ? "prefix" : null;
      if (!kind || !whensOverlap(self?.when, other.when)) continue;
      out.push({ actionId: other.id, title: other.title, category: other.category, binding: ob, kind });
    }
  }
  return out.sort((x, y) => (x.kind === y.kind ? x.title.localeCompare(y.title) : x.kind === "same" ? -1 : 1));
}

/** Overrides with every conflicting assignment removed (IDEA's "Remove other assignments"). */
export function removeConflicts(draft: KeymapDraft, conflicts: readonly Conflict[]): Keymap {
  let overrides = draft.overrides;
  for (const c of conflicts) overrides = removeBinding({ preset: draft.preset, overrides }, c.actionId, c.binding);
  return overrides;
}

/** Shortcut filter: an action matches when one of its bindings equals or starts with `strokes`. */
export function bindingMatches(bindings: readonly string[], strokes: string): boolean {
  if (!strokes) return true;
  const q = normalizeBinding(strokes);
  return bindings.some((b) => b === q || b.startsWith(q + " "));
}

// ---------------------------------------------------------------------------
// User keymaps (gear menu: Duplicate… / Rename… / Restore Defaults / Delete)

export interface CustomKeymap {
  name: string;
  parent: string;
  overrides: Keymap;
}

export type CustomKeymaps = Record<string, CustomKeymap>;

/** Base preset + overrides of the selected keymap (a bundled preset or a user keymap). */
export function activeDraft(selected: string, bundledOverrides: Keymap, customs: CustomKeymaps): KeymapDraft {
  const custom = PRESETS[selected] ? undefined : customs[selected];
  if (custom) return { preset: PRESETS[custom.parent] ? custom.parent : defaultPreset(), overrides: custom.overrides };
  return { preset: PRESETS[selected] ? selected : defaultPreset(), overrides: bundledOverrides };
}

/** Display name of a keymap id. */
export function keymapName(id: string, customs: CustomKeymaps): string {
  return customs[id]?.name ?? PRESET_TITLES[id] ?? id;
}

/** `"<name> copy"`, `"<name> copy 2"`, … not used by any keymap yet. */
export function copyName(name: string, customs: CustomKeymaps): string {
  const taken = new Set([...Object.values(customs).map((k) => k.name), ...Object.values(PRESET_TITLES)]);
  const base = `${name} copy`;
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`)) return `${base} ${i}`;
}

/** Error text for a proposed keymap name, or null when valid. */
export function validateKeymapName(name: string, customs: CustomKeymaps, ownId?: string): string | null {
  const n = name.trim();
  if (!n) return "Keymap name cannot be empty";
  const clash =
    Object.values(PRESET_TITLES).includes(n) || Object.entries(customs).some(([id, k]) => id !== ownId && k.name === n);
  return clash ? `Keymap '${n}' already exists` : null;
}

function newKeymapId(name: string, customs: CustomKeymaps): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "keymap";
  let id = `custom.${slug}`;
  for (let i = 2; customs[id] || PRESETS[id]; i++) id = `custom.${slug}-${i}`;
  return id;
}

/** Copies the selected keymap (its effective overrides) under `name`; returns the new id. */
export function duplicateKeymap(
  draft: KeymapDraft,
  customs: CustomKeymaps,
  name: string,
): { id: string; customs: CustomKeymaps } {
  const id = newKeymapId(name, customs);
  return {
    id,
    customs: { ...customs, [id]: { name: name.trim(), parent: draft.preset, overrides: { ...draft.overrides } } },
  };
}

/**
 * Imports a `CustomKeymap` into `customs`.
 * When `overwrite` is true and a custom keymap with the same name exists, replaces it in place.
 * Otherwise, if the name collides with a built-in preset or existing custom keymap, appends ` (2)`, ` (3)`, etc.
 */
export function importKeymap(
  customs: CustomKeymaps,
  keymap: CustomKeymap,
  overwrite = false,
): { id: string; customs: CustomKeymaps } {
  const baseName = keymap.name.trim() || "Imported Keymap";
  const parent = PRESETS[keymap.parent] ? keymap.parent : defaultPreset();
  if (overwrite) {
    const existing = Object.entries(customs).find(([, k]) => k.name === baseName);
    if (existing) {
      const [id] = existing;
      return {
        id,
        customs: { ...customs, [id]: { name: baseName, parent, overrides: { ...keymap.overrides } } },
      };
    }
  }
  const taken = (n: string) =>
    Object.values(PRESET_TITLES).includes(n) || Object.values(customs).some((k) => k.name === n);
  let name = baseName;
  for (let i = 2; taken(name); i++) name = `${baseName} (${i})`;
  const id = newKeymapId(name, customs);
  return {
    id,
    customs: { ...customs, [id]: { name, parent, overrides: { ...keymap.overrides } } },
  };
}

export function renameKeymap(customs: CustomKeymaps, id: string, name: string): CustomKeymaps {
  const k = customs[id];
  return k ? { ...customs, [id]: { ...k, name: name.trim() } } : customs;
}

/** Removes a user keymap; the selection falls back to its parent preset. */
export function deleteKeymap(customs: CustomKeymaps, id: string): { customs: CustomKeymaps; selected: string } {
  const { [id]: removed, ...rest } = customs;
  return { customs: rest, selected: removed && PRESETS[removed.parent] ? removed.parent : defaultPreset() };
}

/** Stores edited overrides on the user keymap `id`. */
export function withCustomOverrides(customs: CustomKeymaps, id: string, overrides: Keymap): CustomKeymaps {
  const k = customs[id];
  return k ? { ...customs, [id]: { ...k, overrides } } : customs;
}
