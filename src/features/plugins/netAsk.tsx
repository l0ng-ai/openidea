/**
 * The host's own permission question (`net:ask`): a plugin with the
 * capability reached an HTTPS host its manifest does not list. One dialog,
 * one host: allow for this request, remember it, or refuse. Remembered
 * hosts appear in the plugin's permissions, where each can be revoked.
 */
import { tx } from "@/platform/i18n";
import { ask } from "@/workbench/messages";
import { usePlugins } from "./store";

/** Asks about `host`; resolves with the answer keys the host understands (`once` allows one request, `always` remembers the host), or null when refused. */
export async function askNetPermission(pluginId: string, host: string, signal: AbortSignal): Promise<string[] | null> {
  const name = usePlugins.getState().plugins.find((p) => p.id === pluginId)?.name ?? pluginId;
  const r = await ask({
    title: tx`Allow ${name} to connect to ${host}?`,
    body: [
      tx("The host is not in the plugin's declared permissions."),
      " ",
      tx`"Always allow" remembers ${host}; revoke it any time in the plugin's permissions.`,
    ],
    buttons: [
      { id: "once", label: tx("Allow once"), primary: true },
      { id: "always", label: tx("Always allow") },
      { id: "deny", label: tx("Deny") },
    ],
    cancel: false,
    icon: "question",
    signal,
  });
  return r.button === "once" || r.button === "always" ? [r.button] : null;
}
