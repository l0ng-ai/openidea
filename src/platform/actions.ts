/**
 * The action system ("everything is an action"), modelled on IDEA's ActionManager.
 *
 * Menus, keybindings, toolbar buttons, context menus and the Actions tab of
 * Search Everywhere all resolve to the same registry, so a feature registers
 * its behaviour once:
 *
 *   registerAction({ id: "editor.formatDocument", title: "Reformat Code",
 *                    category: "Code", when: "editorFocus", run: () => … });
 *
 * Default keybindings live in keymaps (`keymap.ts`), not on the action.
 *
 * Titles are written in English; `action.<id>`, `action.<id>.description` and
 * `action.category.<category>` catalog keys, else the source-text catalog
 * (`tx`), translate them, and the registry re-localises on locale change. The
 * English title stays searchable.
 */
import { create } from "zustand";
import { evaluateWhen, getContext, type ContextKeys } from "./context";
import { formatMessage, lookup, tx, useI18n } from "./i18n";

export interface ActionContext {
  ctx: ContextKeys;
  /** Optional argument from the invoker (e.g. a menu passing a file path). */
  arg?: unknown;
}

export interface Action {
  /** Dotted, stable id, e.g. `navigate.searchEverywhere`. */
  id: string;
  title: string;
  /** Group shown in Search Everywhere and the keymap editor, e.g. `Navigate`. */
  category?: string;
  description?: string;
  /** Icon name from `ui/icons`. */
  icon?: string;
  /** Enablement; evaluated against context keys. */
  when?: string;
  /**
   * Extra condition for keyboard shortcuts only (menus and Find Action ignore
   * it), e.g. to yield a shared shortcut to an editor action while typing.
   */
  keyWhen?: string;
  /** Extra search terms for the Actions tab. */
  keywords?: string[];
  /** Hidden from Search Everywhere (internal / parameterised actions). */
  hidden?: boolean;
  /**
   * Marks a toggle action (IDEA's ToggleAction): returns the current state.
   * Search Everywhere shows an ON/OFF switch and keeps the popup open.
   */
  toggled?: () => boolean;
  run: (c: ActionContext) => void | Promise<void>;
}

interface ActionStore {
  actions: Map<string, Action>;
}

export const useActions = create<ActionStore>(() => ({ actions: new Map() }));

/** Registered actions as written (English), by id; the store holds their localised copies. */
const sources = new Map<string, Action>();

function translated(key: string): string | undefined {
  const message = lookup(key);
  return message === undefined ? undefined : formatMessage(message, {}, useI18n.getState().locale);
}

/** Catalog key, else the source-text catalog; `undefined` when untranslated. */
function localized(key: string, text: string | undefined): string | undefined {
  if (!text) return undefined;
  const v = translated(key) ?? tx(text);
  return v === text ? undefined : v;
}

function localize(action: Action): Action {
  const title = localized(`action.${action.id}`, action.title);
  const description = localized(`action.${action.id}.description`, action.description);
  const category = localized(`action.category.${action.category}`, action.category);
  if (!title && !description && !category) return action;
  return {
    ...action,
    title: title ?? action.title,
    description: description ?? action.description,
    category: category ?? action.category,
    keywords: title ? [...(action.keywords ?? []), action.title] : action.keywords,
  };
}

useI18n.subscribe((s, prev) => {
  if ((s.messages === prev.messages && s.texts === prev.texts) || !sources.size) return;
  useActions.setState({ actions: new Map([...sources].map(([id, a]) => [id, localize(a)])) });
});

/** Registers an action; returns a disposer. Re-registering an id replaces it. */
export function registerAction(action: Action): () => void {
  sources.set(action.id, action);
  useActions.setState((s) => ({ actions: new Map(s.actions).set(action.id, localize(action)) }));
  return () => {
    if (sources.get(action.id) !== action) return;
    sources.delete(action.id);
    useActions.setState((s) => {
      const actions = new Map(s.actions);
      actions.delete(action.id);
      return { actions };
    });
  };
}

export function registerActions(actions: Action[]): () => void {
  const disposers = actions.map(registerAction);
  return () => disposers.forEach((d) => d());
}

export function getAction(id: string): Action | undefined {
  return useActions.getState().actions.get(id);
}

export function allActions(): Action[] {
  return [...useActions.getState().actions.values()];
}

export function isActionEnabled(action: Action, ctx: ContextKeys = getContext()): boolean {
  if (
    ctx.projectOpening &&
    !["app.quit", "window.next", "window.previous", "window.toggleFullScreen"].includes(action.id)
  )
    return false;
  return evaluateWhen(action.when, ctx);
}

/** Whether a keyboard shortcut may run `action` (`when` and `keyWhen`). */
export function isActionKeyEnabled(action: Action, ctx: ContextKeys = getContext()): boolean {
  return isActionEnabled(action, ctx) && evaluateWhen(action.keyWhen, ctx);
}

/** Current state of a toggle action, or `undefined` for plain actions. */
export function actionToggled(action: Action | undefined): boolean | undefined {
  if (!action?.toggled) return undefined;
  try {
    return action.toggled();
  } catch {
    return false;
  }
}

/** How the user started an action (for listeners such as plugins' `action-performed`). */
export type ActionSource = "keyboard" | "menu" | "toolbar" | "contextMenu" | "search" | "other";

type ActionListener = (id: string, arg: unknown, source: ActionSource) => void;
const listeners = new Set<ActionListener>();
/** Set by `executeActionFrom` for the duration of the synchronous dispatch. */
let currentSource: ActionSource = "other";
/** Actions running synchronously inside another action's `run`. */
let nesting = 0;

/**
 * Called before each action the user runs (keyboard, menus, Find Action), not
 * for the actions an action runs itself. Macro recording listens here.
 */
export function onActionExecuted(listener: ActionListener): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Runs an action if registered and enabled. Returns whether it ran. */
export async function executeAction(id: string, arg?: unknown): Promise<boolean> {
  const action = getAction(id);
  if (!action) {
    console.warn(`unknown action: ${id}`);
    return false;
  }
  const ctx = getContext();
  if (!isActionEnabled(action, ctx)) return false;
  if (nesting === 0)
    for (const l of listeners)
      try {
        l(id, arg, currentSource);
      } catch (e) {
        console.error("action listener failed", e);
      }
  try {
    let pending: void | Promise<void>;
    nesting++;
    try {
      pending = action.run({ ctx, arg });
    } finally {
      nesting--;
    }
    await pending;
  } catch (e) {
    console.error(`action ${id} failed`, e);
  }
  return true;
}

/** `executeAction`, telling listeners how the user started it. */
export function executeActionFrom(source: ActionSource, id: string, arg?: unknown): Promise<boolean> {
  const previous = currentSource;
  currentSource = source;
  try {
    return executeAction(id, arg);
  } finally {
    currentSource = previous;
  }
}
