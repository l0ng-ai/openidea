/**
 * A plugin's web view (`web = "web/index.html"` on a view or custom editor):
 * a page shipped in the plugin package, loaded from the `openidea-plugin`
 * scheme into an `<iframe sandbox="allow-scripts">`. The frame is an opaque
 * origin with no network and no IDE API; the desktop serves only the files
 * under the page's directory, with a CSP of their own, and injects the bridge
 * (`frame-bridge.js`). Through it, and only it, the page:
 *
 * - follows the IDE theme;
 * - exchanges messages with the plugin's code, when it has any;
 * - reads and edits the document of the custom editor it is (versioned edits
 *   that join the document's undo history, Save and dirty state);
 * - asks the user to save or open a file (the IDE's dialogs: the user picks
 *   the path, the page never names one);
 * - uses the clipboard, when the plugin was granted `clipboard`;
 * - passes on IDE shortcuts it doesn't handle itself (Save, Close…).
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Channel } from "@tauri-apps/api/core";
import { tx } from "@/platform/i18n";
import { call, commands, isTauri, onIdeEvent, type TerminalId } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { subscribeTheme, themeKey } from "@/platform/themeWatch";
import { EmptyState, Spinner } from "@/ui";
import { pluginsBackend, type FileFilter } from "../backend";
import { errorText, usePlugins } from "../store";
import { FRAME_TAG, frameTheme, frameThemeMessage } from "./frame";
import { onViewMessage } from "./viewStore";
import styles from "./PluginView.module.css";

/** One change of a document, in UTF-16 offsets of the text it applies to. */
export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

export interface DocumentState {
  version: number;
  text: string;
}

/** The document a web custom editor shows, as its frame sees it. */
export interface FrameDocument {
  /** `name` is the file's name, without its directory. */
  read(): DocumentState & { readOnly: boolean; name: string };
  /** Applies the frame's edits as one change; throws `stale` when not at `version`. Returns the new version. */
  edit(version: number, changes: readonly TextChange[]): number;
  /** Changes made other than through `edit` (the text editor, Undo, other windows). */
  subscribe(listener: (state: DocumentState) => void): () => void;
}

/** Largest text a frame may write in one edit. */
const MAX_EDIT = 64 << 20;

/** The smallest change turning `from` into `to`: their common prefix and suffix stay. */
export function minimalChange(from: string, to: string): TextChange | null {
  if (from === to) return null;
  let start = 0;
  const max = Math.min(from.length, to.length);
  while (start < max && from.charCodeAt(start) === to.charCodeAt(start)) start++;
  let end = 0;
  while (end < max - start && from.charCodeAt(from.length - 1 - end) === to.charCodeAt(to.length - 1 - end)) end++;
  return { from: start, to: from.length - end, insert: to.slice(start, to.length - end) };
}

/** Checks a frame's edits against the text they apply to: in range, sorted, not overlapping. */
export function validChanges(value: unknown, length: number): TextChange[] {
  if (!Array.isArray(value) || value.length > 100_000) throw new Error("edits must be an array");
  let at = 0;
  let size = 0;
  return value.map((c: unknown) => {
    const { from, to, insert } = (c ?? {}) as Partial<TextChange>;
    if (!Number.isInteger(from) || !Number.isInteger(to) || typeof insert !== "string")
      throw new Error("an edit is { from, to, insert }");
    if (from! < at || to! < from! || to! > length) throw new Error("edits must be sorted, in range and not overlap");
    size += insert.length;
    if (size > MAX_EDIT) throw new Error("the edit is too large");
    at = to!;
    return { from: from!, to: to!, insert };
  });
}

function validFilters(value: unknown): FileFilter[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .slice(0, 10)
    .filter(
      (f): f is FileFilter =>
        !!f &&
        typeof f.name === "string" &&
        Array.isArray(f.extensions) &&
        f.extensions.every((e: unknown) => typeof e === "string" && /^[\w.+-]{1,32}$/.test(e)),
    )
    .map((f) => ({ name: f.name.slice(0, 64), extensions: f.extensions.slice(0, 20) }));
}

