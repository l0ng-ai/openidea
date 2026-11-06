/**
 * Hooks for the performance harness (`perf/`), exposed as `window.__openideaPerf`.
 * Loaded only in dev and in `vite build --mode perf`; release builds never
 * include it. Measurement itself lives in the harness so it stays out of the app.
 */
import { syntaxParserRunning } from "@codemirror/language";
import { executeAction } from "@/platform/actions";
import { bindingsFor } from "@/platform/keymap";
import { activeEditor } from "@/editor/api";
import { docBackend, type MemoryBackend } from "@/editor/core/backend";
import type { CompletionItem, CompletionKind } from "@/bindings";
import { setInvokeRoute } from "@/platform/tauriCore";
import { editorService } from "./contributions";

export interface PerfProbe {
  /** Seeds file contents for the in-memory document backend (plain-browser mode). */
  seed(path: string, text: string): void;
  openFile(path: string): Promise<void>;
  runAction(id: string): Promise<boolean>;
  /** Effective keymap bindings of an action, e.g. `["Ctrl+Shift+A"]`. */
  bindings(id: string): string[];
  /** Moves the caret of the active editor and focuses it. */
  setCursor(offset: number): void;
  /** True while the active editor's background syntax parser still has work. */
  parsing(): boolean;
  /** Document length and caret of the active editor. */
  editorState(): { path: string; length: number; lines: number; head: number } | null;
  /**
   * Answers code completion with `items` generated items (a language server's
   * list); other language server requests report no server. `0` removes it.
   */
  fakeCompletion(items: number): void;
}

const KINDS: CompletionKind[] = [
  "method",
  "function",
  "field",
  "variable",
  "class",
  "interface",
  "property",
  "keyword",
];

function completionItem(i: number): CompletionItem {
  const kind = KINDS[i % KINDS.length]!;
  // Shared prefixes so typing narrows the list gradually, like real symbols.
  const label = `${["get", "set", "create", "update", "find", "to", "is", "on"][i % 8]}${["Order", "Item", "Customer", "Invoice", "Payment", "Status"][(i >> 3) % 6]}${i}`;
  return {
    label,
    labelDetail: kind === "method" || kind === "function" ? "(id: string, options?: Options)" : null,
    detail: kind === "class" || kind === "interface" ? `com.acme.${label}` : "Promise<Result<Order>>",
    kind,
    documentation: null,
    sortText: String(i).padStart(5, "0"),
    filterText: null,
    preselect: false,
    deprecated: i % 97 === 0,
    insertText: label,
    isSnippet: false,
    replaceRange: null,
    replaceRangeTab: null,
    additionalEdits: [],
    commitCharacters: [],
    command: null,
    data: null,
    server: 1,
  };
}

export function installPerfProbe(): () => void {
  const probe: PerfProbe = {
    seed(path, text) {
      const backend = docBackend() as Partial<MemoryBackend>;
      if (!backend.files) throw new Error("seed() needs the in-memory backend");
      backend.files.set(path, text);
    },
    openFile: (path) => editorService().openFile(path),
    runAction: (id) => executeAction(id),
    bindings: (id) => bindingsFor(id),
    setCursor(offset) {
      const view = activeEditor()?.view;
      if (!view) throw new Error("no active editor");
      view.dispatch({ selection: { anchor: Math.min(offset, view.state.doc.length) }, scrollIntoView: true });
      view.focus();
    },
    parsing() {
      const view = activeEditor()?.view;
      return !!view && syntaxParserRunning(view);
    },
    fakeCompletion(count) {
      if (!count) return setInvokeRoute(null);
      const items = Array.from({ length: count }, (_, i) => completionItem(i));
      setInvokeRoute((cmd, args) => {
        if (cmd === "lsp_completion") return Promise.resolve({ isIncomplete: false, items });
        if (cmd === "lsp_resolve_completion") return Promise.resolve((args as { item: CompletionItem }).item);
        if (cmd.startsWith("lsp_"))
          return Promise.reject({ kind: "unavailable", message: "No language server available" });
        return null;
      });
    },
    editorState() {
      const e = activeEditor();
      if (!e) return null;
      const { doc, selection } = e.view.state;
      return { path: e.ctx.path, length: doc.length, lines: doc.lines, head: selection.main.head };
    },
  };
  const w = window as unknown as { __openideaPerf?: PerfProbe };
  w.__openideaPerf = probe;
  return () => void delete w.__openideaPerf;
}
