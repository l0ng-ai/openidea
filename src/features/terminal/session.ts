/**
 * One terminal session: an xterm.js instance bound to a backend PTY. The xterm
 * lives in a detached host element owned by the session (not by React), so a
 * session survives its tool window being hidden or its pane being re-mounted.
 */
import { Terminal, type IDisposable, type ILink } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import { Channel } from "@tauri-apps/api/core";
import { call, commands, isTauri, type TerminalId } from "@/platform/ipc";
import { editorService, notifications } from "@/workbench/contributions";
import { findTerminalLinks, resolvePath, type TerminalLink } from "./links";
import { splitCommandLine } from "@/platform/commandLine";
import { useProject } from "@/platform/project";
import { workflowSettings, type TerminalSettingsValid } from "@/platform/workflowSettings";
import { editorPrefs } from "@/platform/editorSettings";
import { readSearchDecorations, readTerminalTheme, remeasureWhenFontsLoad, terminalFont, type EditorFont, type TerminalFontSettings } from "./theme";

export interface TerminalSearchOptions {
  caseSensitive: boolean;
  regex: boolean;
  wholeWord: boolean;
}

export interface TerminalSearchResult {
  /** -1 when the active match is unknown (more matches than the highlight limit). */
  index: number;
  count: number;
}

export type SessionStatus = "idle" | "starting" | "running" | "exited" | "error";

export interface SessionSnapshot {
  status: SessionStatus;
  exitCode: number | null;
  /** Shell name reported by the backend (`zsh`). */
  title: string;
  /** Window title set by the running program (OSC 0/2), null when unset or blank. */
  appTitle: string | null;
  /** Current directory (initial cwd, updated by OSC 7). */
  cwd: string;
}

export interface SessionOptions {
  key: string;
  cwd: string;
  onChange: (key: string, snapshot: SessionSnapshot) => void;
  onFocus: (key: string) => void;
  /** The shell exited (after the exit message was printed). */
  onExit?: (key: string) => void;
  /**
   * Run this program instead of the configured shell (e.g. `docker exec -it <id> sh`).
   * `shell`: it is a shell (a predefined session), so shell integration still applies.
   */
  command?: { program: string; args: string[]; shell?: boolean };
}

/** Mouse-tracking DEC private modes (X10, normal, button, any-event, encodings). */
const MOUSE_MODES = new Set([9, 1000, 1001, 1002, 1003, 1005, 1006, 1015, 1016]);

let audio: AudioContext | null = null;

/** A short beep for BEL (Settings › Terminal › Audible bell). */
function beep() {
  try {
    audio ??= new AudioContext();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.08, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.12);
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 0.13);
  } catch {
    /* no audio */
  }
}

/** The terminal font for `t`, resolved against the current editor font (also used by embedded terminals). */
export function fontFor(t: TerminalFontSettings) {
  const e = useProject.getState().settings?.editor as EditorFont | undefined;
  return terminalFont(t, { ...e, fallbackFont: editorPrefs().fallbackFont });
}

const CURSOR: Record<TerminalSettingsValid["cursorShape"], "block" | "underline" | "bar"> = {
  block: "block",
  underline: "underline",
  bar: "bar",
};

const RESTART_HINT = "\x1b[2mPress Enter to restart\x1b[0m";

export async function openExternal(url: string) {
  try {
    if (isTauri()) {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
    } else {
      window.open(url, "_blank", "noopener");
    }
  } catch (e) {
    notifications().notify({ level: "error", title: "Cannot open link", body: String(e) });
  }
}

export async function openFileLink(link: Extract<TerminalLink, { kind: "file" }>, cwd: string) {
  const selection = link.line ? { line: link.line - 1, col: Math.max(0, (link.col ?? 1) - 1) } : undefined;
  const path = resolvePath(link.path, cwd);
  const name = link.path.split("/").pop() ?? link.path;
  try {
    const slash = path.lastIndexOf("/");
    const entries = await call(commands.fsReadDir(path.slice(0, slash) || "/"));
    if (entries.some((e) => e.name === name && e.kind !== "dir")) {
      await editorService().openFile(path, { selection, focus: true });
      return;
    }
  } catch {
    /* fall back to a project-wide lookup by file name */
  }
  try {
    const [hit] = await call(commands.findFiles(name, 1));
    if (hit && hit.path.endsWith(name)) {
      await editorService().openFile(hit.path, { selection, focus: true });
      return;
    }
  } catch {
    /* ignore */
  }
  notifications().notify({ level: "warning", title: "File not found", body: link.path });
}

