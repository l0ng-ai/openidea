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
import { useEffect, useState } from "react";
import { attachDocument, type DocumentAttachment } from "@/editor/api";
import { tx } from "@/platform/i18n";
import { EmptyState, Spinner } from "@/ui";
import {
  editorService,
  notifyEditorDocumentChanged,
  type EditorDocumentLifecycle,
  type EditorInput,
} from "@/workbench/contributions";
import { PluginView } from "./PluginView";
import styles from "./PluginView.module.css";

export const CUSTOM_EDITOR_KIND = "pluginEditor";

export interface CustomEditorData {
  pluginId: string;
  editorId: string;
  title: string;
}

export interface CustomEditorDecl {
  id: string;
  title: string;
  patterns: string[];
  priority: "default" | "option";
}

export function customEditorInput(pluginId: string, decl: CustomEditorDecl, path: string): EditorInput {
  const data: CustomEditorData = { pluginId, editorId: decl.id, title: decl.title };
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
  cancelTimer: () => void;
}

const sessions = new Map<string, Promise<Session>>();

/** Edits settle in the backend before the plugin renders the table again. */
const RENDER_DELAY_MS = 120;

function session(input: EditorInput): Promise<Session> {
  let s = sessions.get(input.key);
  if (!s) {
    s = attachDocument(input.path ?? "").then((attachment) => {
      const listeners = new Set<(revision: number) => void>();
      let timer: ReturnType<typeof setTimeout> | null = null;
      const changed = () => {
        notifyEditorDocumentChanged();
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
          extensions: [attachment.extension, history(), EditorView.updateListener.of((u) => u.docChanged && changed())],
        }),
      });
      const state: Session = {
        attachment,
        view,
        revision: 0,
        listeners,
        cancelTimer: () => timer && clearTimeout(timer),
      };
      return state;
    });
    sessions.set(input.key, s);
    s.catch(() => sessions.delete(input.key));
  }
  return s;
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
  close: async (input) => {
    const s = sessions.get(input.key);
    sessions.delete(input.key);
    if (!s) return;
    const state = await s;
    settled.delete(input.key);
    state.cancelTimer();
    state.attachment.release();
    state.view.destroy();
  },
  undo: async (input) => {
    await withSession(input, (s) => void s.attachment.undo());
  },
  redo: async (input) => {
    await withSession(input, (s) => void s.attachment.redo());
  },
};

export function CustomEditor({ input }: { input: EditorInput }) {
  const data = input.data as CustomEditorData;
  const [state, setState] = useState<{ doc: number; revision: number } | { error: string } | null>(null);

  useEffect(() => {
    let live = true;
    let off = () => {};
    session(input).then(
      (s) => {
        if (!live) return;
        settled.set(input.key, s);
        const listener = (revision: number) => setState({ doc: s.attachment.doc, revision });
        s.listeners.add(listener);
        off = () => s.listeners.delete(listener);
        setState({ doc: s.attachment.doc, revision: s.revision });
      },
      (e: unknown) => live && setState({ error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
      off();
    };
  }, [input]);

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
      <PluginView
        pluginId={data.pluginId}
        view={data.editorId}
        doc={state.doc}
        revision={state.revision}
        label={tx`${data.title}: ${basename(input.path ?? "")}`}
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
