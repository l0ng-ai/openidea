import type { LanguageInfo } from "@/bindings";
import { unsupportedExpressionFunctions, type LiveTemplate, type TemplateVariable } from "./model";

export type TemplateLanguage = Pick<LanguageInfo, "id" | "name" | "uiMode">;

export interface JetBrainsTemplateImport {
  templates: LiveTemplate[];
  /** Files or template contexts that could not be mapped, with enough detail to find them. */
  skipped: string[];
  /** Malformed XML files; their templates are not imported. */
  invalid: string[];
  /** Expressions preserved for editing but not evaluated by OpenIDEA. */
  unsupported: string[];
}

const TEMPLATE_FILE = /^templates\/([^/]+)\.xml$/;
const normalize = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");

/** JetBrains context names that cover more than one OpenIDEA file type. */
const CONTEXT_ALIASES: Record<string, readonly string[]> = {
  "c/c++": ["c", "cpp"],
  "c++": ["cpp"],
  javascript: ["javascript", "javascriptreact"],
  typescript: ["typescript", "typescriptreact"],
  json: ["json", "jsonc"],
  jsx: ["javascriptreact"],
  tsx: ["typescriptreact"],
  text: ["plaintext"],
  // Context ids IDEA writes into `templates/*.xml` (`JS_STATEMENT`, `TS_EXPRESSION`, CLion's `OC_…`).
  js: ["javascript", "javascriptreact"],
  ts: ["typescript", "typescriptreact"],
  oc: ["c", "cpp"],
};

/** IDEA's Everywhere context (`EverywhereContextType`). */
const EVERYWHERE = "OTHER";
/** Contexts inside comments and strings, where a `code`-scoped template would never expand. */
const NON_CODE_CONTEXT = /(^|[_\s])(COMMENT|STRING)([_\s]|$)/i;

interface ContextIndex {
  byId: Map<string, TemplateLanguage>;
  languages: TemplateLanguage[];
}

/**
 * IDEA stores context ids such as `JAVA_STATEMENT`, `KOTLIN_TOPLEVEL`, `Python_Class` or
 * `PHP Statement`: the full id is tried first (`JAVA_SCRIPT`, `SHELL_SCRIPT`), then shorter
 * prefixes down to the language (`JAVA`, `KOTLIN`, `Python`, `PHP`).
 */
function contextLanguages(context: string, index: ContextIndex): string[] {
  if (context === EVERYWHERE) return ["any"];
  const parts = context.split(/[_\s]+/).filter(Boolean);
  for (let n = parts.length; n > 0; n--) {
    const ids = namedLanguages(parts.slice(0, n).join("_"), index);
    if (ids.length) return ids;
  }
  return [];
}

function namedLanguages(context: string, index: ContextIndex): string[] {
  const key = normalize(context);
  if (!key) return [];
  const ids = new Set<string>();
  for (const language of index.languages) {
    if (normalize(language.id) === key || normalize(language.name) === key) ids.add(language.id);
  }
  for (const id of CONTEXT_ALIASES[key] ?? []) if (index.byId.has(id)) ids.add(id);
  if (ids.size) return [...ids];

  // A UI mode such as Shell or JSX is a useful fallback, unless several file types share it.
  const modes = index.languages.filter((language) => language.uiMode && normalize(language.uiMode) === key);
  return modes.length === 1 ? [modes[0]!.id] : [];
}

function variable(element: Element, label: string, unsupported: string[]): TemplateVariable | null {
  const name = element.getAttribute("name")?.trim();
  if (!name) return null;
  const expression = element.getAttribute("expression") || undefined;
  const defaultValue = element.getAttribute("defaultValue");
  const out: TemplateVariable = { name };
  if (expression !== undefined) out.expression = expression;
  if (defaultValue !== null) out.defaultValue = defaultValue;
  // IDEA stops at every variable by default; OpenIDEA's inverse skips a produced value.
  if (element.getAttribute("alwaysStopAt") === "false") out.skipIfDefined = true;
  if (expression) {
    for (const call of unsupportedExpressionFunctions(expression)) unsupported.push(`${label} › ${name}: ${call}`);
  }
  return out;
}

export function parseJetBrainsTemplates(
  files: Record<string, string>,
  languages: readonly TemplateLanguage[],
): JetBrainsTemplateImport {
  const out: JetBrainsTemplateImport = { templates: [], skipped: [], invalid: [], unsupported: [] };
  const byId = new Map<string, LiveTemplate>();
  const index: ContextIndex = {
    byId: new Map(languages.map((language) => [language.id, language])),
    languages: [...languages],
  };
  const addUnique = (list: string[], value: string) => {
    if (!list.includes(value)) list.push(value);
  };

  for (const file of Object.keys(files)
    .filter((name) => TEMPLATE_FILE.test(name))
    .sort()) {
    const stem = TEMPLATE_FILE.exec(file)![1]!;
    const doc = new DOMParser().parseFromString(files[file]!, "application/xml");
    const root = doc.documentElement;
    if (doc.querySelector("parsererror") || root.tagName !== "templateSet") {
      out.invalid.push(file);
      continue;
    }
    // IDEA writes the group as `group`; `name` is accepted for hand-written sets.
    const group = (root.getAttribute("group") ?? root.getAttribute("name"))?.trim() || stem;
    for (const element of Array.from(root.children)) {
      if (element.tagName !== "template") continue;
      const name = element.getAttribute("name")?.trim();
      const body = element.getAttribute("value");
      const label = `${file} › ${group} › ${name || "(unnamed)"}`;
      if (!name || body === null) {
        addUnique(out.skipped, label);
        continue;
      }

      const variables: TemplateVariable[] = [];
      for (const child of Array.from(element.children)) {
        if (child.tagName !== "variable") continue;
        const parsed = variable(child, label, out.unsupported);
        if (parsed) variables.push(parsed);
        else addUnique(out.skipped, `${label} (variable)`);
      }

      const contexts: string[] = [];
      const unmapped: string[] = [];
      let nonCode = false;
      const context = Array.from(element.children).find((child) => child.tagName === "context");
      for (const option of Array.from(context?.children ?? [])) {
        if (option.tagName !== "option" || option.getAttribute("value")?.toLowerCase() !== "true") continue;
        const declared = option.getAttribute("name")?.trim();
        const mapped = declared ? contextLanguages(declared, index) : [];
        if (mapped.length) {
          if (NON_CODE_CONTEXT.test(declared!)) nonCode = true;
          for (const id of mapped) if (!contexts.includes(id)) contexts.push(id);
        } else {
          addUnique(unmapped, declared || "(unnamed)");
        }
      }
      // Missing, disabled or unmappable declarations are skipped, never broadened to `any`.
      if (!contexts.length) {
        for (const declared of unmapped.length ? unmapped : [""])
          addUnique(out.skipped, label + (declared ? ` (${declared})` : ""));
        continue;
      }
      if (unmapped.length) addUnique(out.skipped, `${label} (${unmapped.join(", ")})`);

      const template: LiveTemplate = {
        id: `jetbrains.${stem}.${name}`,
        group,
        abbrev: name,
        description: element.getAttribute("description") ?? "",
        body,
        contexts,
      };
      if (variables.length) template.variables = variables;
      if (nonCode) template.scope = "any";
      if (element.getAttribute("deactivated") === "true") template.enabled = false;
      byId.set(template.id, template);
    }
  }
  out.templates = [...byId.values()];
  out.unsupported = [...new Set(out.unsupported)];
  return out;
}
