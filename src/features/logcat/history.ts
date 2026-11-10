/**
 * Recent filter expressions of the Logcat tool window, kept in `localStorage` so
 * they survive a restart (IDEA's logcat keeps a short history too). Newest first.
 */
const KEY = "openidea.logcat.filters";
const MAX = 20;

function store(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function save(list: string[]) {
  try {
    store()?.setItem(KEY, JSON.stringify(list));
  } catch {
    // Storage disabled or full: the history is a convenience, not state to lose sleep over.
  }
}

export function loadFilters(): string[] {
  try {
    const raw = store()?.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string" && v.trim() !== "").slice(0, MAX);
  } catch {
    return [];
  }
}

/** Puts `query` at the front (an empty one is not worth remembering) and returns the new list. */
export function rememberFilter(query: string): string[] {
  const text = query.trim();
  const rest = loadFilters().filter((q) => q !== text);
  const list = text ? [text, ...rest].slice(0, MAX) : rest;
  save(list);
  return list;
}

export function forgetFilters(): string[] {
  save([]);
  return [];
}
