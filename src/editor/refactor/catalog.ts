/**
 * IDEA's refactorings and how language-server code actions map onto them:
 * `refactor.extract.*` → Extract Method / Introduce Variable…, `refactor.inline*`
 * → Inline, `refactor.move*` → Move, signature rewrites → Change Signature.
 * Pull Members Up / Push Members Down come from the Java extension, not code actions.
 * Pure; used by Refactor This (⌃T) and the Refactor menu actions.
 */
import type { CodeAction } from "@/bindings";

export type RefactoringId =
  | "rename"
  | "changeSignature"
  | "move"
  | "safeDelete"
  | "extractMethod"
  | "extractVariable"
  | "extractConstant"
  | "extractField"
  | "extractParameter"
  | "inline"
  | "pullMembersUp"
  | "pushMembersDown";

export interface Refactoring {
  id: RefactoringId;
  /** Action id (keymaps, menu). */
  action: string;
  label: string;
  /** LSP kind prefix that can produce it; null for client-side refactorings. */
  kind: string | null;
  /** IDEA's reason when nothing applies at the caret / selection. */
  reason: (selection: boolean) => string;
}

const AT_NAME = "Caret should be positioned at the name of the element to be refactored";

/** IDEA's Refactor This order. */
export const REFACTORINGS: readonly Refactoring[] = [
  {
    id: "rename",
    action: "refactor.rename",
    label: "Rename…",
    kind: null,
    reason: () => "Caret should be on a symbol",
  },
  {
    id: "changeSignature",
    action: "refactor.changeSignature",
    label: "Change Signature…",
    kind: "refactor.rewrite",
    reason: () => "Caret should be positioned at the name of the function or method to be refactored",
  },
  { id: "move", action: "refactor.move", label: "Move…", kind: "refactor.move", reason: () => AT_NAME },
  {
    id: "safeDelete",
    action: "refactor.safeDelete",
    label: "Safe Delete…",
    kind: null,
    reason: () => "Caret should be on a symbol",
  },
  {
    id: "extractMethod",
    action: "refactor.extractMethod",
    label: "Extract Method…",
    kind: "refactor.extract",
    reason: (sel) =>
      sel ? "Selected block should represent a set of statements or an expression" : "Select the code to extract",
  },
  {
    id: "extractVariable",
    action: "refactor.extractVariable",
    label: "Introduce Variable…",
    kind: "refactor.extract",
    reason: (sel) => (sel ? "Selected block should represent an expression" : "Caret should be inside an expression"),
  },
  {
    id: "extractConstant",
    action: "refactor.extractConstant",
    label: "Introduce Constant…",
    kind: "refactor.extract",
    reason: (sel) => (sel ? "Selected block should represent an expression" : "Caret should be inside an expression"),
  },
  {
    id: "extractField",
    action: "refactor.extractField",
    label: "Introduce Field…",
    kind: "refactor.extract",
    reason: (sel) =>
      sel ? "Selected block should represent an expression" : "Caret should be inside an expression in a class",
  },
  {
    id: "extractParameter",
    action: "refactor.extractParameter",
    label: "Introduce Parameter…",
    kind: "refactor.extract",
    reason: (sel) =>
      sel ? "Selected block should represent an expression" : "Caret should be inside an expression in a function",
  },
  { id: "inline", action: "refactor.inline", label: "Inline…", kind: "refactor.inline", reason: () => AT_NAME },
  {
    id: "pullMembersUp",
    action: "refactor.pullMembersUp",
    label: "Pull Members Up…",
    kind: null,
    reason: () => "Caret should be inside a class that has members to pull up",
  },
  {
    id: "pushMembersDown",
    action: "refactor.pushMembersDown",
    label: "Push Members Down…",
    kind: null,
    reason: () => "Caret should be inside a class that has members to push down",
  },
];

/** Refactorings of the class hierarchy, run by the app-owned Java extension (`hierarchy.ts`). */
export const HIERARCHY_REFACTORINGS: ReadonlySet<RefactoringId> = new Set(["pullMembersUp", "pushMembersDown"]);

export function refactoring(id: RefactoringId): Refactoring {
  return REFACTORINGS.find((r) => r.id === id)!;
}

/** IDEA's hint text for a refactoring that cannot run. */
export function cannotPerform(reason: string): string {
  return `Cannot perform refactoring. ${reason.replace(/\.$/, "")}`;
}

const kindIs = (kind: string, prefix: string) => kind === prefix || kind.startsWith(`${prefix}.`);

/**
 * The IDEA refactoring a server code action implements, or null (e.g. "Convert
 * to arrow function"). Some servers (typescript-language-server) report every
 * refactoring as plain `refactor`, so titles decide when the kind is generic.
 */
export function classifyAction(action: Pick<CodeAction, "kind" | "title">): RefactoringId | null {
  const kind = action.kind ?? "";
  const title = action.title;
  if (!kindIs(kind, "refactor")) return null;
  const generic = kind === "refactor" || kindIs(kind, "refactor.rewrite");
  if (kindIs(kind, "refactor.extract") || (generic && /^(extract|introduce)\b/i.test(title))) {
    const sub = kind.slice("refactor.extract".length);
    const is = (re: RegExp) => re.test(sub) || re.test(title);
    if (
      /^(extract|introduce)( (in)?to)?( an?)? (type\b|typedef|interface|struct|enum|trait|superclass|module)/i.test(
        title,
      )
    )
      return null;
    if (is(/function|method/i)) return "extractMethod";
    if (is(/field|member|property/i)) return "extractField";
    if (is(/parameter|argument/i)) return "extractParameter";
    // TypeScript: "Extract to constant in enclosing scope" is a local (IDEA's Introduce Variable).
    if (/enclosing scope/i.test(title)) return "extractVariable";
    if (is(/constant|static/i)) return "extractConstant";
    if (is(/variable|local|\blet\b/i)) return "extractVariable";
    return null;
  }
  if (kindIs(kind, "refactor.inline") || (generic && /^inline\b/i.test(title))) return "inline";
  if (kindIs(kind, "refactor.move") || (generic && /^move\b/i.test(title))) return "move";
  if (/signature/i.test(kind) || /\bchange signature\b|\breorder (parameters|arguments)\b/i.test(title))
    return "changeSignature";
  return null;
}

/**
 * Whether servers advertising `advertised` (`codeActionProvider.codeActionKinds`)
 * could offer `kind`: a listed kind equal to it, a parent of it (`refactor`
 * covers `refactor.move`) or a child of it. Unknown (`null`) means maybe.
 */
export function kindAdvertised(advertised: readonly string[] | null, kind: string): boolean {
  if (!advertised) return true;
  return advertised.some((k) => k !== "" && (kindIs(kind, k) || kindIs(k, kind)));
}

/** "rust" → "Rust" when the language list is not at hand. */
export function fallbackLanguageName(id: string): string {
  const known: Record<string, string> = {
    typescript: "TypeScript",
    javascript: "JavaScript",
    typescriptreact: "TypeScript JSX",
    javascriptreact: "JavaScript JSX",
    cpp: "C++",
    csharp: "C#",
    php: "PHP",
    css: "CSS",
    html: "HTML",
    json: "JSON",
    yaml: "YAML",
    toml: "TOML",
    sql: "SQL",
  };
  return known[id] ?? (id ? id[0]!.toUpperCase() + id.slice(1) : id);
}
