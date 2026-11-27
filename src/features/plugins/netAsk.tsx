/**
 * The host's own permission question (`net:ask`): a plugin with the
 * capability reached an HTTPS host its manifest does not list. One dialog,
 * one host: allow for this request, remember it, or refuse. Remembered
 * local hosts appear in the plugin's permissions, where each can be revoked.
 */
import { tx } from "@/platform/i18n";
import { ask } from "@/workbench/messages";
import { usePlugins } from "./store";

/** Resolves with the host's answer key, or null when refused. */
export async function askNetPermission(
  pluginId: string,
  host: string,
  sessionOnly: boolean,
  signal: AbortSignal,
): Promise<string[] | null> {
  if (document.visibilityState === "hidden") return null;
  const controller = new AbortController();
  const abort = () => controller.abort();
  const visibilityChanged = () => {
    if (document.visibilityState === "hidden") controller.abort();
  };
  signal.addEventListener("abort", abort);
  document.addEventListener("visibilitychange", visibilityChanged);
  if (signal.aborted) controller.abort();
  const name = usePlugins.getState().plugins.find((p) => p.id === pluginId)?.name ?? pluginId;
  try {
    const r = await ask({
      title: tx`Allow ${name} to connect to ${host}?`,
      body: [
        tx("The host is not in the plugin's declared permissions."),
        " ",
        tx("This allows this exact host on any port; subdomains need separate permission."),
        " ",
        sessionOnly
          ? tx`This allows ${host} until the remote session ends.`
          : tx`"Always allow" remembers ${host}; revoke it any time in the plugin's permissions.`,
      ],
      buttons: sessionOnly
        ? [
            { id: "session", label: tx("Allow for this session") },
            { id: "deny", label: tx("Deny"), primary: true },
          ]
        : [
            { id: "once", label: tx("Allow once") },
            { id: "always", label: tx("Always allow") },
            { id: "deny", label: tx("Deny"), primary: true },
          ],
      cancel: false,
      icon: "question",
      signal: controller.signal,
    });
    return r.button === "session" || r.button === "once" || r.button === "always" ? [r.button] : null;
  } finally {
    signal.removeEventListener("abort", abort);
    document.removeEventListener("visibilitychange", visibilityChanged);
  }
}
