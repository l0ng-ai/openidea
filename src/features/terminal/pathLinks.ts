/**
 * Modifier-gated (`⌘` on macOS, `Ctrl` on Windows/Linux) hover hyperlinks for
 * bare file and folder names in terminal output (`ls`, `git status`, `rg`, paths):
 *
 * - Idle movement without the modifier does zero filesystem I/O and leaves mouse
 *   selection and word double-click untouched.
 * - Holding `⌘`/`Ctrl` over a token probes only that token (cached per cwd and
 *   invalidated on new terminal output), tinting and underlining it only when the
 *   target actually exists on disk.
 * - Clicking opens files in an editor tab of the current window, and opens
 *   in-project folders in the Project view (or reveals out-of-project folders in
 *   the OS file manager).
 */
import type { IDecoration, IDisposable, IMarker, Terminal } from "@xterm/xterm";
import { executeAction } from "@/platform/actions";
import { revealInFileManager } from "@/platform/fileManager";
import { call, commands, isTauri } from "@/platform/ipc";
import { usePlatform } from "@/platform/platformInfo";
import { useProject } from "@/platform/project";
import { isRemoteWindow } from "@/platform/remote";
import { workflowSettings } from "@/platform/workflowSettings";
import { editorService } from "@/workbench/contributions";
import { LINK_DECORATION_CLASS, linkCells } from "./linkHighlights";
import { findPathCandidates, normalizeCandidatePath, resolvePath, type PathCandidate } from "./links";

export const PATH_LINK_DECORATION_CLASS = "openidea-terminal-path-link";
export const PATH_HOVER_CLASS = "openidea-terminal-path-hover";

const CACHE_TTL_MS = 2_000;

export interface ResolvedPathTarget {
  kind: "file" | "dir";
  path: string;
}

export interface ResolvePathOptions {
  projectRoot?: string | null;
  home?: string | null;
}

let cachedHome: Promise<string | null> | null = null;

function resolveLocalHome(): Promise<string | null> {
  if (!isTauri() || isRemoteWindow()) return Promise.resolve(null);
  return (cachedHome ??= import("@tauri-apps/api/path")
    .then(({ homeDir }) => homeDir())
    .then((h) => h.replace(/[\\/]+$/, "") || null)
    .catch(() => {
      cachedHome = null;
      return null;
    }));
}

export function _resetPathLinksHomeForTests() {
  cachedHome = null;
}

