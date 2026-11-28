import { tx } from "@/platform/i18n";
import { LayoutActions } from "../LayoutActions";
import { createLayoutModes, modeOf } from "../layoutModes";

/** reStructuredText editor layout per editor tab: Editor only / Editor and Preview / Preview only. */
export const rstModes = createLayoutModes("openidea.rst.defaultMode");

export function RstLayoutActions({ tabId }: { path: string; tabId: string }) {
  const mode = rstModes.useModes((s) => modeOf(s, tabId));
  return <LayoutActions tabId={tabId} mode={mode} label={tx("reStructuredText editor layout")} />;
}
