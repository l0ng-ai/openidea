/**
 * Plugin custom editors (`[[contributes.customEditors]]`): a file matching
 * the declared patterns opens in a tab whose content the plugin renders from
 * the file's document. The tab joins the document shared by every editor of
 * the file (`attachDocument`), so:
 *
 * - the plugin edits the document (versioned `apply-edits`), and a text tab
 *   of the same file shows the change at once — and the other way round;
 * - Undo / Redo work on the document's one history: the text tab's when one
 *   is open, else this tab's own;
 * - unsaved changes, Save, and the close prompts are the document's.
 */
import { history } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useMemo, useState } from "react";
import { attachDocument, type DocumentAttachment } from "@/editor/api";
import { tx } from "@/platform/i18n";
import { EmptyState, Spinner } from "@/ui";
import {
  editorService,
  notifyEditorDocumentChanged,
  type EditorDocumentLifecycle,
  type EditorInput,
} from "@/workbench/contributions";
import { pluginsBackend } from "../backend";
import { PluginView } from "./PluginView";
import { WebView, type DocumentState, type FrameDocument } from "./WebView";
import styles from "./PluginView.module.css";

export const CUSTOM_EDITOR_KIND = "pluginEditor";

export interface CustomEditorData {
  pluginId: string;
  editorId: string;
  title: string;
  /** A web page of the package (`web`) rather than content the code renders. */
  web?: boolean;
}

export interface CustomEditorDecl {
  id: string;
  title: string;
  patterns: string[];
  priority: "default" | "option";
  /** `tab`: its own tab; `split` / `preview`: beside the text editor, starting in that layout. */
  layout?: "tab" | "split" | "preview";
  web?: string;
}

export function customEditorInput(pluginId: string, decl: CustomEditorDecl, path: string): EditorInput {
  const data: CustomEditorData = { pluginId, editorId: decl.id, title: decl.title, web: !!decl.web };
  return { kind: CUSTOM_EDITOR_KIND, key: `${CUSTOM_EDITOR_KIND}:${pluginId}/${decl.id}:${path}`, path, data };
}

/** File name glob (`*`, `?`, `[abc]`, `{a,b}`), case-insensitive. */
export function matchesPattern(pattern: string, name: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = pattern.indexOf("}", i);
      if (end < 0) re += "\\{";
      else {
        re += `(?:${pattern
          .slice(i + 1, end)
          .split(",")
          .map((p) => p.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
          .join("|")})`;
        i = end;
      }
    } else if (c === "[") {
      const end = pattern.indexOf("]", i);
      if (end < 0) re += "\\[";
      else {
        re += pattern.slice(i, end + 1);
        i = end;
      }
    } else re += c.replace(/[.+^$()|\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i").test(name);
}

export function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

// --- sessions: one per document shown by a custom editor (splits share it) -----------

interface Session {
  attachment: DocumentAttachment;
  /** Holds this tab's undo history and receives the document's changes. */
  view: EditorView;
  revision: number;
  listeners: Set<(revision: number) => void>;
  /** The document as web frames see it. */
  frameDocument: FrameDocument;
  cancelTimer: () => void;
}

const sessions = new Map<string, Promise<Session>>();

/** Edits settle in the backend before the plugin renders the table again. */
const RENDER_DELAY_MS = 120;

function session(key: string, path: string): Promise<Session> {
  let s = sessions.get(key);
  if (!s) {
    s = attachDocument(path).then((attachment) => {
      const listeners = new Set<(revision: number) => void>();
      const frameListeners = new Set<(state: DocumentState) => void>();
      let timer: ReturnType<typeof setTimeout> | null = null;
      // Bumped by every change: what frames' versioned edits are checked against.
      let version = 0;
      // Set while a frame's edit is applied: its changes (arriving synchronously) aren't echoed back.
      let framing = false;
      const changed = (byFrame: boolean) => {
        version++;
        notifyEditorDocumentChanged();
        if (!byFrame && frameListeners.size) {
          const state = { version, text: view.state.doc.toString() };
          for (const l of frameListeners) l(state);
        }
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          void attachment.synced().then(() => {
            state.revision++;
            for (const l of listeners) l(state.revision);
          });
        }, RENDER_DELAY_MS);
      };
      const view = new EditorView({
        state: EditorState.create({
          doc: attachment.text(),
          extensions: [
            attachment.extension,
            history(),
            EditorView.updateListener.of((u) => u.docChanged && changed(framing)),
          ],
        }),
      });
      const frameDocument: FrameDocument = {
        read: () => ({ version, text: view.state.doc.toString(), readOnly: attachment.readOnly, name: basename(path) }),
        // The file's bytes, for a binary custom editor the page renders.
        bytes: () => pluginsBackend().readFileBytes(path),
        edit: (at, changes) => {
          if (at !== version) throw new Error("stale");
          // One edit of the document's history: Undo in the text editor (or this tab) reverts it.
          framing = true;
          try {
            attachment.edit([...changes], "input.plugin");
          } finally {
            framing = false;
          }
          return version;
        },
        subscribe: (listener) => {
          frameListeners.add(listener);
          return () => frameListeners.delete(listener);
        },
      };
      const state: Session = {
        attachment,
        view,
        revision: 0,
        listeners,
        frameDocument,
        cancelTimer: () => timer && clearTimeout(timer),
      };
      return state;
    });
    sessions.set(key, s);
    s.catch(() => sessions.delete(key));
  }
  return s;
}

