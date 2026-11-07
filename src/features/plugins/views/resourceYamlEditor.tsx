import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Compartment, EditorState, Prec, type StateEffect } from "@codemirror/state";
import { EditorView, highlightSpecialChars, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
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
import { editorPrefs } from "@/platform/editorSettings";
import { tx } from "@/platform/i18n";
import { bindingsFor, normalizeBinding, registerKeyClaim, strokeOf } from "@/platform/keymap";
import { useProject } from "@/platform/project";
import { Button, EmptyState, IconButton } from "@/ui";
import logStyles from "@/ui/LogPane.module.css";
import { notifications, type EditorInput } from "@/workbench/contributions";
import { pluginsBackend } from "../backend";
import { errorText } from "../store";

export const PLUGIN_YAML_EDITOR_KIND = "pluginResourceYaml";

export interface PluginYamlEditorData {
  pluginId: string;
  title: string;
  context: string;
  namespace: string;
  kind: string;
  name: string;
}

export function pluginYamlEditorTitle(input: EditorInput): string {
  const data = input.data as Partial<PluginYamlEditorData> | undefined;
  return data?.title || input.key;
}

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

export function PluginResourceYamlEditor({ input }: { input: EditorInput }) {
  const data = input.data as PluginYamlEditorData | undefined;
  if (!data || !data.kind || !data.name) {
    return <EmptyState title="Invalid Kubernetes resource YAML configuration" />;
  }
  return <PluginResourceYamlEditorBody input={input} data={data} />;
}

function PluginResourceYamlEditorBody({ input, data }: { input: EditorInput; data: PluginYamlEditorData }) {
  const [status, setStatus] = useState<{ text: string; isError: boolean } | null>({
    text: "Loading live YAML…",
    isError: false,
  });
  const [busy, setBusy] = useState<boolean>(false);
  const [modified, setModified] = useState<boolean>(false);
  const [diffText, setDiffText] = useState<string | null>(null);
  const [find, setFind] = useState<{ replace: boolean; seq: number } | null>(null);
  const [viewGen, setViewGen] = useState(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const baselineRef = useRef<string>("");
  const findOpenRef = useRef(false);
  const findWatchersRef = useRef(new Set<(u: { docChanged: boolean; selectionSet: boolean }) => void>());
  const findEscapeRef = useRef<() => boolean>(() => false);
  const saveApplyRef = useRef<() => void>(() => {});
  const findId = useId();

  const findTarget = useMemo<FindTarget>(
    () => ({
      id: `pluginYaml:${findId}:${input.key}`,
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

  const openFind = (replace: boolean) => {
    if (!viewRef.current) return;
    findOpenRef.current = true;
    seedFind(findTarget, replace);
    setFind((f) => ({ replace, seq: (f?.seq ?? 0) + 1 }));
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

  const replaceEditorDoc = useCallback((text: string) => {
    const view = viewRef.current;
    baselineRef.current = text;
    setModified(false);
    if (!view) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
    });
  }, []);

  const reloadYaml = useCallback(async () => {
    setBusy(true);
    setDiffText(null);
    setStatus({ text: "Loading live YAML from cluster…", isError: false });
    try {
      const res = await pluginsBackend().runCommand(
        data.pluginId,
        "inspect",
        JSON.stringify({
          op: "live-yaml-get",
          context: data.context,
          namespace: data.namespace,
          kind: data.kind,
          name: data.name,
        }),
        null,
        [],
      );
      const text = res ?? "";
      replaceEditorDoc(text);
      setStatus(null);
    } catch (err) {
      setStatus({ text: errorText(err), isError: true });
    } finally {
      setBusy(false);
    }
  }, [data.pluginId, data.context, data.namespace, data.kind, data.name, replaceEditorDoc]);

  const diffYaml = useCallback(async () => {
    const view = viewRef.current;
    if (!view) return;
    const yaml = view.state.doc.toString();
    setBusy(true);
    setStatus({ text: "Running kubectl diff -f -…", isError: false });
    try {
      const res = await pluginsBackend().runCommand(
        data.pluginId,
        "diff",
        JSON.stringify({
          op: "live-yaml-diff",
          context: data.context,
          namespace: data.namespace,
          yaml,
        }),
        null,
        [],
      );
      const text = (res ?? "").trim();
      setDiffText(text || "No differences against live cluster.");
      setStatus(null);
    } catch (err) {
      setStatus({ text: errorText(err), isError: true });
    } finally {
      setBusy(false);
    }
  }, [data.pluginId, data.context, data.namespace]);

  const saveAndApplyYaml = useCallback(async () => {
    const view = viewRef.current;
    if (!view) return;
    const yaml = view.state.doc.toString();
    setBusy(true);
    setDiffText(null);
    setStatus({ text: "Applying YAML to cluster…", isError: false });
    try {
      const res = await pluginsBackend().runCommand(
        data.pluginId,
        "apply",
        JSON.stringify({
          op: "live-yaml-apply",
          context: data.context,
          namespace: data.namespace,
          kind: data.kind,
          name: data.name,
          yaml,
        }),
        null,
        [],
      );
      baselineRef.current = yaml;
      setModified(false);
      const msg = (res ?? "").trim().split("\n")[0] || `Applied ${data.kind}/${data.name}`;
      setStatus({ text: msg, isError: false });
      notifications().notify({ title: "Kubernetes Apply", body: msg, level: "info" });
    } catch (err) {
      const msg = errorText(err);
      setStatus({ text: msg, isError: true });
      notifications().notify({ title: "Kubernetes Apply Failed", body: msg, level: "error" });
    } finally {
      setBusy(false);
    }
  }, [data.pluginId, data.context, data.namespace, data.kind, data.name]);

  saveApplyRef.current = () => {
    void saveAndApplyYaml();
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const fontSlot = new Compartment();
    const caretSlot = new Compartment();
    const lineNumbersSlot = new Compartment();
    const foldingSlot = new Compartment();
    const heavySlot = new Compartment();
    const langSlot = new Compartment();
    const editorSettings = () => useProject.getState().settings?.editor;

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: "# Loading live YAML…\n",
        extensions: [
          fontSlot.of(fontExtension(editorSettings())),
          caretSlot.of(caretExtension(editorPrefs())),
          lineNumbersSlot.of(lineNumbersExtension(editorSettings())),
          foldingSlot.of(foldingExtension(editorPrefs().folding.showOutline)),
          heavySlot.of(heavyExtension(0, editorSettings())),
          langSlot.of([]),
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
              {
                key: "Mod-s",
                run: () => {
                  saveApplyRef.current();
                  return true;
                },
              },
            ]),
          ),
          keymap.of([...historyKeymap, ...defaultKeymap, indentWithTab]),
          EditorView.contentAttributes.of({ "aria-label": data.title }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) {
              setModified(u.state.doc.toString() !== baselineRef.current);
            }
            if (u.docChanged || u.selectionSet) {
              findWatchersRef.current.forEach((fn) => fn(u));
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    setViewGen((g) => g + 1);

    let alive = true;
    const desc = findLanguageDescription("YAML", "resource.yaml");
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

    void reloadYaml();

    return () => {
      alive = false;
      offSettings();
      view.destroy();
      viewRef.current = null;
    };
  }, [data.title, reloadYaml]);

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
        e.preventDefault();
        e.stopPropagation();
        void saveAndApplyYaml();
        return true;
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
  }, [findTarget, saveAndApplyYaml]);

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
      void saveAndApplyYaml();
    } else if (e.key === "Escape" && findOpenRef.current) {
      closeFind();
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div ref={rootRef} className={logStyles.pane} onKeyDown={onKeyDown}>
      <div className={logStyles.toolbar}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>
          Live YAML — {data.kind}/{data.name}
          {data.namespace ? ` (${data.namespace})` : ""}
        </span>
        {modified && <span style={{ fontSize: 11.5, color: "var(--warning)", fontWeight: 500 }}>• Modified</span>}
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
        <IconButton icon="search" size="small" title="Find / Replace (⌘F / ⌘R)" onClick={() => openFind(false)} />
        <Button variant="secondary" size="small" disabled={busy} onClick={() => void reloadYaml()}>
          Reload
        </Button>
        <Button variant="secondary" size="small" disabled={busy} onClick={() => void diffYaml()}>
          Diff
        </Button>
        <Button variant="primary" size="small" disabled={busy} onClick={() => void saveAndApplyYaml()}>
          Save &amp; Apply
        </Button>
      </div>
      {find && (
        <FindPanel
          target={findTarget}
          version={viewGen}
          replace={find.replace}
          seq={find.seq}
          onReplaceShown={(replace) => setFind((f) => (f ? { ...f, replace } : f))}
          onClose={closeFind}
        />
      )}
      {diffText !== null && (
        <div
          style={{
            maxHeight: "38%",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-elev)",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "4px 10px",
              borderBottom: "1px solid var(--border)",
              fontSize: 11.5,
              fontWeight: 600,
            }}
          >
            <span>kubectl diff against live cluster</span>
            <IconButton icon="close" size="small" title="Close Diff" onClick={() => setDiffText(null)} />
          </div>
          <pre
            style={{
              margin: 0,
              padding: "8px 12px",
              overflow: "auto",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--fs-code)",
              lineHeight: "var(--lh-code)",
              whiteSpace: "pre-wrap",
            }}
          >
            {diffText}
          </pre>
        </div>
      )}
      <div ref={hostRef} style={{ flex: 1, minHeight: 0, position: "relative", overflow: "hidden" }} />
    </div>
  );
}
