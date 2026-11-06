/**
 * Syntax errors from the built-in parser (`structure.syntaxErrors`) as diagnostics, for files
 * no language server checks: none is configured for the language, or it is not installed,
 * stopped or crashed. A running server reports syntax errors itself, so none are added then.
 */
import type { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import type { Diagnostic, ServerStatus, SyntaxError } from "@/bindings";
import { whenSynced } from "@/editor/api";
import { structure } from "@/editor/structure";
import { tx } from "@/platform/i18n";
import { SYNTAX_ERRORS_PRODUCER } from "@/platform/inspections";
import { call, commands, isTauri, onIdeEvent } from "@/platform/ipc";
import { setFileDiagnostics } from "./diagnostics";
import { docOf } from "./lsp";
import { languageSemantics } from "./semantic";

const INSPECT_DELAY = 500;
const RUNNING: ReadonlySet<ServerStatus> = new Set<ServerStatus>(["starting", "ready", "busy"]);

let checked: Promise<ReadonlySet<string>> | null = null;
const listeners = new Set<() => void>();
let offEvents: (() => void) | null = null;

/** Languages a running language server checks (cached until a server changes). */
function checkedLanguages(): Promise<ReadonlySet<string>> {
  checked ??= call(commands.lspServers()).then(
    (servers) => new Set(servers.filter((s) => RUNNING.has(s.status)).flatMap((s) => s.languages)),
    () => new Set<string>(),
  );
  if (!offEvents) {
    const changed = () => {
      checked = null;
      for (const l of listeners) l();
    };
    const off = [onIdeEvent("languageServer", changed), onIdeEvent("languageServerRemoved", changed)];
    offEvents = () => off.forEach((f) => f());
  }
  return checked;
}

function syntaxErrorDiagnostic(e: SyntaxError): Diagnostic {
  const expected = e.expected;
  return {
    range: e.range,
    severity: "error",
    message: e.kind === "missing" && expected ? tx`'${expected}' expected` : tx("Unexpected token"),
    source: tx("Syntax"),
    code: null,
  };
}

/** Checks the file after edits (debounced) and when a language server starts or stops. */
export function syntaxErrorsExtension(): Extension {
  return ViewPlugin.define((view: EditorView) => {
    const doc = docOf(view);
    if (!doc || doc.virtual || languageSemantics(doc.language)?.skipSyntaxErrors || !isTauri()) return {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    let seq = 0;
    const run = async () => {
      const mine = ++seq;
      try {
        if ((await checkedLanguages()).has(doc.language)) {
          if (mine === seq) setFileDiagnostics(doc.path, SYNTAX_ERRORS_PRODUCER, []);
          return;
        }
        await whenSynced(view);
        const { errors } = await structure.syntaxErrors(doc.doc);
        if (mine !== seq) return;
        setFileDiagnostics(doc.path, SYNTAX_ERRORS_PRODUCER, errors.map(syntaxErrorDiagnostic));
      } catch (e) {
        console.debug("[syntax errors]", e);
      }
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void run(), INSPECT_DELAY);
    };
    schedule();
    listeners.add(schedule);
    return {
      update: (u) => {
        if (u.docChanged) schedule();
      },
      destroy: () => {
        clearTimeout(timer);
        listeners.delete(schedule);
        seq++;
        setFileDiagnostics(doc.path, SYNTAX_ERRORS_PRODUCER, []);
      },
    };
  });
}
