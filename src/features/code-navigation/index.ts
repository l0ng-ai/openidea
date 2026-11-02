/**
 * Code navigation contributed by plugins (`[[contributes.code-navigation]]`,
 * e.g. a Rails plugin's routes → controller actions, actions → views, models →
 * tables): for the files a declaration covers, the plugin answers with links
 * (text ranges that navigate) and markers (gutter icons with targets). Targets
 * are file positions or database tables (`targets.ts`).
 */
import { registerEditorContribution } from "@/editor/api";
import { codeNavigationExtension } from "./editor";
import { installNavigationProviders } from "./providers";

export function activate(): () => void {
  const disposers = [
    installNavigationProviders(),
    registerEditorContribution({ id: "code-navigation", order: 59, extensions: codeNavigationExtension }),
  ];
  return () => disposers.reverse().forEach((d) => d());
}
