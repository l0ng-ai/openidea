/** Tools › Start SSH Session…: pick an SSH configuration and run `ssh` for it in a terminal tab. */
import { openPopup, type ListPopupItem } from "@/editor/lsp/popupStore";
import { executeAction } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { sshLabel, type SshConfigValid } from "@/platform/remoteSettings";
import { workflowSettings } from "@/platform/workflowSettings";
import { notifications } from "@/workbench/contributions";

export const SSH_SETTINGS_PAGE = "tools.sshConfigurations";

/** Rows of the chooser: one per configuration, then a way to edit them. */
export function sessionItems(
  configs: readonly SshConfigValid[],
  start: (id: string) => void,
  configure: () => void,
): ListPopupItem[] {
  const items: ListPopupItem[] = configs.map((c) => {
    const label = sshLabel(c);
    return {
      id: c.id,
      label: c.name.trim() || label || c.id,
      detail: c.name.trim() && label !== c.name ? label : undefined,
      icon: "terminal",
      disabled: c.host.trim() ? null : tx("No host"),
      run: () => start(c.id),
    };
  });
  items.push({
    id: "<configure>",
    label: tx(configs.length ? "Edit SSH Configurations…" : "No SSH configurations. Add one…"),
    icon: "settings",
    run: configure,
  });
  return items;
}

export async function startSshSession(id: string) {
  try {
    const cmd = await call(commands.sshTerminalCommand(id));
    await executeAction("terminal.runCommand", { program: cmd.shell, args: cmd.args, name: cmd.title });
  } catch (e) {
    notifications().notify({
      level: "error",
      title: tx("Cannot start SSH session"),
      body: e instanceof Error ? e.message : String(e),
      group: "tools",
    });
  }
}

export function chooseSshSession() {
  const items = sessionItems(
    workflowSettings().ssh.configs,
    (id) => void startSshSession(id),
    () => void executeAction("file.settings", SSH_SETTINGS_PAGE),
  );
  openPopup({
    kind: "list",
    anchor: { x: window.innerWidth / 2 - 200, y: 96 },
    title: tx("Start SSH Session"),
    items,
  });
}
