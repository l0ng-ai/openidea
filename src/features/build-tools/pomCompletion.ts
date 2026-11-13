/**
 * Completion of Maven coordinates in `pom.xml`: typing inside the `<groupId>`,
 * `<artifactId>` or `<version>` of a `<dependency>` suggests the coordinates
 * installed in the local repository (Settings › Maven's, else `~/.m2/repository`)
 * and, behind them, Maven Central's — the search endpoint's popular coordinates
 * and the chosen artifact's published versions, cached per session by the
 * backend. It answers with the replaced value span (the whole current value, so
 * a suggestion picked mid-word replaces it) and ready suggestions; this side
 * only renders them, and an offline or failed lookup never blocks the local
 * ones.
 */
import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { EditorState, type Extension } from "@codemirror/state";
import { whenSynced, type EditorDocContext } from "@/editor/api";
import { call, commands, isTauri, nextRequestId } from "@/platform/ipc";

export function pomCompletionExtension(ctx: EditorDocContext): Extension {
  if (ctx.virtual || ctx.readOnly || !/(^|\/)pom\.xml$/.test(ctx.path)) return [];
  const completion = async (cm: CompletionContext): Promise<CompletionResult | null> => {
    if (!isTauri()) return null;
    const view = cm.view;
    if (!view) return null;
    const id = nextRequestId();
    const text = cm.state.doc;
    cm.addEventListener("abort", () => void commands.cancelRequest(id), { onDocChange: true });
    try {
      // The completion context is immutable; only use it while its document is current.
      await whenSynced(view);
      if (cm.aborted || view.state.doc !== text) return null;
      const found = await call(commands.mavenDependencyCompletion(ctx.doc, cm.pos, id));
      if (cm.aborted || view.state.doc !== text || !found?.options.length) return null;
      return {
        from: found.from,
        to: found.to,
        filter: false,
        // Kept in the backend's order (installed first, newest versions first): with no
        // filtering, equal scores would sort the list by label.
        options: found.options.map(({ label, detail }, i) => ({
          label,
          type: "constant",
          detail: detail ?? undefined,
          apply: label,
          boost: Math.max(99 - i, -99),
        })),
      };
    } catch {
      return null;
    }
  };
  return EditorState.languageData.of(() => [{ openideaCompletion: completion }]);
}
