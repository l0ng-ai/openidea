import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Compartment, EditorState, Prec, type StateEffect } from "@codemirror/state";
import { EditorView, highlightSpecialChars, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab, redo, undo } from "@codemirror/commands";
import { syntaxHighlighting } from "@codemirror/language";
import { caretRowHighlight } from "@/editor/core/cm/caretRow";
import { findExtension, findResultLines, findScope, type FindOptions } from "@/editor/core/cm/find";
import { foldingExtension } from "@/editor/core/cm/folding";
import { openideaHighlightStyle } from "@/editor/core/cm/highlight";
import { overviewLane } from "@/editor/core/cm/lanes";
import { findLanguageDescription, loadSupport } from "@/editor/core/cm/languages";
import { caretExtension, fontZoom, setFontZoom, stepFontZoom } from "@/editor/core/cm/prefs";
import { fontExtension, heavyExtension, lineNumbersExtension } from "@/editor/core/cm/setup";
import { openideaTheme } from "@/editor/core/cm/theme";
import { FindPanel, searchAgain, seedFind, type FindTarget } from "@/editor/core/view/FindBar";
import { executeAction } from "@/platform/actions";
import { editorPrefs } from "@/platform/editorSettings";
import { tx } from "@/platform/i18n";
import { bindingsFor, normalizeBinding, registerKeyClaim, strokeOf } from "@/platform/keymap";
import { useProject } from "@/platform/project";
import { Button, EmptyState, Icon, IconButton, fileIconName } from "@/ui";
import logStyles from "@/ui/LogPane.module.css";
import { notifyEditorDocumentChanged, type EditorDocumentLifecycle, type EditorInput } from "@/workbench/contributions";
import { errorText, usePlugins } from "../store";
import { bindContentControls } from "./contentActions";
import {
  cancelPluginContentRequests,
  dispatchContentTabAction,
  openPluginDiff,
  type PluginContentEditorData,
} from "./contentTab";

export function pluginContentEditorTitle(input: EditorInput): string {
  const s = sessions.get(input.key);
  if (s) return s.data.title;
  const data = input.data as Partial<PluginContentEditorData> | undefined;
  return data?.title || input.key;
}

export function pluginContentEditorIcon(input: EditorInput): string {
  const s = sessions.get(input.key);
  const data = s?.data ?? (input.data as Partial<PluginContentEditorData> | undefined);
  return fileIconName(data?.fileName || data?.title || "untitled.txt");
}

interface ContentSession {
  key: string;
  data: PluginContentEditorData;
  baselineText: string;
  currentText: string;
  readOnly: boolean;
  closing: boolean;
  view: EditorView | null;
  pending?: Promise<void>;
  invokeAction?: (id: string, fromSave: boolean) => Promise<void>;
  setClosing?: (closing: boolean) => void;
  discard?: () => void;
  syncData?: (next: PluginContentEditorData) => void;
}

const sessions = new Map<string, ContentSession>();

function ensureSession(key: string, data: PluginContentEditorData): ContentSession {
  let s = sessions.get(key);
  if (!s) {
    s = {
      key,
      data,
      baselineText: data.content,
      currentText: data.content,
      readOnly: data.readOnly,
      closing: false,
      view: null,
    };
    sessions.set(key, s);
  }
  return s;
}

export function syncContentTabSession(key: string, data: PluginContentEditorData) {
  const s = sessions.get(key);
  if (!s) {
    ensureSession(key, data);
    return;
  }
  s.syncData?.(data);
}

export function closeContentSession(key: string) {
  const s = sessions.get(key);
  sessions.delete(key);
  if (s) notifyEditorDocumentChanged();
}

