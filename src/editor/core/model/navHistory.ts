/**
 * Back / Forward navigation history (⌘[ / ⌘]), like IDEA's:
 * `entries[index]` is the current place, kept up to
 * date while the caret moves. Only a navigation (a file switch, a mouse click,
 * a jump to a declaration / usage / search result / line …) that changes the
 * caret line leaves the previous place behind as a back entry and drops the
 * forward stack; typing, arrows and paging don't. A back entry within
 * `MERGE_LINES` of the one before it replaces it.
 */
import type { Transaction } from "@codemirror/state";
import type { NavigationLocation } from "@/editor/api";

export const MERGE_LINES = 4;

/** userEvent of in-file navigation commands (method up / down, code block start / end…). */
export const NAVIGATE_EVENT = "select.navigate";

/** Caret moves that count as navigation: mouse clicks, find, reveals, stripe / sticky-line clicks, navigate commands. */
export function isNavigation(tr: Transaction): boolean {
  return ["select.pointer", "select.reveal", "select.search", "select.overview", "select.sticky", NAVIGATE_EVENT].some(
    (e) => tr.isUserEvent(e),
  );
}
const MAX_ENTRIES = 100;

const sameTarget = (a: Omit<NavigationLocation, "time">, b: Omit<NavigationLocation, "time">) =>
  a.path === b.path && a.input?.key === b.input?.key && a.paneId === b.paneId;

const samePlace = (a: Omit<NavigationLocation, "time">, b: Omit<NavigationLocation, "time">) =>
  sameTarget(a, b) && (Boolean(a.input) || Math.abs(a.line - b.line) < MERGE_LINES);

export class NavigationHistory {
  entries: NavigationLocation[] = [];
  index = -1;
  private listeners = new Set<() => void>();

  constructor(private now: () => number = Date.now) {}

  get current(): NavigationLocation | null {
    return this.entries[this.index] ?? null;
  }

  canGoBack() {
    return this.index > 0;
  }

  canGoForward() {
    return this.index < this.entries.length - 1;
  }

  /**
   * Records the caret position or editor tab. `navigation`: the move came
   * from a navigation command; a tab or split-pane switch always counts as one.
   */
  update(loc: Omit<NavigationLocation, "time">, navigation = false) {
    const entry = { ...loc, time: this.now() };
    const cur = this.current;
    if (!cur) {
      this.entries = [entry];
      this.index = 0;
      this.emit();
      return;
    }
    const switched = !sameTarget(cur, loc);
    if (!switched && (!navigation || cur.line === loc.line)) {
      this.entries[this.index] = entry;
      return;
    }
    // The place we leave becomes a back entry, merged with a close one before it.
    this.entries = this.entries.slice(0, this.index + 1);
    const prev = this.entries[this.index - 1];
    if (prev && samePlace(prev, cur)) this.entries.splice(this.index - 1, 1);
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    this.index = this.entries.length - 1;
    this.emit();
  }

  /** Moves back to the previous accepted entry; skips duplicates exposed by stale entries. */
  back(accept?: (loc: NavigationLocation) => boolean): NavigationLocation | null {
    const cur = this.current;
    let skipped = false;
    for (let i = this.index - 1; i >= 0; i--) {
      const candidate = this.entries[i]!;
      if (accept && !accept(candidate)) {
        skipped = true;
        continue;
      }
      if (skipped && cur && samePlace(candidate, cur)) continue;
      this.index = i;
      this.emit();
      return candidate;
    }
    return null;
  }

  /** Moves forward to the next accepted entry; skips duplicates exposed by stale entries. */
  forward(accept?: (loc: NavigationLocation) => boolean): NavigationLocation | null {
    const cur = this.current;
    let skipped = false;
    for (let i = this.index + 1; i < this.entries.length; i++) {
      const candidate = this.entries[i]!;
      if (accept && !accept(candidate)) {
        skipped = true;
        continue;
      }
      if (skipped && cur && samePlace(candidate, cur)) continue;
      this.index = i;
      this.emit();
      return candidate;
    }
    return null;
  }

  /** Drops entries of a deleted file and collapses newly adjacent duplicates. */
  removePath(path: string) {
    if (!path) return;
    const before = this.entries.length;
    const cur = this.current;
    const kept: NavigationLocation[] = [];
    let nextIndex = -1;
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i]!;
      if (entry.path === path) continue;
      const prev = kept[kept.length - 1];
      if (prev && samePlace(prev, entry)) {
        kept[kept.length - 1] = entry;
        if (entry === cur || i <= this.index) nextIndex = kept.length - 1;
      } else {
        kept.push(entry);
        if (entry === cur || (nextIndex < 0 && i >= this.index)) nextIndex = kept.length - 1;
      }
    }
    if (kept.length === before) return;
    this.entries = kept;
    this.index = cur && cur.path !== path ? Math.min(nextIndex, kept.length - 1) : kept.length - 1;
    this.emit();
  }

  clear() {
    this.entries = [];
    this.index = -1;
    this.emit();
  }

  /** Text places only (Recent Locations lists file positions); `index` is the current one's among them. */
  snapshot() {
    const entries = this.entries.filter((e) => !e.input).map((e) => ({ ...e }));
    const index = this.entries.slice(0, this.index + 1).filter((e) => !e.input).length - 1;
    return { entries, index };
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    this.listeners.forEach((l) => l());
  }
}
