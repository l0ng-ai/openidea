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
import { call, commands, isTauri, onIdeEvent, type TerminalId } from "@/platform/ipc";
import { bindingsFor, normalizeBinding, registerKeyClaim, strokeOf } from "@/platform/keymap";
import { useProject } from "@/platform/project";
import { EmptyState, IconButton, Toggle, selectableText } from "@/ui";
import logStyles from "@/ui/LogPane.module.css";
import type { EditorInput } from "@/workbench/contributions";
import { errorText } from "../store";

export const PLUGIN_LOG_EDITOR_KIND = "pluginLog";

export interface PluginLogToggleSpec {
  id: string;
  label: string;
  args: string[];
}

export interface PluginLogEditorData {
  pluginId: string;
  title: string;
  program: string;
  baseArgs: string[];
  toggles?: PluginLogToggleSpec[];
}

export function pluginLogEditorTitle(input: EditorInput): string {
  const data = input.data as Partial<PluginLogEditorData> | undefined;
  return data?.title || input.key;
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g; // eslint-disable-line no-control-regex
const MAX_LINES = 5000;

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
    return <EmptyState title="Invalid log stream configuration" />;
  }
  return <PluginLogEditorBody input={input} data={data} />;
}

function PluginLogEditorBody({ input, data }: { input: EditorInput; data: PluginLogEditorData }) {
  const initialWrap = useMemo(() => {
    const s = useProject.getState().settings?.editor;
    return softWrapActive(s?.softWrap ?? true, prefsOf(s), "pod.log");
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
        doc: "Waiting for output…",
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

  // Start / restart the streaming log process whenever source or toggles change.
  const onKey = [...on].sort().join("\0");
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    let hasReceivedLine = false;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: "Waiting for output…" },
    });
    stickRef.current = true;

    if (!isTauri()) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: "Live log streaming requires the desktop app." },
      });
      return;
    }

    let stopped = false;
    let termId: TerminalId | undefined;
    let remainder = "";
    let pendingLines: string[] = [];
    let frame = 0;

    const flush = () => {
      frame = 0;
      const v = viewRef.current;
      if (stopped || !v || pendingLines.length === 0) return;
      const batch = pendingLines;
      pendingLines = [];
      const wasStick = stickRef.current;
      if (!hasReceivedLine) {
        hasReceivedLine = true;
        const text = batch.slice(-MAX_LINES).join("\n");
        v.dispatch({
          changes: { from: 0, to: v.state.doc.length, insert: text },
        });
      } else {
        const insertText = `\n${batch.join("\n")}`;
        v.dispatch({
          changes: { from: v.state.doc.length, to: v.state.doc.length, insert: insertText },
        });
        const excess = v.state.doc.lines - MAX_LINES;
        if (excess > 0) {
          const cutLine = v.state.doc.line(excess);
          v.dispatch({
            changes: { from: 0, to: Math.min(v.state.doc.length, cutLine.to + 1), insert: "" },
          });
        }
      }
      if (wasStick && !findOpenRef.current) {
        v.scrollDOM.scrollTop = v.scrollDOM.scrollHeight;
      }
    };

    const pushLine = (raw: string) => {
      if (stopped) return;
      pendingLines.push(raw.replace(/\r$/, "").replace(ANSI, ""));
      frame ||= requestAnimationFrame(flush);
    };

    const flushRemainder = () => {
      if (remainder.length > 0) {
        pushLine(remainder);
        remainder = "";
      }
      if (frame) {
        cancelAnimationFrame(frame);
        flush();
      }
    };

    const offExit = onIdeEvent("terminalExited", (ev) => {
      if (stopped || termId === undefined || ev.terminal !== termId) return;
      flushRemainder();
      const msg = ev.code === null ? "[Process finished]" : `[Process finished with exit code ${ev.code}]`;
      pushLine(msg);
      if (frame) {
        cancelAnimationFrame(frame);
        flush();
      }
    });

    const extraArgs = (data.toggles ?? []).filter((t) => on.has(t.id)).flatMap((t) => t.args);
    const args = [...data.baseArgs, ...extraArgs];
    const cwd = useProject.getState().project?.root ?? "/";
    const channel = new Channel<string>();
    channel.onmessage = (chunk) => {
      if (stopped) return;
      remainder += chunk;
      const parts = remainder.split("\n");
      remainder = parts.pop() ?? "";
      for (const rawLine of parts) {
        pushLine(rawLine);
      }
    };

    void call(
      commands.termSpawn(
        {
          cwd,
          shell: data.program,
          args,
          env: { TERM: "dumb" },
          cols: 240,
          rows: 40,
          shellIntegration: false,
        },
        channel,
      ),
    ).then(
      (info) => {
        if (stopped) {
          void commands.termKill(info.id);
          return;
        }
        termId = info.id;
      },
      (err: unknown) => {
        if (!stopped) {
          pushLine(`Error: ${errorText(err)}`);
        }
      },
    );

    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      offExit();
      if (termId !== undefined) {
        void commands.termKill(termId);
      }
    };
  }, [input.key, data.program, data.baseArgs, data.toggles, onKey, on]);

  const toggle = (id: string, checked: boolean) => {
    const next = new Set(on);
    if (checked) next.add(id);
    else next.delete(id);
    setOn(next);
  };

  const clearLogs = () => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: "" },
    });
  };

  return (
    <div ref={rootRef} className={logStyles.pane} onKeyDown={onKeyDown}>
      <div className={logStyles.toolbar}>
        {(data.toggles ?? []).map((t) => (
          <Toggle key={t.id} checked={on.has(t.id)} onChange={(checked) => toggle(t.id, checked)} label={t.label} />
        ))}
        <Toggle checked={wrap} onChange={setWrap} label="Soft-wrap" />
        <span className={logStyles.flex} />
        <IconButton icon="search" size="small" title="Find in Logs (⌘F)" onClick={openFind} />
        <IconButton icon="trash" size="small" title="Clear" onClick={clearLogs} />
      </div>
      {find && <FindPanel target={findTarget} version={viewGen} replace={false} seq={find.seq} onClose={closeFind} />}
      <div ref={hostRef} style={{ flex: 1, minHeight: 0, position: "relative", overflow: "hidden" }} />
    </div>
  );
}
