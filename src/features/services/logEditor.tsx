/**
 * Container log in a regular CodeMirror 6 Editor Tab (`DOCKER_LOG_EDITOR_KIND`),
 * with log syntax highlighting, line numbers, Timestamps & Soft-wrap toggles,
 * Find (`⌘F`) and font zoom (`⌘=` / `⌘-` / `⌘0`), matching `PluginLogEditor`.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Channel } from "@tauri-apps/api/core";
import { Compartment, EditorState, Prec, type StateEffect } from "@codemirror/state";
import { EditorView, highlightSpecialChars, keymap } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { LanguageSupport, syntaxHighlighting } from "@codemirror/language";
import { caretRowHighlight } from "@/editor/core/cm/caretRow";
import { findExtension, findResultLines, findScope, type FindOptions } from "@/editor/core/cm/find";
import { openideaHighlightStyle } from "@/editor/core/cm/highlight";
import { overviewLane } from "@/editor/core/cm/lanes";
import { logLanguage } from "@/editor/core/cm/log";
import { caretExtension, fontZoom, setFontZoom, softWrapActive, stepFontZoom } from "@/editor/core/cm/prefs";
import { fontExtension, heavyExtension, lineNumbersExtension, prefsOf } from "@/editor/core/cm/setup";
import { openideaTheme } from "@/editor/core/cm/theme";
import { FindPanel, searchAgain, seedFind, type FindTarget } from "@/editor/core/view/FindBar";
import { editorPrefs } from "@/platform/editorSettings";
import { tx } from "@/platform/i18n";
import { call, commands, isCancelled, nextRequestId, type DockerContainer, type DockerLogLine } from "@/platform/ipc";
import { bindingsFor, normalizeBinding, registerKeyClaim, strokeOf } from "@/platform/keymap";
import { useProject } from "@/platform/project";
import { EmptyState, IconButton, Toggle, selectableText } from "@/ui";
import logStyles from "@/ui/LogPane.module.css";
import { editorService, type EditorInput } from "@/workbench/contributions";
import { isRunning } from "./model";
import { connectionState, endpointOf, errorMessage, useServices } from "./store";

export const DOCKER_LOG_EDITOR_KIND = "dockerLog";

export interface DockerLogEditorData {
  conn: string;
  containerId: string;
  containerName: string;
}

export function dockerLogEditorTitle(input: EditorInput): string {
  const data = input.data as Partial<DockerLogEditorData> | undefined;
  return data?.containerName ? `${data.containerName} (Log)` : input.key;
}

export function openContainerLogInEditor(conn: string, container: DockerContainer): void {
  const data: DockerLogEditorData = {
    conn,
    containerId: container.id,
    containerName: container.name,
  };
  void editorService().openInput({
    kind: DOCKER_LOG_EDITOR_KIND,
    key: `${DOCKER_LOG_EDITOR_KIND}:${conn}:${container.id}`,
    data,
  });
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g; // eslint-disable-line no-control-regex

function boundedLog(text: string): string {
  let result = text.slice(-(1 << 20));
  if (/^[\uDC00-\uDFFF]/.test(result)) result = result.slice(1);
  const lines = result.split("\n");
  if (lines.length > 5000) result = lines.slice(-5000).join("\n");
  return result;
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

export function DockerLogEditor({ input }: { input: EditorInput }) {
  const data = input.data as DockerLogEditorData | undefined;
  if (!data || !data.containerId) {
    return <EmptyState title={tx("Invalid log stream configuration")} />;
  }
  return <DockerLogEditorBody input={input} data={data} />;
}

function DockerLogEditorBody({ input, data }: { input: EditorInput; data: DockerLogEditorData }) {
  const initialWrap = useMemo(() => {
    const s = useProject.getState().settings?.editor;
    return softWrapActive(s?.softWrap ?? true, prefsOf(s), "stream.log");
  }, []);
  const [timestamps, setTimestamps] = useState(false);
  const [wrap, setWrap] = useState<boolean>(initialWrap);
  const [find, setFind] = useState<{ seq: number } | null>(null);
  const [viewGen, setViewGen] = useState(0);

  const running = useServices((s) => {
    const c = connectionState(data.conn, s).snapshot?.containers.find((x) => x.id === data.containerId);
    return c ? isRunning(c) : true;
  });

  const rootRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const wrapSlotRef = useRef(new Compartment());
  const stickRef = useRef(true);
  const receivedRef = useRef(false);
  const findOpenRef = useRef(false);
  const findWatchersRef = useRef(new Set<(u: { docChanged: boolean; selectionSet: boolean }) => void>());
  const findEscapeRef = useRef<() => boolean>(() => false);
  const findId = useId();
  const title = `${data.containerName} (Log)`;

  const findTarget = useMemo<FindTarget>(
    () => ({
      id: `dockerLog:${findId}:${input.key}`,
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
            scope: { kind: "files", paths: [title] },
            maxMatches: 0,
          },
          read: () => ({
            path: title,
            relPath: title,
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
    [findId, input.key, title],
  );

  const openFind = () => {
    if (!viewRef.current) return;
    findOpenRef.current = true;
    seedFind(findTarget, false);
    setFind((f) => ({ seq: (f?.seq ?? 0) + 1 }));
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

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const fontSlot = new Compartment();
    const caretSlot = new Compartment();
    const lineNumbersSlot = new Compartment();
    const heavySlot = new Compartment();
    const wrapSlot = wrapSlotRef.current;
    const editorSettings = () => useProject.getState().settings?.editor;

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: tx("Waiting for output…"),
        extensions: [
          fontSlot.of(fontExtension(editorSettings())),
          caretSlot.of(caretExtension(editorPrefs())),
          lineNumbersSlot.of(lineNumbersExtension(editorSettings())),
          wrapSlot.of(wrap ? EditorView.lineWrapping : []),
          heavySlot.of(heavyExtension(0, editorSettings())),
          fontZoom,
          wheelZoom,
          caretRowHighlight,
          openideaTheme,
          highlightSpecialChars(),
          syntaxHighlighting(openideaHighlightStyle),
          new LanguageSupport(logLanguage),
          findExtension(),
          overviewLane,
          Prec.high(keymap.of([{ key: "Escape", run: () => findEscapeRef.current() }])),
          keymap.of(defaultKeymap),
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.contentAttributes.of({
            "aria-label": title,
            class: selectableText,
            tabindex: "0",
          }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged || u.selectionSet) {
              findWatchersRef.current.forEach((fn) => fn(u));
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    setViewGen((g) => g + 1);

    const onScroll = () => {
      const el = view.scrollDOM;
      stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
    };
    view.scrollDOM.addEventListener("scroll", onScroll, { passive: true });

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
          heavySlot.reconfigure(heavyExtension(view.state.doc.length, nextEditor)),
        );
      }
      if (effects.length) view.dispatch({ effects });
    });

    return () => {
      offSettings();
      view.scrollDOM.removeEventListener("scroll", onScroll);
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: wrapSlotRef.current.reconfigure(wrap ? EditorView.lineWrapping : []),
    });
  }, [wrap]);

  useEffect(() => {
    return registerKeyClaim((e, stroke) => {
      if (!rootRef.current?.contains(e.target as Node)) return false;
      const view = viewRef.current;
      if (!view) return false;
      if (isActionStroke(stroke, "find.inFile") || stroke === "Meta+F" || stroke === "Ctrl+F") {
        e.preventDefault();
        e.stopPropagation();
        openFind();
        return true;
      }
      if (isActionStroke(stroke, "find.next") || isActionStroke(stroke, "find.previous")) {
        e.preventDefault();
        e.stopPropagation();
        if (!searchAgain(findTarget, isActionStroke(stroke, "find.next"))) openFind();
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
  }, [findTarget]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    const stroke = strokeOf(e.nativeEvent);
    const view = viewRef.current;
    if (!view || !stroke) return;
    if (isActionStroke(stroke, "find.inFile") || stroke === "Meta+F" || stroke === "Ctrl+F") {
      openFind();
    } else if (isActionStroke(stroke, "find.next") || isActionStroke(stroke, "find.previous")) {
      if (!searchAgain(findTarget, isActionStroke(stroke, "find.next"))) openFind();
    } else if (
      isActionStroke(stroke, "editor.increaseFontSize") ||
      stroke === "Meta+=" ||
      stroke === "Meta+Shift+=" ||
      stroke === "Ctrl+="
    ) {
      stepFontZoom(view, 1);
    } else if (
      isActionStroke(stroke, "editor.decreaseFontSize") ||
      stroke === "Meta+-" ||
      stroke === "Meta+Shift+-" ||
      stroke === "Ctrl+-"
    ) {
      stepFontZoom(view, -1);
    } else if (isActionStroke(stroke, "editor.resetFontSize") || stroke === "Meta+0" || stroke === "Ctrl+0") {
      view.dispatch({ effects: setFontZoom.of(0) });
    } else if (e.key === "Escape" && findOpenRef.current) {
      closeFind();
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    receivedRef.current = false;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: tx("Waiting for output…") } });
    stickRef.current = true;
    let stopped = false;
    let buffer: string[] = [];
    let frame = 0;

    const append = (chunk: string) => {
      if (stopped || !viewRef.current) return;
      const v = viewRef.current;
      const previous = receivedRef.current ? v.state.doc.toString() : "";
      receivedRef.current = true;
      const joined = previous ? `${previous}\n${chunk}` : chunk;
      const result = boundedLog(joined);
      const stick = stickRef.current;
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: result } });
      if (stick && !findOpenRef.current) v.scrollDOM.scrollTop = v.scrollDOM.scrollHeight;
    };

    const flush = () => {
      frame = 0;
      if (!buffer.length) return;
      const lines = buffer;
      buffer = [];
      append(lines.join("\n"));
    };

    const request = nextRequestId();
    const channel = new Channel<DockerLogLine>();
    channel.onmessage = (line) => {
      if (stopped) return;
      buffer.push(line.text.replace(ANSI, ""));
      frame ||= requestAnimationFrame(flush);
    };
    call(
      commands.dockerLogs(request, endpointOf(data.conn), data.containerId, 1000, running, timestamps, channel),
    ).catch((e) => {
      if (!stopped && !isCancelled(e)) {
        append(`Error: ${errorMessage(e)}`);
      }
    });

    return () => {
      stopped = true;
      if (frame) cancelAnimationFrame(frame);
      void commands.cancelRequest(request);
    };
  }, [data.conn, data.containerId, running, timestamps]);

  const clearLogs = () => {
    const view = viewRef.current;
    if (!view) return;
    receivedRef.current = true;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: "" },
    });
  };

  return (
    <div ref={rootRef} className={logStyles.pane} onKeyDown={onKeyDown}>
      <div className={logStyles.toolbar}>
        <Toggle checked={timestamps} onChange={setTimestamps} label="Timestamps" aria-label="Timestamps" />
        <Toggle checked={wrap} onChange={setWrap} label="Soft-wrap" aria-label="Soft-wrap" />
        <span className={logStyles.flex} />
        <IconButton icon="search" size="small" title="Find in Logs" onClick={openFind} />
        <IconButton icon="trash" size="small" title="Clear" onClick={clearLogs} />
      </div>
      {find && <FindPanel target={findTarget} version={viewGen} replace={false} seq={find.seq} onClose={closeFind} />}
      <div ref={hostRef} className={logStyles.output} />
    </div>
  );
}