export const pluginContentEditorDocument: EditorDocumentLifecycle = {
  isDirty: (input) => {
    const s = sessions.get(input.key);
    return !!s && s.currentText !== s.baselineText;
  },
  flush: async () => {},
  save: async (input) => {
    const s = sessions.get(input.key);
    if (s?.pending) await s.pending;
    if (!s || s.currentText === s.baselineText) return;
    const saveAction =
      s.data.actions.find((a) => a.save) ??
      s.data.actions.find((a) => a.id === "save") ??
      s.data.actions.find((a) => a.primary);
    if (!saveAction) throw new Error(tx("No save action is configured for this tab"));
    if (s.invokeAction) {
      await s.invokeAction(saveAction.id, true);
    } else {
      const snapshot = s.currentText;
      s.pending = dispatchContentTabAction(s.data, saveAction.id, snapshot)
        .then((reply) => {
          if (reply.error) throw new Error(reply.error);
          if (reply.saved === false) throw new Error(tx("The plugin did not save the content"));
          if (reply.content !== undefined && s.currentText === snapshot) s.currentText = reply.content;
          s.baselineText = reply.content ?? snapshot;
          notifyEditorDocumentChanged();
        })
        .finally(() => {
          s.pending = undefined;
        });
      await s.pending;
    }
  },
  prepareClose: async (input) => {
    const s = sessions.get(input.key);
    if (s) {
      s.closing = true;
      s.setClosing?.(true);
      await s.pending?.catch(() => {});
    }
  },
  cancelClose: (input) => {
    const s = sessions.get(input.key);
    if (s) {
      s.closing = false;
      s.setClosing?.(false);
    }
  },
  discard: async (input) => {
    const s = sessions.get(input.key);
    if (!s) return;
    if (s.discard) s.discard();
    else {
      s.currentText = s.baselineText;
      notifyEditorDocumentChanged();
    }
  },
  close: async (input) => {
    closeContentSession(input.key);
  },
  undo: async (input) => {
    const v = sessions.get(input.key)?.view;
    if (v) undo(v);
  },
  redo: async (input) => {
    const v = sessions.get(input.key)?.view;
    if (v) redo(v);
  },
};

function isActionStroke(stroke: string | null, actionId: string): boolean {
  return !!stroke && bindingsFor(actionId).some((b) => normalizeBinding(b) === stroke);
}

const wheelZoom = EditorView.domEventHandlers({
  wheel(e, view) {
    if (!e.metaKey && !e.ctrlKey) return false;
    e.preventDefault();
    stepFontZoom(view, e.deltaY < 0 ? 1 : -1);
    return true;
  },
});

export function PluginContentEditor({ input }: { input: EditorInput }) {
  const data = input.data as PluginContentEditorData | undefined;
  if (!data || !data.title || typeof data.content !== "string") {
    return <EmptyState title={tx("Invalid content editor configuration")} />;
  }
  return <PluginContentEditorBody input={input} initialData={data} />;
}

