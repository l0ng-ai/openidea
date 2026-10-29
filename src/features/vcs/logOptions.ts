/**
 * Git Log presentation options (IDEA's Graph Options and View Options menus),
 * persisted across sessions.
 */
import { create } from "zustand";

export type LogSort = "date" | "topo";

export interface LogOptions {
  sort: LogSort;
  firstParent: boolean;
  noMerges: boolean;
  collapseLinear: boolean;
  compactRefs: boolean;
  tagNames: boolean;
  longEdges: boolean;
  commitTimestamp: boolean;
  refsOnLeft: boolean;
  showAuthor: boolean;
  showDate: boolean;
  showHash: boolean;
  highlightMine: boolean;
  highlightMerges: boolean;
  highlightCurrentBranch: boolean;
  /** The Branches pane on the left of the log. */
  showBranches: boolean;
  /** Changed files grouped by directory (else a flat list). */
  groupByDirectory: boolean;
  /** Selecting a changed file shows its diff in the editor's preview tab. */
  diffPreview: boolean;
}

/** IDEA's defaults. */
export const DEFAULT_LOG_OPTIONS: LogOptions = {
  sort: "date",
  firstParent: false,
  noMerges: false,
  collapseLinear: false,
  compactRefs: true,
  tagNames: false,
  longEdges: false,
  commitTimestamp: false,
  refsOnLeft: false,
  showAuthor: true,
  showDate: true,
  showHash: false,
  highlightMine: true,
  highlightMerges: true,
  highlightCurrentBranch: true,
  showBranches: true,
  groupByDirectory: true,
  diffPreview: true,
};

/** Options that change which commits the backend returns (a reload is needed). */
export const QUERY_OPTIONS: ReadonlyArray<keyof LogOptions> = ["sort", "firstParent", "noMerges"];

const KEY = "openidea.vcs.logOptions";

export function parseLogOptions(raw: unknown): LogOptions {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out = { ...DEFAULT_LOG_OPTIONS };
  for (const k of Object.keys(out) as Array<keyof LogOptions>) {
    if (k === "sort") out.sort = o.sort === "topo" ? "topo" : o.sort === "date" ? "date" : DEFAULT_LOG_OPTIONS.sort;
    else if (typeof o[k] === "boolean") (out as Record<string, unknown>)[k] = o[k];
  }
  return out;
}

function load(): LogOptions {
  try {
    const raw = localStorage.getItem(KEY);
    return parseLogOptions(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_LOG_OPTIONS };
  }
}

export const useLogOptions = create<LogOptions>(() => load());

// Settings › Version Control › Log edits them from the Settings window too.
if (typeof window !== "undefined")
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) useLogOptions.setState(load());
  });

export const logOptions = () => useLogOptions.getState();

export type RefKind = "head" | "local" | "remote" | "tag";

export interface RefLabel {
  kind: RefKind;
  /** Empty for a tag shown without its name. */
  text: string;
  title: string;
}

/**
 * Reference labels of a commit row. `refs` are decorations (`HEAD`, `main`,
 * `origin/main`, `tag: v1`); `remoteNames` the remote-tracking branch names.
 * Compact: a local branch absorbs its remote-tracking branches (`origin & main`) and
 * HEAD is left out next to other references. Without tag names, tags are one icon.
 */
export function refLabels(
  refs: readonly string[],
  opts: { compact: boolean; tagNames: boolean },
  remoteNames: ReadonlySet<string>,
): RefLabel[] {
  const isRemote = (r: string) => (remoteNames.size ? remoteNames.has(r) : r.includes("/"));
  const tags = refs.filter((r) => r.startsWith("tag: ")).map((r) => r.slice(5));
  const branches = refs.filter((r) => r !== "HEAD" && !r.startsWith("tag: "));
  const out: RefLabel[] = [];
  if (refs.includes("HEAD") && (!opts.compact || !branches.length))
    out.push({ kind: "head", text: "HEAD", title: "HEAD" });
  const locals = branches.filter((b) => !isRemote(b));
  const remotes = branches.filter(isRemote);
  const absorbed = new Set<string>();
  for (const l of locals) {
    const tracking = opts.compact ? remotes.filter((r) => r.endsWith(`/${l}`)) : [];
    tracking.forEach((r) => absorbed.add(r));
    const prefixes = tracking.map((r) => r.slice(0, -l.length - 1));
    out.push({
      kind: "local",
      text: prefixes.length ? `${prefixes.join(", ")} & ${l}` : l,
      title: [l, ...tracking].join(", "),
    });
  }
  for (const r of remotes) if (!absorbed.has(r)) out.push({ kind: "remote", text: r, title: r });
  if (tags.length) {
    if (opts.tagNames) out.push(...tags.map((t) => ({ kind: "tag" as const, text: t, title: t })));
    else out.push({ kind: "tag", text: "", title: tags.join(", ") });
  }
  return out;
}

/** Updates options and persists them; returns whether the log has to be reloaded. */
export function setLogOptions(patch: Partial<LogOptions>): boolean {
  const before = useLogOptions.getState();
  useLogOptions.setState(patch);
  const after = useLogOptions.getState();
  try {
    localStorage.setItem(KEY, JSON.stringify(after));
  } catch {
    // Storage unavailable: the options last for this session.
  }
  return QUERY_OPTIONS.some((k) => before[k] !== after[k]);
}