type PageState = { url: string } | { error: string };

/**
 * The `openidea-plugin` URL of the page, or why there is none. Asked again
 * whenever the plugin changes (`plugin`: its info, a new object then): the URL
 * names the installed package's revision, so an update, a reinstall or
 * disabling it reach the frame, and the frame only reloads when the URL is new.
 */
function usePageUrl(pluginId: string, view: string, plugin: unknown) {
  const page = `${pluginId}/${view}`;
  const [state, setState] = useState<{ page: string; value: PageState } | null>(null);
  useEffect(() => {
    let live = true;
    const set = (value: PageState) =>
      live &&
      setState((s) =>
        s?.page === page && "url" in s.value && "url" in value && s.value.url === value.url ? s : { page, value },
      );
    pluginsBackend()
      .webPageUrl(pluginId, view)
      .then(
        (url) => set({ url }),
        (e: unknown) => set({ error: errorText(e) }),
      );
    return () => {
      live = false;
    };
  }, [pluginId, view, page, plugin]);
  return state?.page === page ? state.value : null;
}

export interface WebViewProps {
  pluginId: string;
  view: string;
  label: string;
  /** The custom editor's document; none in a tool window. */
  document?: FrameDocument | null;
  /** The backend document, for messages to the plugin's code. */
  doc?: number | null;
}

