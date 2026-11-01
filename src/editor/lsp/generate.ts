import type { CodeAction } from "@/bindings";

const GENERATE_TITLE =
  /^(generate|implement|override|declare missing methods\b|add (test for\b|methods to .+ implement\b|missing|derive|impl|getter|setter|constructor)|create (constructor|getter|setter))/i;

/** Query all actions: gopls offers source.addTest without advertising that kind. */
export function isGenerateAction(action: CodeAction): boolean {
  return action.kind === "source.addTest" || GENERATE_TITLE.test(action.title);
}
