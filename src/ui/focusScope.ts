/**
 * Focus scopes: containers marked `data-focus-scope` that show whether they hold focus, as
 * IDEA's tab strips do (the selected tab is accented only in the part that has focus).
 *
 * The scopes containing the last element focused inside any scope get `data-focus-active`.
 * Focus moving outside every scope (popups, menus, dialogs, the body) keeps the marks, so a
 * context menu opened from a tab leaves its strip active.
 */

const FOCUS_SCOPE_ATTR = "data-focus-scope";
export const FOCUS_ACTIVE_ATTR = "data-focus-active";

/** Marks the scopes holding focus. Returns an uninstaller that clears the marks. */
export function installFocusScopeTracking(): () => void {
  let active: Element[] = [];
  const mark = (target: Element | null) => {
    const chain: Element[] = [];
    for (let el = target?.closest(`[${FOCUS_SCOPE_ATTR}]`); el; el = el.parentElement?.closest(`[${FOCUS_SCOPE_ATTR}]`))
      chain.push(el);
    if (!chain.length) return;
    for (const el of active) if (!chain.includes(el)) el.removeAttribute(FOCUS_ACTIVE_ATTR);
    for (const el of chain) el.setAttribute(FOCUS_ACTIVE_ATTR, "");
    active = chain;
  };
  const onFocusIn = (e: FocusEvent) => mark(e.target instanceof Element ? e.target : null);
  document.addEventListener("focusin", onFocusIn);
  mark(document.activeElement);
  return () => {
    document.removeEventListener("focusin", onFocusIn);
    for (const el of active) el.removeAttribute(FOCUS_ACTIVE_ATTR);
    active = [];
  };
}