/** `⌘` on macOS, `Ctrl` on Windows and Linux (with no competing modifiers). */
export function isPathLinkModifier(
  e: Pick<MouseEvent | KeyboardEvent, "metaKey" | "ctrlKey" | "altKey">,
  os = usePlatform.getState().os,
): boolean {
  if (e.altKey) return false;
  return os === "macos" ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

async function statKind(path: string): Promise<"file" | "dir" | null> {
  try {
    const kind = await call(commands.fsEntryKind(path));
    return kind === "dir" ? "dir" : kind === "file" ? "file" : null;
  } catch {
    return null;
  }
}

function isExplicitPath(cleaned: string): boolean {
  return (
    cleaned.startsWith("/") ||
    cleaned.startsWith("\\") ||
    cleaned === "~" ||
    cleaned.startsWith("~/") ||
    cleaned.startsWith("~\\") ||
    cleaned.startsWith("./") ||
    cleaned.startsWith("../") ||
    cleaned.startsWith(".\\") ||
    cleaned.startsWith("..\\") ||
    /^[A-Za-z]:[\\/]/.test(cleaned)
  );
}

/**
 * Resolves a terminal path candidate against `cwd` (then `projectRoot` and, for
 * implicit file paths with a slash or extension, `findFiles`), returning `null`
 * when the target does not exist.
 */
export async function resolvePathTarget(
  rawPath: string,
  cwd: string,
  opts: ResolvePathOptions = {},
): Promise<ResolvedPathTarget | null> {
  const trailingSlash =
    /[\\/]$/.test(rawPath) && rawPath !== "/" && rawPath !== "\\" && !/^[A-Za-z]:[\\/]$/.test(rawPath);
  const cleaned = normalizeCandidatePath(rawPath);
  if (!cleaned) return null;

  let home: string | null | undefined = opts.home;
  if (home === undefined && (cleaned === "~" || cleaned.startsWith("~/") || cleaned.startsWith("~\\"))) {
    home = await resolveLocalHome();
    if (!home) return null;
  }

  const checkAt = async (candidate: string, base: string): Promise<ResolvedPathTarget | null> => {
    const resolved = resolvePath(candidate, base, home);
    const kind = await statKind(resolved);
    if (kind === "dir") return { kind: "dir", path: resolved };
    if (kind === "file" && !trailingSlash) return { kind: "file", path: resolved };
    return null;
  };

  const primary = await checkAt(cleaned, cwd);
  if (primary) return primary;

  if (isExplicitPath(cleaned)) return null;

  const root = opts.projectRoot !== undefined ? opts.projectRoot : (useProject.getState().project?.root ?? null);
  if (root && resolvePath(cleaned, root, home) !== resolvePath(cleaned, cwd, home)) {
    const inRoot = await checkAt(cleaned, root);
    if (inRoot) return inRoot;
  }

  // `git diff` headers (`a/src/App.tsx`, `b/src/features/`).
  if (/^[ab][\\/].+/.test(cleaned)) {
    const stripped = cleaned.slice(2);
    const fromCwd = await checkAt(stripped, cwd);
    if (fromCwd) return fromCwd;
    if (root && resolvePath(stripped, root, home) !== resolvePath(stripped, cwd, home)) {
      const fromRoot = await checkAt(stripped, root);
      if (fromRoot) return fromRoot;
    }
  }

  if (!trailingSlash && root && (/[/\\]/.test(cleaned) || /^[^.][^/\\]*\.[A-Za-z][\w]{0,9}$/.test(cleaned))) {
    const rel = cleaned.replace(/\\/g, "/");
    try {
      const hits = await call(commands.findFiles(rel, 5));
      const hit = hits.find((h) => h.relPath === rel || h.relPath.endsWith(`/${rel}`));
      if (hit) return { kind: "file", path: hit.path };
    } catch {
      /* ignore */
    }
  }

  return null;
}

/**
 * Opens a resolved terminal path target: files open in an editor tab of this
 * window; folders inside the project expand and select in the Project view, and
 * folders outside the project reveal in the OS file manager.
 */
export async function openPathTarget(target: ResolvedPathTarget): Promise<void> {
  if (target.kind === "file") {
    await editorService().openFile(target.path, { focus: true });
    return;
  }
  const handled = await executeAction("navigate.selectIn", {
    path: target.path,
    expand: true,
    revealOutside: true,
  });
  if (!handled) await revealInFileManager(target.path);
}

interface CellHit {
  col: number;
  viewRow: number;
  bufferRow: number;
  cellWidth: number;
  cellHeight: number;
}

function cellFromClientPoint(term: Terminal, clientX: number, clientY: number): CellHit | null {
  const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
  if (!screen || term.cols <= 0 || term.rows <= 0) return null;
  const rect = screen.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  if (clientX < rect.left || clientX >= rect.right || clientY < rect.top || clientY >= rect.bottom) return null;
  const col = Math.floor(((clientX - rect.left) / rect.width) * term.cols);
  const viewRow = Math.floor(((clientY - rect.top) / rect.height) * term.rows);
  if (col < 0 || col >= term.cols || viewRow < 0 || viewRow >= term.rows) return null;
  return {
    col,
    viewRow,
    bufferRow: term.buffer.active.viewportY + viewRow,
    cellWidth: rect.width / term.cols,
    cellHeight: rect.height / term.rows,
  };
}

interface RowCandidateMatch {
  candidate: PathCandidate;
  start: number;
  end: number;
}

function candidatesAtCell(term: Terminal, bufferRow: number, col: number): RowCandidateMatch[] {
  const line = term.buffer.active.getLine(bufferRow);
  if (!line) return [];
  const text = line.translateToString(true);
  if (!text) return [];
  return findPathCandidates(text)
    .map((candidate) => ({ candidate, ...linkCells(line, candidate) }))
    .filter((m) => m.end > m.start && col >= m.start && col < m.end);
}

export interface ModifierPathLinksController extends IDisposable {
  refresh(): void;
  clearCache(): void;
}

export function installModifierPathLinks(
  term: Terminal,
  host: HTMLElement,
  opts: { cwd: () => string; color: () => string },
): ModifierPathLinksController {
  const cache = new Map<
    string,
    {
      expiresAt: number;
      settled: boolean;
      value: ResolvedPathTarget | null;
      promise: Promise<ResolvedPathTarget | null>;
    }
  >();
  let disposed = false;
  let pointer: { x: number; y: number } | null = null;
  let modifierHeld = false;
  let hoverSeq = 0;
  let downPoint: { x: number; y: number } | null = null;
  let suppressClick = false;
  let altUnderline: HTMLDivElement | null = null;
  let active: {
    bufferRow: number;
    viewRow: number;
    startCol: number;
    endCol: number;
    target: ResolvedPathTarget;
    marker?: IMarker;
    decoration?: IDecoration;
  } | null = null;

  const cacheKey = (rawPath: string) => {
    const cwd = opts.cwd();
    const root = useProject.getState().project?.root ?? "";
    return { cwd, key: `${cwd}\0${root}\0${rawPath}` };
  };

  const peekCached = (rawPath: string): { hit: boolean; value: ResolvedPathTarget | null } => {
    const entry = cache.get(cacheKey(rawPath).key);
    if (!entry || entry.expiresAt <= Date.now() || !entry.settled) return { hit: false, value: null };
    return { hit: true, value: entry.value };
  };

  const probe = (rawPath: string): Promise<ResolvedPathTarget | null> => {
    const { cwd, key } = cacheKey(rawPath);
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now) return hit.promise;
    const entry = {
      expiresAt: now + CACHE_TTL_MS,
      settled: false,
      value: null as ResolvedPathTarget | null,
      promise: Promise.resolve<ResolvedPathTarget | null>(null),
    };
    entry.promise = resolvePathTarget(rawPath, cwd).then((res) => {
      entry.settled = true;
      entry.value = res;
      return res;
    });
    cache.set(key, entry);
    return entry.promise;
  };

  const disposeDecoration = () => {
    if (active) {
      active.decoration?.dispose();
      active.marker?.dispose();
      active = null;
    }
    if (altUnderline) altUnderline.style.display = "none";
    term.element?.classList.remove(PATH_HOVER_CLASS);
  };

  const clearHover = () => {
    hoverSeq++;
    disposeDecoration();
  };

  const showDecoration = (cell: CellHit, startCol: number, endCol: number, target: ResolvedPathTarget) => {
    if (
      active &&
      active.bufferRow === cell.bufferRow &&
      active.startCol === startCol &&
      active.endCol === endCol &&
      active.target.kind === target.kind &&
      active.target.path === target.path &&
      !active.marker?.isDisposed
    ) {
      return;
    }
    disposeDecoration();
    term.element?.classList.add(PATH_HOVER_CLASS);
    const buf = term.buffer.active;
    if (buf.type === "normal") {
      const marker = term.registerMarker(cell.bufferRow - (buf.baseY + buf.cursorY));
      if (marker) {
        const decoration = term.registerDecoration({
          marker,
          x: startCol,
          width: endCol - startCol,
          foregroundColor: opts.color(),
        });
        if (decoration) {
          decoration.onRender((el) => el.classList.add(LINK_DECORATION_CLASS, PATH_LINK_DECORATION_CLASS));
          active = { bufferRow: cell.bufferRow, viewRow: cell.viewRow, startCol, endCol, target, marker, decoration };
          return;
        }
        marker.dispose();
      }
    }
    const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
    if (screen) {
      if (!altUnderline || !altUnderline.isConnected) {
        altUnderline = document.createElement("div");
        altUnderline.className = `xterm-decoration ${LINK_DECORATION_CLASS} ${PATH_LINK_DECORATION_CLASS}`;
        altUnderline.setAttribute("aria-hidden", "true");
        altUnderline.style.position = "absolute";
        screen.appendChild(altUnderline);
      }
      Object.assign(altUnderline.style, {
        display: "block",
        left: `${startCol * cell.cellWidth}px`,
        top: `${cell.viewRow * cell.cellHeight}px`,
        width: `${(endCol - startCol) * cell.cellWidth}px`,
        height: `${cell.cellHeight}px`,
      });
    }
    active = { bufferRow: cell.bufferRow, viewRow: cell.viewRow, startCol, endCol, target };
  };

  const evaluateAt = async (x: number, y: number) => {
    if (disposed || !workflowSettings().terminal.highlightHyperlinks || !modifierHeld) {
      clearHover();
      return;
    }
    const cell = cellFromClientPoint(term, x, y);
    if (!cell) {
      clearHover();
      return;
    }
    if (
      active &&
      active.bufferRow === cell.bufferRow &&
      cell.col >= active.startCol &&
      cell.col < active.endCol &&
      !active.marker?.isDisposed
    ) {
      return;
    }
    const matches = candidatesAtCell(term, cell.bufferRow, cell.col);
    if (!matches.length) {
      clearHover();
      return;
    }
    const seq = ++hoverSeq;
    disposeDecoration();
    for (const match of matches) {
      // oxlint-disable-next-line no-await-in-loop -- outer quoted path takes precedence; probe inner token only if outer misses
      const target = await probe(match.candidate.path);
      if (disposed || seq !== hoverSeq || !modifierHeld) return;
      if (target) {
        const now = pointer ? cellFromClientPoint(term, pointer.x, pointer.y) : null;
        if (now && now.bufferRow === cell.bufferRow && now.col >= match.start && now.col < match.end) {
          showDecoration(now, match.start, match.end, target);
        }
        return;
      }
    }
    clearHover();
  };

  const onMouseMove = (e: MouseEvent) => {
    pointer = { x: e.clientX, y: e.clientY };
    modifierHeld = isPathLinkModifier(e);
    if (modifierHeld) void evaluateAt(e.clientX, e.clientY);
    else if (active) clearHover();
  };

  const onMouseLeave = () => {
    pointer = null;
    downPoint = null;
    clearHover();
  };

  const onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0 || !workflowSettings().terminal.highlightHyperlinks || !isPathLinkModifier(e)) {
      downPoint = null;
      return;
    }
    const cell = cellFromClientPoint(term, e.clientX, e.clientY);
    if (!cell) {
      downPoint = null;
      return;
    }
    if (active && active.bufferRow === cell.bufferRow && cell.col >= active.startCol && cell.col < active.endCol) {
      downPoint = { x: e.clientX, y: e.clientY };
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const matches = candidatesAtCell(term, cell.bufferRow, cell.col);
    // Only intercept an unprobed / positive candidate; known non-existent tokens pass straight to xterm.
    const couldMatch = matches.some((m) => {
      const c = peekCached(m.candidate.path);
      return !c.hit || c.value !== null;
    });
    if (!couldMatch) {
      downPoint = null;
      return;
    }
    downPoint = { x: e.clientX, y: e.clientY };
    e.preventDefault();
    e.stopPropagation();
  };

  const onMouseUp = (e: MouseEvent) => {
    const start = downPoint;
    downPoint = null;
    if (!start || e.button !== 0) return;
    // Always pair-consume `mouseup` when `mousedown` was consumed so xterm never sees a half-press.
    e.preventDefault();
    e.stopPropagation();
    suppressClick = true;
    if (!workflowSettings().terminal.highlightHyperlinks || !isPathLinkModifier(e)) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 4) return;
    const cell = cellFromClientPoint(term, e.clientX, e.clientY);
    if (!cell) return;
    if (active && active.bufferRow === cell.bufferRow && cell.col >= active.startCol && cell.col < active.endCol) {
      const target = active.target;
      clearHover();
      void openPathTarget(target);
      return;
    }
    const matches = candidatesAtCell(term, cell.bufferRow, cell.col);
    if (!matches.length) return;
    clearHover();
    void (async () => {
      for (const match of matches) {
        // oxlint-disable-next-line no-await-in-loop -- outer quoted path takes precedence over inner token
        const target = await probe(match.candidate.path);
        if (disposed) return;
        if (target) {
          // oxlint-disable-next-line no-await-in-loop -- the first candidate that resolves is opened, then the loop stops
          await openPathTarget(target);
          return;
        }
      }
    })();
  };

  const onClick = (e: MouseEvent) => {
    if (!suppressClick) return;
    suppressClick = false;
    e.preventDefault();
    e.stopPropagation();
  };

  const onKeyChange = (e: KeyboardEvent) => {
    const next = isPathLinkModifier(e);
    if (next === modifierHeld) return;
    modifierHeld = next;
    if (!next) clearHover();
    else if (pointer) void evaluateAt(pointer.x, pointer.y);
  };

  const onBlur = () => {
    modifierHeld = false;
    downPoint = null;
    clearHover();
  };

  host.addEventListener("mousemove", onMouseMove);
  host.addEventListener("mouseleave", onMouseLeave);
  host.addEventListener("mousedown", onMouseDown, true);
  host.addEventListener("mouseup", onMouseUp, true);
  host.addEventListener("click", onClick, true);
  if (typeof window !== "undefined") {
    window.addEventListener("keydown", onKeyChange, true);
    window.addEventListener("keyup", onKeyChange, true);
    window.addEventListener("blur", onBlur);
  }

  const subs = [
    term.onWriteParsed?.(() => cache.clear()),
    term.onScroll?.(() => {
      if (modifierHeld && pointer) void evaluateAt(pointer.x, pointer.y);
      else clearHover();
    }),
    term.buffer?.onBufferChange?.(() => {
      if (modifierHeld && pointer) void evaluateAt(pointer.x, pointer.y);
      else clearHover();
    }),
  ].filter((s): s is IDisposable => !!s);

  return {
    refresh() {
      if (!workflowSettings().terminal.highlightHyperlinks) {
        clearHover();
        return;
      }
      if (active && pointer && modifierHeld) {
        disposeDecoration();
        void evaluateAt(pointer.x, pointer.y);
      }
    },
    clearCache() {
      cache.clear();
    },
    dispose() {
      disposed = true;
      clearHover();
      altUnderline?.remove();
      altUnderline = null;
      cache.clear();
      subs.forEach((s) => s.dispose());
      host.removeEventListener("mousemove", onMouseMove);
      host.removeEventListener("mouseleave", onMouseLeave);
      host.removeEventListener("mousedown", onMouseDown, true);
      host.removeEventListener("mouseup", onMouseUp, true);
      host.removeEventListener("click", onClick, true);
      if (typeof window !== "undefined") {
        window.removeEventListener("keydown", onKeyChange, true);
        window.removeEventListener("keyup", onKeyChange, true);
        window.removeEventListener("blur", onBlur);
      }
    },
  };
}