function PluginContentEditorBody({ input, initialData }: { input: EditorInput; initialData: PluginContentEditorData }) {
  const session = useMemo(() => ensureSession(input.key, initialData), [input.key, initialData]);
  const [data, setData] = useState<PluginContentEditorData>(() => session.data);
  const [readOnly, setReadOnly] = useState<boolean>(() => session.readOnly);
  const [modified, setModified] = useState<boolean>(() => session.currentText !== session.baselineText);
  const [busy, setBusy] = useState<boolean>(false);
  const [status, setStatus] = useState<{ text: string; isError: boolean } | null>(null);
  const [find, setFind] = useState<{ replace: boolean; seq: number } | null>(null);
  const [viewGen, setViewGen] = useState(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const readOnlySlotRef = useRef(new Compartment());
  const suppressDirtyRef = useRef(false);
  const findOpenRef = useRef(false);
  const findWatchersRef = useRef(new Set<(u: { docChanged: boolean; selectionSet: boolean }) => void>());
  const findEscapeRef = useRef<() => boolean>(() => false);
  const saveShortcutRef = useRef<() => boolean>(() => false);
  const findId = useId();

  const findTarget = useMemo<FindTarget>(
    () => ({
      id: `pluginContent:${findId}:${input.key}`,
      view: () => viewRef.current,
      watch(fn) {
        findWatchersRef.current.add(fn);
        return () => void findWatchersRef.current.delete(fn);
      },
      isOpen: () => findOpenRef.current,
      results(options: FindOptions) {
        const view = viewRef.current;
        if (!view) return null;
        const state = view.state;
        const scope = state.field(findScope, false) ?? { from: 0, to: state.doc.length };
        return {
          title: tx`Occurrences of '${options.search}'`,
          query: {
            pattern: options.search,
            isRegex: options.regexp,
            caseSensitive: options.caseSensitive,
            wholeWord: options.wholeWord,
            context: options.context,
            include: [],
            exclude: [],
            scope: { kind: "files", paths: [data.title] },
            maxMatches: 0,
          },
          read: () => ({
            path: data.title,
            relPath: data.title,
            matches: findResultLines(
              viewRef.current?.state ?? state,
              options,
              state.field(findScope, false)
                ? ((viewRef.current?.state ?? state).field(findScope, false) ?? scope)
                : { from: 0, to: (viewRef.current?.state ?? state).doc.length },
            ),
          }),
        };
      },
    }),
    [findId, input.key, data.title],
  );

  const openFind = (replace = false) => {
    if (!viewRef.current) return;
    const allowReplace = replace && !readOnly && !session.closing;
    findOpenRef.current = true;
    seedFind(findTarget, allowReplace);
    setFind((f) => ({ replace: allowReplace, seq: (f?.seq ?? 0) + 1 }));
  };

  const closeFind = () => {
    findOpenRef.current = false;
    setFind(null);
    viewRef.current?.focus();
  };

  findEscapeRef.current = () => {
    if (!findOpenRef.current) return false;
    closeFind();
    return true;
  };

  const applyDocText = useCallback(
    (nextText: string, updateBaseline: boolean) => {
      session.currentText = nextText;
      if (updateBaseline) session.baselineText = nextText;
      const view = viewRef.current;
      if (view && view.state.doc.toString() !== nextText) {
        suppressDirtyRef.current = true;
        try {
          view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: nextText } });
        } finally {
          suppressDirtyRef.current = false;
        }
      }
      const nextDirty = session.currentText !== session.baselineText;
      setModified(nextDirty);
      notifyEditorDocumentChanged();
    },
    [session],
  );

  const invokeAction = useCallback(
    (actionId: string, fromSave = false): Promise<void> => {
      if (session.pending) return session.pending;
      if (session.closing && !fromSave) return Promise.resolve();
      const currentText = viewRef.current?.state.doc.toString() ?? session.currentText;
      session.currentText = currentText;
      setBusy(true);
      setStatus(null);
      const pending = (async () => {
        try {
          const reply = await dispatchContentTabAction(session.data, actionId, currentText);
          if (reply.error) throw new Error(reply.error);
          if (fromSave && reply.saved === false) throw new Error(tx("The plugin did not save the content"));
          if (typeof reply.readOnly === "boolean") {
            session.readOnly = reply.readOnly;
            setReadOnly(reply.readOnly);
          }
          if (reply.content !== undefined && session.currentText === currentText) {
            applyDocText(reply.content, reply.saved !== false);
          } else if (reply.saved === true || fromSave || (reply.content !== undefined && reply.saved !== false)) {
            session.baselineText = reply.content ?? currentText;
            setModified(session.currentText !== session.baselineText);
            notifyEditorDocumentChanged();
          } else {
            setModified(session.currentText !== session.baselineText);
            notifyEditorDocumentChanged();
          }
          if (reply.diff) {
            openPluginDiff(reply.diff, session.data.fileName ?? session.data.title, session.data.title);
          }
          if (reply.status !== undefined) {
            setStatus(reply.status ? { text: reply.status, isError: false } : null);
          }
        } catch (err) {
          const msg = errorText(err);
          setStatus({ text: msg, isError: true });
          if (fromSave) throw err;
        } finally {
          session.pending = undefined;
          setBusy(false);
        }
      })();
      session.pending = pending;
      return pending;
    },
    [applyDocText, session],
  );

  saveShortcutRef.current = () => {
    const saveAction =
      data.actions.find((a) => a.save) ??
      data.actions.find((a) => a.id === "save") ??
      data.actions.find((a) => a.primary);
    if (!saveAction || busy || readOnly || session.closing) return false;
    void invokeAction(saveAction.id, true).catch(() => {});
    return true;
  };

  useEffect(() => {
    session.invokeAction = invokeAction;
    session.setClosing = (closing) => {
      session.closing = closing;
      const view = viewRef.current;
      if (view) {
        const effectiveReadOnly = session.readOnly || closing;
        view.dispatch({
          effects: readOnlySlotRef.current.reconfigure([
            EditorState.readOnly.of(effectiveReadOnly),
            EditorView.editable.of(!effectiveReadOnly),
          ]),
        });
      }
    };
    session.discard = () => {
      applyDocText(session.baselineText, true);
    };
    session.syncData = (next) => {
      const wasDirty = session.currentText !== session.baselineText;
      session.data = next;
      setData(next);
      if (session.readOnly !== next.readOnly) {
        session.readOnly = next.readOnly;
        setReadOnly(next.readOnly);
      }
      if (!wasDirty) {
        applyDocText(next.content, true);
      }
    };
    return () => {
      session.invokeAction = undefined;
      session.setClosing = undefined;
      session.discard = undefined;
      session.syncData = undefined;
    };
  }, [applyDocText, invokeAction, session]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const fontSlot = new Compartment();
    const caretSlot = new Compartment();
    const lineNumbersSlot = new Compartment();
    const foldingSlot = new Compartment();
    const heavySlot = new Compartment();
    const langSlot = new Compartment();
    const readOnlySlot = readOnlySlotRef.current;
    const editorSettings = () => useProject.getState().settings?.editor;
    const effectiveReadOnly = session.readOnly || session.closing;

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: session.currentText,
        extensions: [
          fontSlot.of(fontExtension(editorSettings())),
          caretSlot.of(caretExtension(editorPrefs())),
          lineNumbersSlot.of(lineNumbersExtension(editorSettings())),
          foldingSlot.of(foldingExtension(editorPrefs().folding.showOutline)),
          heavySlot.of(heavyExtension(session.currentText.length, editorSettings())),
          langSlot.of([]),
          readOnlySlot.of([EditorState.readOnly.of(effectiveReadOnly), EditorView.editable.of(!effectiveReadOnly)]),
          fontZoom,
          wheelZoom,
          caretRowHighlight,
          openideaTheme,
          highlightSpecialChars(),
          syntaxHighlighting(openideaHighlightStyle),
          history(),
          findExtension(),
          overviewLane,
          Prec.high(
            keymap.of([
              { key: "Escape", run: () => findEscapeRef.current() },
              { key: "Mod-s", run: () => saveShortcutRef.current() },
            ]),
          ),
          keymap.of([...historyKeymap, ...defaultKeymap, indentWithTab]),
          EditorView.contentAttributes.of({ "aria-label": session.data.title }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !suppressDirtyRef.current) {
              session.currentText = u.state.doc.toString();
              const nextDirty = session.currentText !== session.baselineText;
              setModified(nextDirty);
              notifyEditorDocumentChanged();
            }
            if (u.docChanged || u.selectionSet) {
              findWatchersRef.current.forEach((fn) => fn(u));
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    session.view = view;
    setViewGen((g) => g + 1);

    let alive = true;
    const desc = findLanguageDescription(session.data.language ?? null, session.data.fileName ?? session.data.title);
    if (desc) {
      void loadSupport(desc).then((support) => {
        if (alive && support && viewRef.current === view) {
          view.dispatch({ effects: langSlot.reconfigure(support) });
        }
      });
    }

    let prevAppearance = editorPrefs().appearance;
    let prevEditor = editorSettings();
    const offSettings = useProject.subscribe(() => {
      const effects: StateEffect<unknown>[] = [];
      const nextPrefs = editorPrefs();
      const nextEditor = editorSettings();
      if (JSON.stringify(nextPrefs.appearance) !== JSON.stringify(prevAppearance)) {
        prevAppearance = nextPrefs.appearance;
        effects.push(caretSlot.reconfigure(caretExtension(nextPrefs)));
      }
      if (nextEditor !== prevEditor) {
        prevEditor = nextEditor;
        effects.push(
          fontSlot.reconfigure(fontExtension(nextEditor)),
          lineNumbersSlot.reconfigure(lineNumbersExtension(nextEditor)),
          foldingSlot.reconfigure(foldingExtension(nextPrefs.folding.showOutline)),
          heavySlot.reconfigure(heavyExtension(view.state.doc.length, nextEditor)),
        );
      }
      if (effects.length) view.dispatch({ effects });
    });

    const offPlugins = usePlugins.subscribe((state, previous) => {
      const p = state.plugins.find((pl) => pl.id === session.data.pluginId);
      const prev = previous.plugins.find((pl) => pl.id === session.data.pluginId);
      if (p?.enabled !== prev?.enabled && !p?.enabled) {
        cancelPluginContentRequests(session.data.pluginId);
      }
    });

    return () => {
      alive = false;
      offSettings();
      offPlugins();
      session.view = null;
      view.destroy();
      viewRef.current = null;
    };
  }, [session, data.language, data.fileName, data.title]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const effectiveReadOnly = readOnly || session.closing;
    view.dispatch({
      effects: readOnlySlotRef.current.reconfigure([
        EditorState.readOnly.of(effectiveReadOnly),
        EditorView.editable.of(!effectiveReadOnly),
      ]),
    });
  }, [readOnly, session]);

  useEffect(() => {
    return registerKeyClaim((e, stroke) => {
      if (!rootRef.current?.contains(e.target as Node)) return false;
      const view = viewRef.current;
      if (!view) return false;
      if (isActionStroke(stroke, "find.inFile") || stroke === "Meta+F" || stroke === "Ctrl+F") {
        e.preventDefault();
        e.stopPropagation();
        openFind(false);
        return true;
      }
      if (isActionStroke(stroke, "find.replaceInFile") || stroke === "Meta+R" || stroke === "Ctrl+R") {
        e.preventDefault();
        e.stopPropagation();
        openFind(true);
        return true;
      }
      if (isActionStroke(stroke, "find.next") || isActionStroke(stroke, "find.previous")) {
        e.preventDefault();
        e.stopPropagation();
        if (!searchAgain(findTarget, isActionStroke(stroke, "find.next"))) openFind(false);
        return true;
      }
      if (isActionStroke(stroke, "file.saveAll") || stroke === "Meta+S" || stroke === "Ctrl+S") {
        if (saveShortcutRef.current()) {
          e.preventDefault();
          e.stopPropagation();
          return true;
        }
      }
      if (
        isActionStroke(stroke, "editor.increaseFontSize") ||
        stroke === "Meta+=" ||
        stroke === "Meta+Shift+=" ||
        stroke === "Ctrl+=" ||
        stroke === "Ctrl+Shift+=" ||
        stroke === "Meta+NumpadAdd" ||
        stroke === "Ctrl+NumpadAdd"
      ) {
        e.preventDefault();
        e.stopPropagation();
        stepFontZoom(view, 1);
        return true;
      }
      if (
        isActionStroke(stroke, "editor.decreaseFontSize") ||
        stroke === "Meta+-" ||
        stroke === "Meta+Shift+-" ||
        stroke === "Ctrl+-" ||
        stroke === "Ctrl+Shift+-" ||
        stroke === "Meta+NumpadSubtract" ||
        stroke === "Ctrl+NumpadSubtract"
      ) {
        e.preventDefault();
        e.stopPropagation();
        stepFontZoom(view, -1);
        return true;
      }
      if (isActionStroke(stroke, "editor.resetFontSize") || stroke === "Meta+0" || stroke === "Ctrl+0") {
        e.preventDefault();
        e.stopPropagation();
        view.dispatch({ effects: setFontZoom.of(0) });
        return true;
      }
      if (stroke === "Escape" && findOpenRef.current) {
        e.preventDefault();
        e.stopPropagation();
        closeFind();
        return true;
      }
      return false;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findTarget, readOnly]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    const stroke = strokeOf(e.nativeEvent);
    const view = viewRef.current;
    if (!view || !stroke) return;
    if (isActionStroke(stroke, "find.inFile") || stroke === "Meta+F" || stroke === "Ctrl+F") {
      openFind(false);
    } else if (isActionStroke(stroke, "find.replaceInFile") || stroke === "Meta+R" || stroke === "Ctrl+R") {
      openFind(true);
    } else if (isActionStroke(stroke, "find.next") || isActionStroke(stroke, "find.previous")) {
      if (!searchAgain(findTarget, isActionStroke(stroke, "find.next"))) openFind(false);
    } else if (stroke === "Meta+S" || stroke === "Ctrl+S") {
      if (!saveShortcutRef.current()) return;
    } else if (e.key === "Escape" && findOpenRef.current) {
      closeFind();
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  useEffect(() =>
    bindContentControls(findId, {
      key: input.key,
      find: (replace = false) => openFind(replace),
      runAction: (id: string) => void invokeAction(id, false).catch(() => {}),
    }),
  );

  return (
    <div ref={rootRef} className={logStyles.pane} onKeyDown={onKeyDown}>
      <div className={logStyles.toolbar}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>{data.title}</span>
        {modified && (
          <span style={{ fontSize: 11.5, color: "var(--warning)", fontWeight: 500 }}>• {tx("Modified")}</span>
        )}
        {status && (
          <span
            style={{
              fontSize: 11.5,
              color: status.isError ? "var(--danger)" : "var(--fg-muted)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={status.text}
          >
            {status.text}
          </span>
        )}
        <span className={logStyles.flex} />
        <IconButton
          icon="search"
          size="small"
          title="Find in Editor"
          action="plugins.content.find"
          actionArg={findId}
        />
        {data.actions.map((action) => (
          <Button
            key={action.id}
            variant={action.primary ? "primary" : "secondary"}
            size="small"
            disabled={busy || session.closing}
            onClick={() => void executeAction("plugins.content.action", { target: findId, id: action.id })}
          >
            {action.icon && <Icon name={action.icon} size={14} />}
            {action.label}
          </Button>
        ))}
      </div>
      {find && (
        <FindPanel
          target={findTarget}
          version={viewGen}
          replace={find.replace && !readOnly}
          seq={find.seq}
          onReplaceShown={(replace) => setFind((f) => (f ? { ...f, replace: replace && !readOnly } : f))}
          onClose={closeFind}
        />
      )}
      <div ref={hostRef} className={logStyles.output} />
    </div>
  );
}