export function WebView({ pluginId, view, label, document = null, doc = null }: WebViewProps) {
  const plugin = usePlugins((s) => s.plugins.find((p) => p.id === pluginId));
  const page = usePageUrl(pluginId, view, plugin);
  const hasCode = plugin?.hasCode ?? false;
  const clipboard = plugin?.capabilities.some((c) => c.id === "clipboard" && c.granted) ?? false;
  const frame = useRef<HTMLIFrameElement>(null);

  const post = useCallback((message: object, transfer: Transferable[] = []) => {
    frame.current?.contentWindow?.postMessage({ tag: FRAME_TAG, ...message }, "*", transfer);
  }, []);
  const postTheme = useCallback(() => post(frameThemeMessage(frameTheme())), [post]);
  const theme = useSyncExternalStore(subscribeTheme, themeKey, () => "");
  useEffect(postTheme, [theme, postTheme]);

  // The document's changes made elsewhere.
  useEffect(() => document?.subscribe((state) => post({ document: state })), [document, post]);

  useEffect(() => {
    let dialog = false;
    interface PtyEntry {
      id?: TerminalId;
      killed?: boolean;
      pendingInputs: string[];
      pendingResize?: { cols: number; rows: number };
    }
    const ptySessions = new Map<string, PtyEntry>();
    const ptyByTermId = new Map<TerminalId, string>();
    const offTermEvent = onIdeEvent("terminalExited", (ev) => {
      const sid = ptyByTermId.get(ev.terminal);
      if (sid) {
        ptyByTermId.delete(ev.terminal);
        ptySessions.delete(sid);
        post({ text: JSON.stringify({ op: "pty-exit", sessionId: sid, exitCode: ev.code }) });
      }
    });

    const handlePtyMessage = (rawText: string): boolean => {
      if (!rawText.startsWith("{") || !rawText.includes('"pty-')) return false;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(rawText) as Record<string, unknown>;
      } catch {
        return false;
      }
      const op = parsed.op;
      if (op !== "pty-spawn" && op !== "pty-input" && op !== "pty-resize" && op !== "pty-kill") {
        return false;
      }
      const sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId : "default";
      if (op === "pty-spawn") {
        const program = typeof parsed.program === "string" ? parsed.program.trim() : "";
        if (!program) return true;
        const currentPlugin = usePlugins.getState().plugins.find((p) => p.id === pluginId);
        const allowed = currentPlugin?.capabilities.some((c) => c.id === `process:${program}` && c.granted) ?? false;
        if (!allowed || !isTauri()) {
          post({
            text: JSON.stringify({
              op: "pty-data",
              sessionId,
              data: `\r\n\x1b[31mCannot start PTY: process:${program} capability not granted or not running in desktop app.\x1b[0m\r\n`,
            }),
          });
          return true;
        }
        const prev = ptySessions.get(sessionId);
        if (prev) {
          prev.killed = true;
          if (prev.id !== undefined) {
            ptyByTermId.delete(prev.id);
            void commands.termKill(prev.id);
          }
          ptySessions.delete(sessionId);
        }
        const args = Array.isArray(parsed.args) ? parsed.args.filter((a): a is string => typeof a === "string") : [];
        const cols = typeof parsed.cols === "number" ? Math.max(20, parsed.cols) : 100;
        const rows = typeof parsed.rows === "number" ? Math.max(5, parsed.rows) : 28;
        const cwd = useProject.getState().project?.root ?? "/";
        const entry: PtyEntry = { pendingInputs: [] };
        ptySessions.set(sessionId, entry);
        const channel = new Channel<string>();
        channel.onmessage = (chunk) => {
          if (entry.killed) return;
          post({ text: JSON.stringify({ op: "pty-data", sessionId, data: chunk }) });
        };
        void call(
          commands.termSpawn(
            {
              cwd,
              shell: program,
              args,
              env: { TERM: "xterm-256color" },
              cols,
              rows,
              shellIntegration: false,
            },
            channel,
          ),
        ).then(
          (info) => {
            if (entry.killed || ptySessions.get(sessionId) !== entry) {
              void commands.termKill(info.id);
              return;
            }
            entry.id = info.id;
            ptyByTermId.set(info.id, sessionId);
            if (entry.pendingResize) {
              void commands.termResize(
                info.id,
                Math.max(2, entry.pendingResize.cols),
                Math.max(1, entry.pendingResize.rows),
              );
              entry.pendingResize = undefined;
            }
            for (const data of entry.pendingInputs.splice(0)) {
              void commands.termWrite(info.id, data);
            }
          },
          (err: unknown) => {
            if (entry.killed) return;
            post({
              text: JSON.stringify({
                op: "pty-data",
                sessionId,
                data: `\r\n\x1b[31mFailed to spawn PTY: ${errorText(err)}\x1b[0m\r\n`,
              }),
            });
          },
        );
        return true;
      }
      if (op === "pty-input") {
        const entry = ptySessions.get(sessionId);
        if (entry && !entry.killed && typeof parsed.data === "string") {
          if (entry.id !== undefined) {
            void commands.termWrite(entry.id, parsed.data);
          } else {
            entry.pendingInputs.push(parsed.data);
          }
        }
        return true;
      }
      if (op === "pty-resize") {
        const entry = ptySessions.get(sessionId);
        if (entry && !entry.killed && typeof parsed.cols === "number" && typeof parsed.rows === "number") {
          if (entry.id !== undefined) {
            void commands.termResize(entry.id, Math.max(2, parsed.cols), Math.max(1, parsed.rows));
          } else {
            entry.pendingResize = { cols: parsed.cols, rows: parsed.rows };
          }
        }
        return true;
      }
      if (op === "pty-kill") {
        const entry = ptySessions.get(sessionId);
        if (entry) {
          entry.killed = true;
          if (entry.id !== undefined) {
            ptyByTermId.delete(entry.id);
            void commands.termKill(entry.id);
          }
          ptySessions.delete(sessionId);
        }
        return true;
      }
      return false;
    };

    const run = async (op: string, args: Record<string, unknown>): Promise<[unknown, Transferable[]?]> => {
      switch (op) {
        case "document.get": {
          if (!document) throw new Error("this view shows no document");
          return [document.read()];
        }
        case "document.edit":
        case "document.replace": {
          if (!document) throw new Error("this view shows no document");
          const current = document.read();
          if (current.readOnly) throw new Error("the document is read-only");
          if (args.version !== current.version) throw new Error("stale");
          let changes: TextChange[];
          if (op === "document.replace") {
            if (typeof args.text !== "string" || args.text.length > MAX_EDIT) throw new Error("text must be a string");
            const change = minimalChange(current.text, args.text);
            changes = change ? [change] : [];
          } else changes = validChanges(args.edits, current.text.length);
          return [{ version: changes.length ? document.edit(current.version, changes) : current.version }];
        }
        case "saveFile":
        case "openFile": {
          // One dialog at a time per frame.
          if (dialog) throw new Error("a file dialog is already open");
          dialog = true;
          try {
            const filters = validFilters(args.filters);
            if (op === "openFile") {
              const file = await pluginsBackend().openWebFile(filters);
              return file ? [file, [file.data.buffer]] : [null];
            }
            if (!(args.bytes instanceof Uint8Array)) throw new Error("data must be bytes");
            const name = typeof args.name === "string" ? args.name.slice(0, 255) : "untitled";
            return [await pluginsBackend().saveWebFile(name, filters, args.bytes)];
          } finally {
            dialog = false;
          }
        }
        default:
          throw new Error(`unknown request ${op}`);
      }
    };
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const m = e.data as {
        tag?: unknown;
        text?: unknown;
        call?: unknown;
        op?: unknown;
        args?: unknown;
        key?: unknown;
      } | null;
      if (m?.tag !== FRAME_TAG) return;
      if (m.key && typeof m.key === "object") {
        // A shortcut the page didn't handle: as if pressed on the frame, for the IDE's keymap.
        const k = m.key as KeyboardEventInit;
        const init: KeyboardEventInit = { bubbles: true, cancelable: true };
        for (const f of ["key", "code"] as const) if (typeof k[f] === "string") init[f] = k[f];
        for (const f of ["metaKey", "ctrlKey", "altKey", "shiftKey", "repeat"] as const) init[f] = k[f] === true;
        frame.current.dispatchEvent(new KeyboardEvent("keydown", init));
      } else if (typeof m.call === "number" && typeof m.op === "string") {
        const id = m.call;
        run(m.op, (m.args ?? {}) as Record<string, unknown>).then(
          ([value, transfer]) => post({ reply: id, value }, transfer),
          (err: unknown) => post({ reply: id, error: errorText(err) }),
        );
      } else if (typeof m.text === "string") {
        if (handlePtyMessage(m.text)) return;
        if (hasCode) {
          pluginsBackend()
            .viewEvent(pluginId, view, { kind: "message", text: m.text }, doc)
            .catch((err: unknown) => console.warn(`plugin ${pluginId}: ${errorText(err)}`));
        }
      }
    };
    window.addEventListener("message", onMessage);
    const off = onViewMessage(pluginId, view, (text) => post({ text }));
    return () => {
      window.removeEventListener("message", onMessage);
      off();
      offTermEvent();
      for (const entry of ptySessions.values()) {
        entry.killed = true;
        if (entry.id !== undefined) {
          void commands.termKill(entry.id);
        }
      }
      ptySessions.clear();
      ptyByTermId.clear();
    };
  }, [pluginId, view, document, doc, hasCode, post]);

  if (!page)
    return (
      <div className={styles.empty}>
        <Spinner label={tx("Loading")} />
      </div>
    );
  if ("error" in page)
    return (
      <EmptyState className={styles.empty} title={tx`Cannot show ${label}`}>
        {page.error}
      </EmptyState>
    );
  // No `allow-same-origin`: an opaque origin without access to the IDE. `onLoad` sends the theme.
  return (
    <iframe
      ref={frame}
      className={styles.frame}
      title={label}
      sandbox="allow-scripts"
      allow={clipboard ? "clipboard-read; clipboard-write" : undefined}
      src={page.url}
      onLoad={postTheme}
    />
  );
}
