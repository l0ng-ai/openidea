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
import type { Commit, CompletionItem, CompletionKind, LogQuery } from "@/bindings";
import { setInvokeRoute } from "@/platform/tauriCore";
import { editorService } from "./contributions";

export interface PerfProbe {
  /** Seeds file contents for the in-memory document backend (plain-browser mode). */
  seed(path: string, text: string): void;
  openFile(path: string): Promise<void>;
  runAction(id: string, arg?: unknown): Promise<boolean>;
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
  /**
   * Answers the Git Log with `commits` generated commits (a main line with
   * feature branches merging into it), paged like the backend. `0` removes it.
   */
  fakeGitLog(commits: number): void;
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

function commit(i: number, count: number): Commit {
  const id = (n: number) => n.toString(16).padStart(40, "0");
  // Newest first: parents have higher indices. Every 12th commit merges a branch
  // started 7 commits back; every third commit skips ahead, keeping a few lanes open.
  const merge = i % 12 === 0 && i + 7 < count;
  const next = i % 3 === 2 && i + 3 < count ? i + 3 : i + 1;
  const parents = i + 1 >= count ? [] : merge ? [id(i + 1), id(i + 7)] : [id(next)];
  const time = Date.UTC(2026, 10, 5) - i * 3_600_000;
  const summary = `${["feat", "fix", "refactor", "test"][i % 4]}(orders): ${merge ? "merge" : "update"} order flow step ${i}`;
  return {
    id: id(i),
    shortId: id(i).slice(-8),
    parents,
    author: ["Ada Lovelace", "Linus Torvalds", "Grace Hopper", "Ken Thompson"][i % 4]!,
    email: `dev${i % 4}@acme.dev`,
    committer: "CI",
    committerEmail: "ci@acme.dev",
    timeMs: time,
    commitTimeMs: time,
    summary,
    message: summary,
    messageTruncated: false,
    refs: i === 0 ? ["HEAD -> main", "origin/main"] : i % 250 === 0 ? [`tag: v1.${count - i}`] : [],
  };
}

type Route = (cmd: string, args: unknown) => Promise<unknown> | null;
const routes = new Map<string, Route>();

/** Installs (or with `null` removes) one fake backend; the first that answers a command wins. */
function setRoute(name: string, next: Route | null) {
  if (next) routes.set(name, next);
  else routes.delete(name);
  setInvokeRoute(
    routes.size
      ? (cmd, args) => {
          for (const r of routes.values()) {
            const answer = r(cmd, args);
            if (answer) return answer;
          }
          return null;
        }
      : null,
  );
}

export function installPerfProbe(): () => void {
  const probe: PerfProbe = {
    seed(path, text) {
      const backend = docBackend() as Partial<MemoryBackend>;
      if (!backend.files) throw new Error("seed() needs the in-memory backend");
      backend.files.set(path, text);
    },
    openFile: (path) => editorService().openFile(path),
    runAction: (id, arg) => executeAction(id, arg),
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
      const items = Array.from({ length: count }, (_, i) => completionItem(i));
      setRoute(
        "completion",
        count
          ? (cmd, args) => {
              if (cmd === "lsp_completion") return Promise.resolve({ isIncomplete: false, items });
              if (cmd === "lsp_resolve_completion") return Promise.resolve((args as { item: CompletionItem }).item);
              if (cmd.startsWith("lsp_"))
                return Promise.reject({ kind: "unavailable", message: "No language server available" });
              return null;
            }
          : null,
      );
    },
    fakeGitLog(count) {
      const commits = Array.from({ length: count }, (_, i) => commit(i, count));
      setRoute(
        "gitLog",
        count
          ? (cmd, args) => {
              if (cmd !== "vcs_log") return null;
              const { skip, limit, range } = (args as { query: LogQuery }).query;
              // Outgoing commits (`@{u}..HEAD`) and the like: none.
              if (range) return Promise.resolve([]);
              return Promise.resolve(commits.slice(skip, limit ? skip + limit : undefined));
            }
          : null,
      );
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
