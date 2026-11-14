/**
 * Navigate › Declaration (⌘-click, ⌘B) on the file a `.http` line names: a request body
 * (`< ./body.json`), a response handler script (`> handler.js`), a response redirect
 * (`>> out.json`) and a saved response (`<> 2026-11-10T135253.200.json`). Saved responses
 * resolve against `.idea/httpRequests/`, where IntelliJ IDEA writes them, then against the
 * request file's folder.
 */
import type { Text } from "@codemirror/state";
import { docOf } from "@/editor/lsp/lsp";
import { registerNavigationProvider } from "@/editor/navigationProviders";
import { call, commands } from "@/platform/ipc";
import { HTTP_LANGUAGE } from "./editor";

/** The file named on the line at `offset`, as document offsets; `response` for a `<>` line. */
export function fileReferenceAt(
  doc: Text,
  offset: number,
): { value: string; from: number; to: number; response: boolean } | null {
  const line = doc.lineAt(offset);
  const m = /^(\s*(<>|>>!?|<|>)\s+)(\S(?:.*\S)?)\s*$/.exec(line.text);
  // `> {% … %}` is an inline handler script, not a file.
  if (!m || m[3]!.startsWith("{%")) return null;
  const from = line.from + m[1]!.length;
  const to = from + m[3]!.length;
  return offset >= from && offset <= to ? { value: m[3]!, from, to, response: m[2] === "<>" } : null;
}

export function registerFileNavigation(): () => void {
  return registerNavigationProvider(async (view, offset) => {
    const doc = docOf(view);
    if (!doc || doc.virtual || doc.language !== HTTP_LANGUAGE) return null;
    const at = fileReferenceAt(view.state.doc, offset);
    if (!at) return null;
    const candidates = at.response ? [`/.idea/httpRequests/${at.value}`, at.value] : [at.value];
    for (const value of candidates) {
      const path = await call(commands.fsResolveReference(doc.path, value)).catch(() => null);
      if (path) {
        const start = { line: 0, col: 0 };
        return { from: at.from, to: at.to, targets: [{ path, range: { start, end: start } }] };
      }
    }
    return { from: at.from, to: at.to, targets: [] };
  });
}