async function closeSession(key: string) {
  const s = sessions.get(key);
  sessions.delete(key);
  if (!s) return;
  const state = await s;
  settled.delete(key);
  state.cancelTimer();
  state.attachment.release();
  state.view.destroy();
}

async function withSession<T>(input: EditorInput, f: (s: Session) => T | Promise<T>): Promise<T | undefined> {
  const s = sessions.get(input.key);
  return s ? f(await s) : undefined;
}

const settled = new Map<string, Session>();

/** Lifecycle of the tabs' document (dirty mark, Save, close prompts, Undo). */
export const customEditorDocument: EditorDocumentLifecycle = {
  isDirty: (input) => settled.get(input.key)?.attachment.dirty() ?? false,
  flush: async (input) => {
    await withSession(input, (s) => s.attachment.synced());
  },
  save: async (input) => {
    await withSession(input, (s) => s.attachment.save());
  },
  prepareClose: async (input) => {
    await withSession(input, (s) => s.attachment.synced());
  },
  cancelClose: () => {},
  discard: async () => {
    // The document's unsaved changes go when it closes (`close` releases it).
  },
  close: (input) => closeSession(input.key),
  undo: async (input) => {
    await withSession(input, (s) => void s.attachment.undo());
  },
  redo: async (input) => {
    await withSession(input, (s) => void s.attachment.redo());
  },
};

type SessionState = { session: Session; revision: number } | { error: string } | null;

/** The session `key` of `path`, kept for as long as the component shows it. */
function useSession(key: string, path: string, release: boolean): SessionState {
  const [state, setState] = useState<SessionState>(null);
  useEffect(() => {
    let live = true;
    let off = () => {};
    session(key, path).then(
      (s) => {
        if (!live) return;
        settled.set(key, s);
        const listener = (revision: number) => setState({ session: s, revision });
        s.listeners.add(listener);
        off = () => s.listeners.delete(listener);
        setState({ session: s, revision: s.revision });
      },
      (e: unknown) => live && setState({ error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
      off();
      // A tab's session lives until the tab closes (its lifecycle); a preview's until it unmounts.
      if (release) void closeSession(key);
    };
  }, [key, path, release]);
  return state;
}

function SessionBody({
  state,
  pluginId,
  editorId,
  web,
  label,
  path,
}: {
  state: Exclude<SessionState, null | { error: string }>;
  pluginId: string;
  editorId: string;
  web: boolean;
  label: string;
  path: string;
}) {
  const { session: s, revision } = state;
  if (web)
    return (
      <WebView pluginId={pluginId} view={editorId} label={label} document={s.frameDocument} doc={s.attachment.doc} />
    );
  return (
    <PluginView
      pluginId={pluginId}
      view={editorId}
      doc={s.attachment.doc}
      revision={revision}
      label={label}
      key={path}
    />
  );
}

export function CustomEditor({ input }: { input: EditorInput }) {
  const data = input.data as CustomEditorData;
  const state = useSession(input.key, input.path ?? "", false);

  if (!state)
    return (
      <div className={styles.empty}>
        <Spinner label={tx("Loading")} />
      </div>
    );
  if ("error" in state)
    return (
      <EmptyState className={styles.empty} title={tx`Cannot open ${basename(input.path ?? "")}`}>
        {state.error}
      </EmptyState>
    );
  return (
    <div className={styles.view}>
      <SessionBody
        state={state}
        pluginId={data.pluginId}
        editorId={data.editorId}
        web={!!data.web}
        label={tx`${data.title}: ${basename(input.path ?? "")}`}
        path={input.path ?? ""}
      />
      <div className={styles.status}>
        <button
          type="button"
          className={styles.textButton}
          onClick={() => input.path && void editorService().openFile(input.path, { asText: true })}
        >
          {tx("Open as Text")}
        </button>
      </div>
    </div>
  );
}

/**
 * A custom editor beside the text editor (`layout = "split"` / `"preview"`):
 * the same document, so each follows the other's edits.
 */
export function CustomEditorPreview({
  pluginId,
  decl,
  path,
}: {
  pluginId: string;
  decl: CustomEditorDecl;
  path: string;
}) {
  const key = useMemo(() => `pluginPreview:${pluginId}/${decl.id}:${path}`, [pluginId, decl.id, path]);
  const state = useSession(key, path, true);
  const label = tx`${decl.title}: ${basename(path)}`;
  if (!state)
    return (
      <div className={styles.empty}>
        <Spinner label={tx("Loading")} />
      </div>
    );
  if ("error" in state)
    return (
      <EmptyState className={styles.empty} title={tx`Cannot open ${basename(path)}`}>
        {state.error}
      </EmptyState>
    );
  return (
    <div className={styles.view}>
      <SessionBody state={state} pluginId={pluginId} editorId={decl.id} web={!!decl.web} label={label} path={path} />
    </div>
  );
}
