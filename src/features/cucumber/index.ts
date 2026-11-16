/**
 * Cucumber step navigation: Go to Declaration (⌘-click, ⌘B) on a `.feature` step opens its
 * JavaScript / TypeScript step definitions, and on a definition's pattern lists the feature
 * steps it matches.
 */
import { docOf } from "@/editor/lsp/lsp";
import { registerNavigationProvider } from "@/editor/navigationProviders";
import { onIdeEvent } from "@/platform/ipc";
import { featureSteps, stepDefinitions } from "./steps";
import { clearStepIndex, definitionsOf, isCucumberSource, usagesOf } from "./stepIndex";

const SCRIPT = /\.[cm]?[jt]sx?$/i;

export function activate(): () => void {
  const unregister = registerNavigationProvider(async (view, offset) => {
    const doc = docOf(view);
    if (!doc || doc.virtual) return null;
    const text = view.state.doc.toString();
    if (/\.feature$/i.test(doc.path)) {
      const step = featureSteps(text).find((s) => s.from <= offset && offset < s.to);
      if (!step) return null;
      const targets = await definitionsOf(step);
      return targets.length ? { from: step.from, to: step.to, targets } : null;
    }
    if (!SCRIPT.test(doc.path)) return null;
    const definition = stepDefinitions(text).find((d) => d.from <= offset && offset < d.to);
    if (!definition) return null;
    const targets = await usagesOf(definition);
    return targets.length ? { from: definition.from, to: definition.to, targets } : null;
  });
  const unsubscribe = onIdeEvent("fsChanged", (e) => {
    if ([...e.created, ...e.modified, ...e.removed].some((p) => isCucumberSource(String(p)))) clearStepIndex();
  });
  return () => {
    unsubscribe();
    unregister();
    clearStepIndex();
  };
}
