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
import { tx } from "@/platform/i18n";
import { useProject } from "@/platform/project";
import { subscribeTheme, themeKey } from "@/platform/themeWatch";
import { EmptyState, Spinner } from "@/ui";
import { editorService } from "@/workbench/contributions";
import { pluginsBackend, type FileFilter } from "../backend";
import { errorText, usePlugins } from "../store";
import { FRAME_TAG, frameTheme, frameThemeMessage } from "./frame";
import { syncContentTabSession } from "./contentEditor";
import {
  PLUGIN_CONTENT_EDITOR_KIND,
  contentTabData,
  contentTabKey,
  handleContentTabReplyText,
  registerContentTabSender,
} from "./contentTab";
import { PLUGIN_LOG_EDITOR_KIND } from "./logEditor";
import { logTabData } from "./logTab";
import { webPtyBackend } from "./ptyBackend";
import { onViewMessage } from "./viewStore";
import { ptyBridge } from "./ptyBridge";
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
    const handleLogTabMessage = (rawText: string): boolean => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        return false;
      }
      if (!parsed || typeof parsed !== "object" || !("op" in parsed) || parsed.op !== "open-log-tab") return false;
      try {
        const data = logTabData(pluginId, view, parsed, rawText.length);
        void editorService().openInput({
          kind: PLUGIN_LOG_EDITOR_KIND,
          key: `pluginLog:${JSON.stringify([pluginId, view, data.key ?? data.title])}`,
          data,
        });
      } catch (err) {
        post({ text: JSON.stringify({ op: "log-error", error: errorText(err) }) });
      }
      return true;
    };
    const handleContentTabMessage = (rawText: string): boolean => {
      if (handleContentTabReplyText(pluginId, rawText)) return true;
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        return false;
      }
      if (!parsed || typeof parsed !== "object" || !("op" in parsed) || parsed.op !== "open-content-tab") return false;
      try {
        const data = contentTabData(pluginId, view, parsed, rawText.length);
        const key = contentTabKey(pluginId, view, data.key);
        syncContentTabSession(key, data);
        void editorService().openInput({
          kind: PLUGIN_CONTENT_EDITOR_KIND,
          key,
          data,
        });
      } catch (err) {
        post({ text: JSON.stringify({ op: "content-tab-error", error: errorText(err) }) });
      }
      return true;
    };
    const offContentSender = registerContentTabSender(pluginId, view, (message) => post(message));
    const createPtys = () =>
      ptyBridge(pluginId, webPtyBackend(pluginId, view), (message) => post({ text: JSON.stringify(message) }));
    let ptys = createPtys();
    const resetPtys = () => {
      ptys.close();
      ptys = createPtys();
    };
    const offProject = useProject.subscribe((state, previous) => {
      if (state.project !== previous.project) resetPtys();
    });
    const pluginKey = (plugins: ReturnType<typeof usePlugins.getState>["plugins"]) => {
      const p = plugins.find((p) => p.id === pluginId);
      return p && JSON.stringify([p.path, p.version, p.enabled, p.status, p.capabilities]);
    };
    const offPlugins = usePlugins.subscribe((state, previous) => {
      if (pluginKey(state.plugins) !== pluginKey(previous.plugins)) resetPtys();
    });
    const onUnload = () => ptys.close();
    window.addEventListener("pagehide", onUnload);
    const currentFrame = frame.current;
    // A navigation keeps the iframe's WindowProxy, but must drop its old sessions.
    let loaded = false;
    const onLoad = () => {
      if (loaded) resetPtys();
      loaded = true;
    };
    currentFrame?.addEventListener("load", onLoad);

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
        if (handleLogTabMessage(m.text)) return;
        if (handleContentTabMessage(m.text)) return;
        if (ptys.handle(m.text)) return;
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
      offContentSender();
      ptys.close();
      offPlugins();
      offProject();
      window.removeEventListener("pagehide", onUnload);
      currentFrame?.removeEventListener("load", onLoad);
    };
  }, [pluginId, view, document, doc, hasCode, post, page]);

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
