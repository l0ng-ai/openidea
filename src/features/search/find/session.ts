/**
 * Find in Files request lifecycle:
 *
 *   idle ──search(q)──▶ validating ──ok──▶ searching ──done──▶ done
 *                           │                  │
 *                        invalid            error
 *
 * A new `search()` supersedes whatever is running: the previous backend
 * request is cancelled and its late events are dropped. Results stream in
 * per file and are published at most once per `PUBLISH_INTERVAL_MS`, so a burst of
 * files costs one view update instead of one per file.
 */
import type { FileMatches, RequestId, SearchQuery, SearchSummary } from "@/platform/ipc";
import { preserveCase } from "@/platform/search";

export type FindStatus = "idle" | "validating" | "invalid" | "searching" | "done" | "error";

export interface FindState {
  status: FindStatus;
  query: SearchQuery | null;
  /** Retained rows belong to a superseded search. */
  stale: boolean;
  files: readonly FileMatches[];
  matchCount: number;
  summary: SearchSummary | null;
  /** Validation or search error message. */
  error: string | null;
}

export interface FindDeps {
  validate(q: SearchQuery): Promise<void>;
  start(request: RequestId, q: SearchQuery, onFile: (f: FileMatches) => void): Promise<SearchSummary | null>;
  cancel(request: RequestId): void;
  nextRequestId(): RequestId;
}

/** Streamed results reach the view at most this often (a few frames), keeping a long stream linear. */
const PUBLISH_INTERVAL_MS = 50;

export const countFileMatches = (file: FileMatches): number =>
  file.matches.reduce((count, line) => count + line.ranges.length, 0);

export const IDLE: FindState = {
  status: "idle",
  query: null,
  stale: false,
  files: [],
  matchCount: 0,
  summary: null,
  error: null,
};

function errorMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

function isCancelledError(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { kind?: unknown }).kind === "cancelled";
}

export class FindSession {
  private seq = 0;
  private request: RequestId | null = null;
  private state: FindState = IDLE;
  private queued = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastPublish = 0;
  private disposed = false;

  constructor(
    private readonly deps: FindDeps,
    private readonly onChange: (s: FindState) => void,
  ) {}

  get current(): FindState {
    return this.state;
  }

  /** Invalidates immediately, before a debounced search starts, keeping the layout steady. */
  invalidate() {
    this.seq++;
    this.cancelRunning();
    this.update({ ...this.state, stale: true, matchCount: 0, summary: null, error: null }, true);
  }

  /** Starts (or restarts) a search; missing query or pattern resets to idle. */
  async search(query: SearchQuery | null): Promise<void> {
    const seq = ++this.seq;
    this.disposed = false;
    this.cancelRunning();
    if (!query?.pattern) {
      this.update({ ...IDLE }, true);
      return;
    }
    this.update(
      { ...this.state, status: "validating", query, stale: true, matchCount: 0, summary: null, error: null },
      true,
    );
    try {
      await this.deps.validate(query);
    } catch (e) {
      if (seq !== this.seq) return;
      this.update({ ...IDLE, status: "invalid", query, error: errorMessage(e) }, true);
      return;
    }
    if (seq !== this.seq || this.disposed) return;

    const request = this.deps.nextRequestId();
    this.request = request;
    this.lastPublish = 0;
    const files: FileMatches[] = [];
    let matchCount = 0;
    this.update({ ...this.state, status: "searching" }, true);
    try {
      const summary = await this.deps.start(request, query, (f) => {
        if (seq !== this.seq) return;
        files.push(f);
        matchCount += countFileMatches(f);
        this.update({ ...this.state, stale: false, files: [...files], matchCount });
      });
      if (seq !== this.seq) return;
      this.request = null;
      this.update({ ...this.state, status: "done", stale: false, files: [...files], matchCount, summary }, true);
    } catch (e) {
      if (seq !== this.seq) return;
      this.request = null;
      if (isCancelledError(e))
        this.update({ ...this.state, status: "done", stale: false, files: [...files], matchCount }, true);
      else
        this.update(
          { ...this.state, status: "error", stale: false, files: [...files], matchCount, error: errorMessage(e) },
          true,
        );
    }
  }

