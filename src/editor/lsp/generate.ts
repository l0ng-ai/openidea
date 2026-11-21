import type { CodeAction } from "@/bindings";

const GENERATE_TITLE =
  /^(generate|implement|override|declare missing methods\b|add (test for\b|methods to .+ implement\b|missing|derive|impl|getter|setter|constructor)|create (constructor|getter|setter))/i;

/** Query all actions: gopls offers source.addTest without advertising that kind. */
export function isGenerateAction(action: CodeAction): boolean {
  return action.kind === "source.addTest" || GENERATE_TITLE.test(action.title);
}

export function generateActionIcon({ kind, title }: CodeAction): string {
  if (kind === "source.addTest" || /\btests?\b/i.test(title)) return "jvm-test";
  if (/\bconstructors?\b/i.test(title)) return "symbol-constructor";
  if (/\b(getters?|setters?|accessors?)\b/i.test(title)) return "field";
  if (/^override\b/i.test(title)) return "gutter-overridden";
  if (/^implement\b/i.test(title)) return "gutter-implemented";
  return "method";
}
