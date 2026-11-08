import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
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
import { executeAction } from "@/platform/actions";
import { editorPrefs } from "@/platform/editorSettings";
import { tx } from "@/platform/i18n";
import { bindingsFor, normalizeBinding, registerKeyClaim, strokeOf } from "@/platform/keymap";
import { useProject } from "@/platform/project";
import { EmptyState, IconButton, Toggle, selectableText } from "@/ui";
import logStyles from "@/ui/LogPane.module.css";
import type { EditorInput } from "@/workbench/contributions";
import { usePlugins } from "../store";
import { bindLogControls } from "./logActions";
import { boundedLog, type PluginLogEditorData } from "./logTab";
import { logTabPtyBackend, webPtyBackend } from "./ptyBackend";
import { ptyBridge } from "./ptyBridge";

export const PLUGIN_LOG_EDITOR_KIND = "pluginLog";

export function pluginLogEditorTitle(input: EditorInput): string {
  const data = input.data as Partial<PluginLogEditorData> | undefined;
  return data?.title || input.key;
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g; // eslint-disable-line no-control-regex

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

export function PluginLogEditor({ input }: { input: EditorInput }) {
  const data = input.data as PluginLogEditorData | undefined;
  if (!data || !data.program) {
    return <EmptyState title={tx("Invalid log stream configuration")} />;
  }
  return <PluginLogEditorBody input={input} data={data} />;
}

function PluginLogEditorBody({ input, data }: { input: EditorInput; data: PluginLogEditorData }) {
  const initialWrap = useMemo(() => {
    const s = useProject.getState().settings?.editor;
    return softWrapActive(s?.softWrap ?? true, prefsOf(s), "stream.log");
  }, []);
  const [on, setOn] = useState<ReadonlySet<string>>(() => new Set());
  const [wrap, setWrap] = useState<boolean>(initialWrap);
  const [find, setFind] = useState<{ seq: number } | null>(null);
  const [viewGen, setViewGen] = useState(0);

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

  const findTarget = useMemo<FindTarget>(
    () => ({
      id: `pluginLog:${findId}:${input.key}`,
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

  // Mount CodeMirror EditorView with regular editor's theme, font, color scheme, line numbers, find & zoom.
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
            "aria-label": data.title,
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
  }, [data.title]);

  // Reconfigure soft wrap when toggled.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: wrapSlotRef.current.reconfigure(wrap ? EditorView.lineWrapping : []),
    });
  }, [wrap]);

  // Claim Find (⌘F / ⌘G / ⇧⌘G) and Font Zoom (⌘= / ⌘+ / ⌘- / ⌘0 / keymap bindings) while focused.
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
        if (document.querySelector("[data-terminal-session]:hover, iframe[data-plugin-webview]:hover")) return false;
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
        if (document.querySelector("[data-terminal-session]:hover, iframe[data-plugin-webview]:hover")) return false;
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

  // One bounded PTY bridge per mounted tab; toggling replaces the owned process.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    receivedRef.current = false;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: tx("Waiting for output…") } });
    stickRef.current = true;
    let stopped = false;
    let pending = "";
    let sequence: unknown;
    let frame = 0;
    const append = (text: string) => {
      if (stopped) return;
      const previous = receivedRef.current ? view.state.doc.toString() : "";
      receivedRef.current = true;
      const clean = text.replace(/\r\n/g, "\n").replace(ANSI, "");
      const result = boundedLog(previous + clean);
      const removed = previous.length + clean.length - result.length;
      const stick = stickRef.current;
      if (view.state.doc.toString() !== previous || removed > previous.length) {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: result } });
      } else {
        view.dispatch({
          changes: [
            { from: 0, to: removed, insert: "" },
            { from: previous.length, insert: clean },
          ],
        });
      }
      if (stick && !findOpenRef.current) view.scrollDOM.scrollTop = view.scrollDOM.scrollHeight;
    };
    const flush = () => {
      frame = 0;
      append(pending);
      pending = "";
      const consumed = sequence;
      sequence = undefined;
      bridge.handle(JSON.stringify({ op: "pty-ack", sessionId: "log", sequence: consumed }));
    };
    const backend =
      data.origin === "code"
        ? logTabPtyBackend(data.pluginId, data.key ?? "", [...on])
        : webPtyBackend(data.pluginId, data.view);
    const bridge = ptyBridge(data.pluginId, backend, (message) => {
      const m = message as Record<string, unknown>;
      if (stopped) return;
      if (m.op === "pty-data") {
        pending = String(m.data);
        sequence = m.sequence;
        frame ||= requestAnimationFrame(flush);
      } else if (m.op === "pty-exit") {
        const exitCode = m.exitCode;
        append(m.exitCode === null ? tx("\n[Process finished]") : tx`\n[Process finished with exit code ${exitCode}]`);
      } else if (m.op === "pty-error") {
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        append(pending);
        pending = "";
        const error = m.error;
        append(tx`\nError: ${error}`);
      }
    });
    bridge.handle(
      JSON.stringify({
        op: "pty-spawn",
        sessionId: "log",
        program: data.program,
        args: [...data.args, ...data.toggles.filter((t) => on.has(t.id)).flatMap((t) => t.args)],
        cols: 240,
        rows: 40,
      }),
    );
    const stop = (report = true) => {
      if (stopped) return;
      bridge.close();
      if (frame) cancelAnimationFrame(frame);
      if (report) append(pending + tx("\n[Log stream stopped]"));
      stopped = true;
      pending = "";
    };
    const offPlugin = usePlugins.subscribe((state, previous) => {
      const key = (plugins: typeof state.plugins) => {
        const p = plugins.find((p) => p.id === data.pluginId);
        return (
          p &&
          JSON.stringify([
            p.path,
            p.version,
            p.enabled,
            ["failed", "disabled", "needsConsent"].includes(p.status),
            p.capabilities,
          ])
        );
      };
      if (key(state.plugins) !== key(previous.plugins)) stop();
    });
    const offProject = useProject.subscribe((state, previous) => {
      if (state.project !== previous.project) stop();
    });
    const onUnload = () => stop();
    window.addEventListener("pagehide", onUnload);
    return () => {
      stop(false);
      offPlugin();
      offProject();
      window.removeEventListener("pagehide", onUnload);
    };
  }, [data, on]);

  const toggle = (id: string, checked: boolean) => {
    const next = new Set(on);
    if (checked) next.add(id);
    else next.delete(id);
    setOn(next);
  };

  const clearLogs = () => {
    const view = viewRef.current;
    if (!view) return;
    receivedRef.current = true;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: "" },
    });
  };

  useEffect(() =>
    bindLogControls(findId, {
      key: input.key,
      find: openFind,
      clear: clearLogs,
      wrap: () => setWrap((value) => !value),
      toggle,
    }),
  );

  return (
    <div ref={rootRef} className={logStyles.pane} onKeyDown={onKeyDown}>
      <div className={logStyles.toolbar}>
        {(data.toggles ?? []).map((t) => (
          <Toggle
            key={t.id}
            checked={on.has(t.id)}
            onChange={(checked) =>
              void executeAction("plugins.log.toggleArgument", { target: findId, id: t.id, checked })
            }
            label={t.label}
            aria-label={t.label}
          />
        ))}
        <Toggle
          checked={wrap}
          onChange={() => void executeAction("plugins.log.wrap", findId)}
          label={tx("Soft-wrap")}
          aria-label={tx("Soft-wrap")}
        />
        <span className={logStyles.flex} />
        <IconButton icon="search" size="small" title="Find in Logs" action="plugins.log.find" actionArg={findId} />
        <IconButton icon="trash" size="small" title="Clear" action="plugins.log.clear" actionArg={findId} />
      </div>
      {find && <FindPanel target={findTarget} version={viewGen} replace={false} seq={find.seq} onClose={closeFind} />}
      <div ref={hostRef} className={logStyles.output} />
    </div>
  );
}