  /** Stops the running search, keeping results found so far. */
  cancel() {
    this.seq++;
    if (this.cancelRunning() && this.state.status === "searching") this.update({ ...this.state, status: "done" }, true);
  }

  /** Cancels and stops publishing; a later `search()` revives the session. */
  dispose() {
    this.cancel();
    this.disposed = true;
  }

  private cancelRunning(): boolean {
    if (this.request === null) return false;
    this.deps.cancel(this.request);
    this.request = null;
    return true;
  }

  private update(next: FindState, immediate = false) {
    this.state = next;
    if (this.disposed) return;
    if (immediate) {
      this.publish(false);
      return;
    }
    if (this.timer !== undefined || this.queued) return;
    // A streamed file publishes at once when the last publish is old enough (the first file shows
    // without delay); otherwise it waits so the batch behind it is one update, not one per file.
    const wait = this.lastPublish + PUBLISH_INTERVAL_MS - Date.now();
    if (wait <= 0) {
      this.queued = true;
      queueMicrotask(() => {
        if (this.queued) this.publish(true);
      });
    } else this.timer = setTimeout(() => this.publish(true), wait);
  }

  private publish(streamed: boolean) {
    this.queued = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.disposed) return;
    if (streamed) this.lastPublish = Date.now();
    this.onChange(this.state);
  }
}

/** Flat result rows (one per matching line) as shown by the popup. */
export interface MatchRow {
  key: string;
  path: string;
  relPath: string;
  line: number;
  /** Preview text (leading whitespace trimmed). */
  text: string;
  /** Column of `text` in the real line. */
  textCol: number;
  /** Highlight ranges within `text`. */
  ranges: Array<[number, number]>;
  /** First match column in the real line. */
  col: number;
  endCol: number;
  /** Raw matched substrings (for replace previews). */
  matched: string[];
  /** Start of every match on the line (identifies the usages to replace). */
  starts: Array<{ line: number; col: number }>;
}

export function matchRows(files: readonly FileMatches[]): MatchRow[] {
  const rows: MatchRow[] = [];
  for (const f of files) {
    for (const m of f.matches) {
      const lead = m.text.length - m.text.trimStart().length;
      const text = m.text.slice(lead).trimEnd();
      const ranges = m.ranges
        .map(([s, e]) => [Math.max(0, s - lead), Math.min(text.length, e - lead)] as [number, number])
        .filter(([s, e]) => e > s);
      const first = m.ranges[0] ?? [0, 0];
      rows.push({
        // A long line comes in several windows: the column tells them apart.
        key: `${f.path}:${m.line}:${first[0] + m.textOffset}`,
        path: f.path,
        relPath: f.relPath,
        line: m.line,
        text,
        textCol: lead + m.textOffset,
        ranges,
        col: first[0] + m.textOffset,
        endCol: first[1] + m.textOffset,
        matched: m.ranges.map(([s, e]) => m.text.slice(s, e)),
        starts: m.ranges.map(([s]) => ({ line: m.line, col: s + m.textOffset })),
      });
    }
  }
  return rows;
}

/**
 * Preview of what Replace produces for one match. Regex replacements accept
 * the backend's (Rust `regex`) `$1` / `${1}` / `${name}` syntax.
 */
export function previewReplacement(
  matched: string,
  query: Pick<SearchQuery, "pattern" | "isRegex" | "caseSensitive">,
  replacement: string,
  preserve = false,
): string {
  const out = (() => {
    if (!query.isRegex) return replacement;
    try {
      const js = replacement.replace(/\$\{(\d+)\}/g, "$$$1").replace(/\$\{([A-Za-z_]\w*)\}/g, "$$<$1>");
      const re = new RegExp(query.pattern, query.caseSensitive ? "u" : "iu");
      return matched.replace(re, js);
    } catch {
      return replacement;
    }
  })();
  return preserve ? preserveCase(matched, out) : out;
}

/** Ranges → highlight indices (for `HighlightedText`). */
export function rangesToIndices(ranges: ReadonlyArray<readonly [number, number]>): number[] {
  const out: number[] = [];
  for (const [s, e] of ranges) for (let i = s; i < e; i++) out.push(i);
  return [...new Set(out)].sort((a, b) => a - b);
}