export class TerminalSession {
  readonly key: string;
  readonly host: HTMLDivElement;
  readonly term: Terminal;
  private readonly fit = new FitAddon();
  private readonly searchAddon = new SearchAddon({ highlightLimit: 2000 });
  private searchDecorations: ISearchOptions["decorations"] | null = null;
  private readonly searchListeners = new Set<(r: TerminalSearchResult) => void>();
  private readonly opts: SessionOptions;
  private snapshot: SessionSnapshot;
  private ptyId: TerminalId | null = null;
  private opened = false;
  private disposed = false;
  private disposables: IDisposable[] = [];
  private resizeObserver: ResizeObserver | null = null;
  private fitRaf = 0;
  private fitTimer: ReturnType<typeof setTimeout> | undefined;
  private inputRaf = 0;
  private pendingInput = "";
  private lastSize = { cols: 0, rows: 0 };
  /** Bumped on restart so late output from a previous PTY is ignored. */
  private generation = 0;

  constructor(opts: SessionOptions) {
    this.opts = opts;
    this.key = opts.key;
    this.snapshot = { status: "idle", exitCode: null, title: "Local", appTitle: null, cwd: opts.cwd };
    this.host = document.createElement("div");
    this.host.className = "openidea-terminal-host";
    this.host.dataset.terminalSession = opts.key;
    this.host.style.width = "100%";
    this.host.style.height = "100%";

    const settings = workflowSettings().terminal;
    const font = fontFor(settings);
    this.term = new Terminal({
      fontFamily: font.family,
      fontSize: font.size,
      lineHeight: font.lineHeight,
      letterSpacing: font.letterSpacing,
      fontWeight: font.weight,
      fontWeightBold: font.boldWeight,
      cursorBlink: settings.cursorBlink,
      cursorStyle: CURSOR[settings.cursorShape],
      cursorWidth: 2,
      cursorInactiveStyle: "outline",
      allowProposedApi: true,
      scrollback: 10_000,
      macOptionIsMeta: settings.optionAsMeta,
      macOptionClickForcesSelection: true,
      rightClickSelectsWord: false,
      drawBoldTextInBrightColors: false,
      minimumContrastRatio: 1,
      smoothScrollDuration: 0,
      // Same width as the IDE's scrollbars (global.css); the slider is styled there too (Terminal.module.css).
      overviewRuler: { width: 10 },
      theme: readTerminalTheme(),
    });
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.searchAddon);

