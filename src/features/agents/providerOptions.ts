/** The New Task page's agent picker. */
import type { AgentProvider } from "@/bindings";
import type { tx as Tx } from "@/platform/i18n";
import type { SelectOption } from "@/ui";

/** Picker entry that opens Settings › Tools › Agents instead of choosing an agent. */
export const ADD_AGENT = "__addAgent__";

/**
 * Installed agents first; the rest under a "Not installed" title, with the command they
 * need; then More agents…. Registry agents show their version, or the update on offer.
 */
export function providerOptions(
  providers: readonly AgentProvider[],
  tx: typeof Tx,
  icon: (id: string) => string,
): SelectOption[] {
  const version = (p: AgentProvider) =>
    p.source.kind !== "registry" ? undefined : p.source.update ? tx`${p.source.update} available` : p.source.version;
  const installed = providers.filter((p) => p.installed);
  const missing = providers.filter((p) => !p.installed);
  return [
    ...installed.map((p) => ({ value: p.id, label: p.name, icon: icon(p.id), detail: version(p) })),
    ...(missing.length ? [{ value: "__missing__", label: tx("Not installed"), section: true }] : []),
    ...missing.map((p) => ({ value: p.id, label: p.name, icon: icon(p.id), detail: p.command })),
    { value: ADD_AGENT, label: tx("More agents…") },
  ];
}
