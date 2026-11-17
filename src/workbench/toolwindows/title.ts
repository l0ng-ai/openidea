import { tx } from "@/platform/i18n";
import type { ToolWindowContribution } from "@/workbench/contributions";

/** The window's title in the UI language; a plugin's stays as written. */
export function toolWindowTitle(tw: Pick<ToolWindowContribution, "title" | "verbatim">): string {
  return tw.verbatim ? tw.title : tx(tw.title);
}
