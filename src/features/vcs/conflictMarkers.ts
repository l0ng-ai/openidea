/**
 * Reports the conflict markers a merge left in a file as errors, whatever its language and
 * whether or not a language server runs for it: IntelliJ's own parsers fail on them, but
 * without a server (Groovy, plain text, …) nothing else would say the file is unresolved.
 */
import { ViewPlugin } from "@codemirror/view";
import type { Text } from "@codemirror/state";
import { registerEditorContribution } from "@/editor/api";
import { setFileDiagnostics } from "@/editor/lsp/diagnostics";
import { offsetsToRange } from "@/editor/lsp/positions";
import type { Diagnostic } from "@/bindings";
import { tx } from "@/platform/i18n";
import { CONFLICT_MARKERS_PRODUCER } from "@/platform/inspections";
import { parseConflicts } from "./conflicts";

/** Large files are not scanned on each edit. */
const MAX_LENGTH = 2_000_000;
const DELAY_MS = 250;

/** An error on every marker line of the complete conflict blocks in `doc`. */
export function markerDiagnostics(doc: Text): Diagnostic[] {
  if (doc.length > MAX_LENGTH) return [];
  const text = doc.toString();
  // A cheap test first: most files have no marker at all.
  if (!text.includes("<<<<<<<")) return [];
  return parseConflicts(text).flatMap((block) =>
    block.markers.map((m) => ({
      range: offsetsToRange(doc, m.from, m.to),
      severity: "error" as const,
      message: tx("Unresolved merge conflict marker"),
      source: "Git",
      code: null,
    })),
  );
}

/** How many editors show each file: its diagnostics go away with the last one. */
const viewers = new Map<string, number>();

export function activate(): () => void {
  return registerEditorContribution({
    id: "merge-conflict-markers",
    extensions: (doc) =>
      doc.virtual
        ? []
        : ViewPlugin.define((view) => {
            viewers.set(doc.path, (viewers.get(doc.path) ?? 0) + 1);
            let timer: ReturnType<typeof setTimeout> | undefined;
            const publish = () =>
              setFileDiagnostics(doc.path, CONFLICT_MARKERS_PRODUCER, markerDiagnostics(view.state.doc));
            publish();
            return {
              update: (u) => {
                if (!u.docChanged) return;
                clearTimeout(timer);
                timer = setTimeout(publish, DELAY_MS);
              },
              destroy: () => {
                clearTimeout(timer);
                const remaining = (viewers.get(doc.path) ?? 1) - 1;
                if (remaining) viewers.set(doc.path, remaining);
                else {
                  viewers.delete(doc.path);
                  setFileDiagnostics(doc.path, CONFLICT_MARKERS_PRODUCER, []);
                }
              },
            };
          }),
  });
}
