/** Registers the built-in pages as ordinary settings-page contributions and indexes their labels. */
import { onLanguageListChanged } from "@/platform/languageList";
import { registerSettingsPage, type SettingsPageContribution } from "@/workbench/contributions";
import { BEHAVIOR_PAGES } from "./behavior";
import { BUILTIN_PAGES as CORE_PAGES } from "./builtins";
import { DEPLOYMENT_PAGES } from "./deployment";
import { EDITOR_PAGES, codeStyleLanguagePages } from "./editor";
import { EXECUTION_PAGES } from "./execution";
import { LANGUAGE_PAGES } from "./languages";
import { OptionsPage } from "./OptionsPage";
import { RUN_TARGET_PAGES } from "./runTargets";
import { specLabels, type PageSpec } from "./spec";
import { SSH_PAGES } from "./ssh";
import { TOOLS_PAGES } from "./tools";
import { VCS_PAGES } from "./vcs";

const BUILTIN_PAGES = [
  ...BEHAVIOR_PAGES,
  ...CORE_PAGES,
  ...EDITOR_PAGES,
  ...VCS_PAGES,
  ...EXECUTION_PAGES,
  ...DEPLOYMENT_PAGES,
  ...RUN_TARGET_PAGES,
  ...TOOLS_PAGES,
  ...SSH_PAGES,
  ...LANGUAGE_PAGES,
];
const specs = new Map<string, PageSpec>(BUILTIN_PAGES.map((p) => [p.id, p]));

export function builtinSpec(id: string): PageSpec | undefined {
  return specs.get(id);
}

/** Option labels of a page for the search (built-ins only; contributions use `keywords`). */
export function pageLabels(id: string): string[] {
  const spec = specs.get(id);
  if (!spec) return [];
  try {
    return [...specLabels(spec), ...(spec.dynamicLabels?.() ?? [])];
  } catch {
    return specLabels(spec);
  }
}

/** Labels of a built-in page's options (each is a Search Everywhere entry). */
export function optionLabels(id: string): string[] {
  const spec = specs.get(id);
  return (spec?.sections ?? []).flatMap((s) => s.options.map((o) => o.label)).filter((l) => !!l.trim());
}

function toContribution(spec: PageSpec): SettingsPageContribution {
  const component = spec.component ?? (spec.sections ? () => <OptionsPage spec={spec} /> : undefined);
  return { id: spec.id, title: spec.title, group: spec.group, order: spec.order, keywords: spec.keywords, component };
}

export function registerBuiltinPages(): () => void {
  const disposers = BUILTIN_PAGES.map((spec) => registerSettingsPage(toContribution(spec)));
  // Code Style › <Language> pages come from the backend's language list, which plugins change.
  let live = true;
  let languagePages: (() => void)[] = [];
  let generation = 0;
  const loadLanguagePages = () => {
    const mine = ++generation;
    void codeStyleLanguagePages()
      .then((pages) => {
        if (!live || mine !== generation) return;
        languagePages.forEach((d) => d());
        languagePages = pages.map((spec) => {
          specs.set(spec.id, spec);
          return registerSettingsPage(toContribution(spec));
        });
      })
      .catch(() => {});
  };
  loadLanguagePages();
  const unsubscribe = onLanguageListChanged(loadLanguagePages);
  return () => {
    live = false;
    unsubscribe();
    languagePages.forEach((d) => d());
    disposers.forEach((d) => d());
  };
}