    this.disposables.push(
      this.searchAddon.onDidChangeResults((r) => {
        for (const l of this.searchListeners) l({ index: r.resultIndex, count: r.resultCount });
      }),
      this.term.onData((data) => this.input(data)),
      this.term.onBinary((data) => this.input(data)),
      this.term.onTitleChange((title) => this.update({ appTitle: title.trim() || null })),
      // OSC 7: `file://host/path` — shells report their cwd so relative links resolve correctly.
      this.term.parser.registerOscHandler(7, (data) => {
        try {
          const url = new URL(data);
          if (url.protocol === "file:") this.update({ cwd: decodeURIComponent(url.pathname) });
        } catch {
          /* ignore malformed */
        }
        return true;
      }),
      this.term.registerLinkProvider({
        provideLinks: (y, callback) => callback(workflowSettings().terminal.highlightHyperlinks ? this.linksAt(y) : undefined),
      }),
      this.term.onBell(() => {
        if (workflowSettings().terminal.audibleBell) beep();
      }),
      this.term.onSelectionChange(() => {
        if (workflowSettings().terminal.copyOnSelection && this.term.hasSelection()) this.copySelection();
      }),
      // Mouse reporting off: ignore the application's requests to enable mouse tracking.
      this.term.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
        if (workflowSettings().terminal.mouseReporting) return false;
        const modes = params.map((p) => (Array.isArray(p) ? p[0] : p) ?? 0);
        return modes.length > 0 && modes.every((m) => MOUSE_MODES.has(m));
      }),
    );
    this.host.addEventListener("mousedown", this.onMiddleClick);
  }

  private onMiddleClick = (e: MouseEvent) => {
    if (e.button !== 1 || !workflowSettings().terminal.pasteOnMiddleClick) return;
    e.preventDefault();
    void navigator.clipboard
      ?.readText()
      .then((t) => t && this.paste(t))
      .catch(() => undefined);
  };

  /** Applies Settings › Tools › Terminal changes to a live session. */
  applySettings(t: TerminalSettingsValid) {
    const font = fontFor(t);
    const o = this.term.options;
    if (o.fontFamily !== font.family) {
      o.fontFamily = font.family;
      if (this.opened) remeasureWhenFontsLoad(this.term, font, () => !this.disposed, () => this.scheduleFit());
    }
    if (o.fontSize !== font.size) o.fontSize = font.size;
    if (o.lineHeight !== font.lineHeight) o.lineHeight = font.lineHeight;
    if (o.letterSpacing !== font.letterSpacing) o.letterSpacing = font.letterSpacing;
    if (o.fontWeight !== font.weight) o.fontWeight = font.weight;
    if (o.fontWeightBold !== font.boldWeight) o.fontWeightBold = font.boldWeight;
    o.cursorStyle = CURSOR[t.cursorShape];
    o.cursorBlink = t.cursorBlink;
    o.macOptionIsMeta = t.optionAsMeta;
    this.scheduleFit();
  }

  get state(): SessionSnapshot {
    return this.snapshot;
  }

  get hasSelection(): boolean {
    return this.term.hasSelection();
  }

  private update(patch: Partial<SessionSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.opts.onChange(this.key, this.snapshot);
  }

  private linksAt(y: number): ILink[] | undefined {
    const line = this.term.buffer.active.getLine(y - 1);
    if (!line) return undefined;
    const text = line.translateToString(true);
    const found = findTerminalLinks(text);
    if (found.length === 0) return undefined;
    return found.map((l) => ({
      text: l.text,
      range: { start: { x: l.start + 1, y }, end: { x: l.end, y } },
      decorations: { underline: true, pointerCursor: true },
      activate: (event: MouseEvent) => {
        // Plain click opens; a click that ends a drag-selection never reaches here.
        event.preventDefault();
        if (l.kind === "url") void openExternal(l.url);
        else void openFileLink(l, this.snapshot.cwd);
      },
    }));
  }

  /** Moves the host into `container` and opens / fits / starts as needed. */
  attach(container: HTMLElement) {
    if (this.disposed) return;
    if (this.host.parentElement !== container) container.appendChild(this.host);
    if (!this.opened) {
      this.opened = true;
      // xterm's DOM renderer: the WebGL one rasterizes glyphs per background, so
      // selected text rendered at a visibly different weight than the rest.
      this.term.open(this.host);
      remeasureWhenFontsLoad(this.term, fontFor(workflowSettings().terminal), () => !this.disposed, () => this.scheduleFit());
      this.term.textarea?.addEventListener("focus", () => this.opts.onFocus(this.key));
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
    this.resizeObserver.observe(container);
    this.scheduleFit();
  }

  detach(container: HTMLElement) {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.host.parentElement === container) container.removeChild(this.host);
  }

  private scheduleFit() {
    if (this.fitRaf) return;
    const run = () => {
      if (!this.fitRaf) return;
      cancelAnimationFrame(this.fitRaf);
      clearTimeout(this.fitTimer);
      this.fitRaf = 0;
      this.doFit();
    };
    this.fitRaf = requestAnimationFrame(run);
    // WebKit pauses rAF in background windows; don't leave the shell unstarted until the window is shown.
    this.fitTimer = setTimeout(run, 100);
  }

  private doFit() {
    if (this.disposed || !this.host.isConnected) return;
    if (this.host.offsetWidth === 0 || this.host.offsetHeight === 0) return;
    const dims = this.fit.proposeDimensions();
    if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return;
    if (dims.cols !== this.term.cols || dims.rows !== this.term.rows) this.term.resize(dims.cols, dims.rows);
    if (this.snapshot.status === "idle") {
      void this.start();
    } else if (this.ptyId !== null && (this.lastSize.cols !== dims.cols || this.lastSize.rows !== dims.rows)) {
      this.lastSize = { cols: dims.cols, rows: dims.rows };
      void commands.termResize(this.ptyId, dims.cols, dims.rows);
    }
  }

  /** Spawns the PTY with the current size. */
  async start() {
    if (this.disposed || this.snapshot.status === "starting" || this.snapshot.status === "running") return;
    const generation = ++this.generation;
    this.update({ status: "starting", exitCode: null, appTitle: null });
    if (!isTauri()) {
      this.term.writeln("\x1b[2mTerminal is unavailable outside the desktop app.\x1b[0m");
      this.update({ status: "error" });
      return;
    }
    const cols = Math.max(2, this.term.cols);
    const rows = Math.max(1, this.term.rows);
    this.lastSize = { cols, rows };
    const channel = new Channel<string>();
    channel.onmessage = (chunk) => {
      if (generation === this.generation && !this.disposed) this.term.write(chunk);
    };
    try {
      const t = workflowSettings().terminal;
      const [shellPath, ...shellArgs] = splitCommandLine(t.shellPath);
      const custom = this.opts.command;
      const shell = custom ? custom.program : shellPath;
      const args = custom ? custom.args : shellArgs;
      const info = await call(
        commands.termSpawn(
          { cwd: this.opts.cwd, shell: shell ?? null, args, env: { ...t.env }, cols, rows, shellIntegration: (!custom || !!custom.shell) && t.shellIntegration },
          channel,
        ),
      );
      if (this.disposed || generation !== this.generation) {
        void commands.termKill(info.id);
        return;
      }
      this.ptyId = info.id;
      this.update({ status: "running", title: info.title || "Local" });
    } catch (e) {
      this.term.writeln(`\x1b[31mFailed to start terminal: ${e instanceof Error ? e.message : String(e)}\x1b[0m`);
      this.term.writeln(RESTART_HINT);
      this.update({ status: "error" });
    }
  }

  get terminalId(): TerminalId | null {
    return this.ptyId;
  }

  /**
   * Whether ending the session would kill something the user started (as IDEA
   * judges it): a program run instead of a shell always counts;
   * a shell counts while a command runs in it.
   */
  async isBusy(): Promise<boolean> {
    if (this.snapshot.status !== "running" || this.ptyId === null) return false;
    const custom = this.opts.command;
    if (custom && !custom.shell) return true;
    try {
      return await call(commands.termIsBusy(this.ptyId));
    } catch {
      return false;
    }
  }

  /** Called when the backend reports the PTY exited. */
  exited(code: number | null) {
    if (this.disposed) return;
    this.ptyId = null;
    this.update({ status: "exited", exitCode: code });
    // Let output still in flight on the channel land first.
    setTimeout(() => {
      if (this.disposed || this.snapshot.status !== "exited") return;
      const suffix = code !== null && code !== 0 ? ` (exit code ${code})` : "";
      this.term.write(`\r\n\x1b[2m[Process completed${suffix}]\x1b[0m\r\n${RESTART_HINT}\r\n`);
      this.opts.onExit?.(this.key);
    }, 60);
  }

  restart() {
    if (this.snapshot.status === "running" || this.snapshot.status === "starting") return;
    this.term.write("\r\n");
    this.update({ status: "idle" });
    void this.start();
  }

  /** Sends input to the PTY, coalescing rapid keystrokes per animation frame. */
  input(data: string) {
    const status = this.snapshot.status;
    if (status === "exited" || status === "error") {
      if (data === "\r") this.restart();
      return;
    }
    if (this.ptyId === null) return;
    this.pendingInput += data;
    if (this.inputRaf) return;
    this.inputRaf = requestAnimationFrame(() => {
      this.inputRaf = 0;
      const chunk = this.pendingInput;
      this.pendingInput = "";
      if (chunk && this.ptyId !== null) void commands.termWrite(this.ptyId, chunk);
    });
  }

  /** Writes input immediately (shortcuts translated outside xterm). */
  send(data: string) {
    this.term.scrollToBottom();
    this.input(data);
  }

  paste(text: string) {
    this.term.paste(text);
  }

  clearSelection() {
    this.term.clearSelection();
  }

  copySelection(): boolean {
    const text = this.term.getSelection();
    if (!text) return false;
    void navigator.clipboard?.writeText(text).catch(() => undefined);
    return true;
  }

  clear() {
    this.term.clear();
  }

  focus() {
    this.term.focus();
  }

  applyTheme() {
    this.term.options.theme = readTerminalTheme();
    this.searchDecorations = null;
  }

  /** Finds `query` (highlighting every match); `incremental` keeps the current match while typing. */
  find(query: string, opts: TerminalSearchOptions, direction: "next" | "previous", incremental = false): boolean {
    if (!query) {
      this.clearSearch();
      return false;
    }
    this.searchDecorations ??= readSearchDecorations();
    const options: ISearchOptions = { ...opts, incremental: direction === "next" && incremental, decorations: this.searchDecorations };
    try {
      return direction === "next" ? this.searchAddon.findNext(query, options) : this.searchAddon.findPrevious(query, options);
    } catch {
      // Invalid regular expression.
      this.clearSearch();
      return false;
    }
  }

  clearSearch() {
    this.searchAddon.clearDecorations();
    this.term.clearSelection();
    for (const l of this.searchListeners) l({ index: -1, count: 0 });
  }

  onSearchResults(listener: (r: TerminalSearchResult) => void): () => void {
    this.searchListeners.add(listener);
    return () => this.searchListeners.delete(listener);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.fitRaf);
    clearTimeout(this.fitTimer);
    cancelAnimationFrame(this.inputRaf);
    this.resizeObserver?.disconnect();
    this.host.removeEventListener("mousedown", this.onMiddleClick);
    if (this.ptyId !== null) void commands.termKill(this.ptyId);
    this.ptyId = null;
    this.disposables.forEach((d) => d.dispose());
    this.term.dispose();
    this.host.remove();
  }
}
