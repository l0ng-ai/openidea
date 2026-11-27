import { tx } from "@/platform/i18n";
import { LayoutActions } from "../LayoutActions";
import { modeOf, useMarkdownModes } from "./modes";

export function MarkdownLayoutActions({ tabId }: { path: string; tabId: string }) {
  const mode = useMarkdownModes((s) => modeOf(s, tabId));
  return <LayoutActions tabId={tabId} mode={mode} label={tx("Markdown editor layout")} />;
}
