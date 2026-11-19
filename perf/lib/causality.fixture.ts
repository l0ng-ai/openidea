import { EditorSelection, EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import { autocompletion, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { javascript } from "@codemirror/lang-javascript";
import { indentOnInput } from "@codemirror/language";
import type { InPage } from "./inpage.ts";
import type { EditorProbe } from "./editing.ts";

// The fixture owns both browser globals and exposes the same editor observation boundary as the app.
const w = window as unknown as {
  __fixture: Record<string, boolean>;
  __openideaPerf: EditorProbe;
  __perf?: InPage;
  __releaseOpen?: () => void;
};
const flags: Record<string, boolean> = {};
w.__fixture = flags;
const files = new Map<string, string>();
let path = "";
let view: EditorView;
const style = document.createElement("style");
style.textContent = ".cm-editor { height: 240px; width: 700px; } .cm-scroller { overflow: auto; }";
document.head.append(style);

// Registered before the measurement listener, so a lost recording is tested independently of editing.
window.addEventListener(
  "keydown",
  () => {
    if (flags.missingSample && w.__perf) w.__perf.recordKeys = false;
  },
  true,
);

function mount(text: string) {
  view?.destroy();
  view = new EditorView({
    parent: document.querySelector("#editor")!,
    state: EditorState.create({
      doc: text,
      extensions: [
        javascript(),
        indentOnInput(),
        closeBrackets(),
        Prec.highest(
          keymap.of([
            { key: "Mod-End", run: () => !!flags.disableJump },
            { key: "ArrowDown", run: () => !!flags.disableArrows },
            { key: "x", run: () => !!flags.swallowTyping },
          ]),
        ),
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, indentWithTab]),
        autocompletion({
          // Test movement itself, without CodeMirror's accidental-key guard after opening.
          interactionDelay: 0,
          override: [
            (ctx) => {
              const word = ctx.matchBefore(/\w*/);
              return {
                from: word?.from ?? ctx.pos,
                options: Array.from({ length: 50 }, (_, i) => ({ label: `getOrder${String(i).padStart(2, "0")}` })),
              };
            },
          ],
        }),
        EditorView.updateListener.of((update) => {
          if (flags.wrongCaret && update.docChanged)
            queueMicrotask(() => view.dispatch({ selection: EditorSelection.cursor(0) }));
          if (flags.mutateDistant && update.docChanged) {
            flags.mutateDistant = false;
            const end = view.state.doc.length;
            queueMicrotask(() => view.dispatch({ changes: { from: end - 1, to: end, insert: "z" } }));
          }
        }),
      ],
    }),
  });
  view.focus();
}

w.__openideaPerf = {
  seed: (p, text) => {
    files.set(p, text);
  },
  async openFile(p) {
    if (flags.rejectOpen) throw new Error("open failed");
    if (flags.ignoreOpen) return;
    if (flags.delayOpen)
      await new Promise<void>((resolve) => {
        w.__releaseOpen = resolve;
      });
    path = p;
    mount(flags.wrongContents ? view.state.doc.toString() : (files.get(p) ?? ""));
    let tab = document.querySelector<HTMLElement>('[role="tab"]');
    if (!tab) {
      tab = document.createElement("div");
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", "true");
      document.body.prepend(tab);
    }
    tab.textContent = p.slice(p.lastIndexOf("/") + 1);
  },
  editorText: (from = 0, to) => view?.state.doc.sliceString(from, to) ?? null,
  editorState() {
    if (!view) return null;
    const head = view.state.selection.main.head;
    return {
      path,
      head,
      length: view.state.doc.length,
      lines: view.state.doc.lines,
      line: view.state.doc.lineAt(head).number - 1,
      word: "",
    };
  },
  lineAtY(y) {
    const block = view.lineBlockAtHeight(y - view.documentTop);
    return view.state.doc.lineAt(block.from).number - 1;
  },
  setCursor(head) {
    view.dispatch({ selection: EditorSelection.cursor(head), scrollIntoView: true });
    view.focus();
  },
};
