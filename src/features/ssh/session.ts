/** Tools › Start SSH Session…: pick an SSH configuration and open a shell on it in a terminal tab. */
import { Channel } from "@tauri-apps/api/core";
import type { TerminalInfo } from "@/bindings";
import { openPopup, type ListPopupItem } from "@/editor/lsp/popupStore";
import { executeAction } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { sshLabel, type SshConfigValid } from "@/platform/remoteSettings";
import { workflowSettings } from "@/platform/workflowSettings";
import { notifications } from "@/workbench/contributions";
import { promptInput } from "@/workbench/inputDialogs";
import { confirm } from "@/workbench/messages";

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

type SshRemedy = "trustHost" | "secret" | null;

/** What a failed connection needs from the user. */
export function sshRemedy(message: string, auth: SshConfigValid["auth"]): SshRemedy {
  if (/^Unknown SSH host key/.test(message)) return "trustHost";
  if (/^SSH (password|key passphrase) required|^cannot decrypt SSH key/.test(message)) return "secret";
  // With OpenSSH config + agent there is nothing to type unless a key is encrypted.
  if (/^SSH authentication failed/.test(message)) return auth === "openSsh" ? null : "secret";
  return null;
}

export interface ConnectDeps {
  open: (id: string, cols: number, rows: number, output: Channel<string>) => Promise<TerminalInfo>;
  confirmTrust: (message: string) => Promise<boolean>;
  askSecret: (message: string) => Promise<string | null>;
  trustHost: (id: string) => Promise<unknown>;
  setSecret: (id: string, secret: string, save: boolean) => Promise<unknown>;
}

const defaultDeps: ConnectDeps = {
  open: (id, cols, rows, output) => {
    // A channel is unusable once a failed attempt dropped it on the backend; each attempt gets its own.
    const attempt = new Channel<string>();
    attempt.onmessage = (chunk) => output.onmessage(chunk);
    return call(commands.sshOpenTerminal(id, cols, rows, attempt));
  },
  confirmTrust: (message) =>
    confirm({
      title: "Unknown SSH Host",
      icon: "warning",
      message: `${message}. ${tx("The authenticity of the host cannot be established. Trust it and add the key to ~/.ssh/known_hosts?")}`,
      ok: "Trust and Connect",
    }),
  askSecret: (message) =>
    promptInput({
      title: "SSH Authentication",
      label: message,
      secret: true,
      keepWhitespace: true,
      okLabel: tx("Connect"),
      validate: (v) => (v ? null : "Value must not be empty"),
    }),
  trustHost: (id) => call(commands.sshTrustHost(id)),
  setSecret: (id, secret, save) => commands.sshSetSecret(id, secret, save),
};

/**
 * Opens a shell on configuration `config` with the built-in client. When the
 * host key is unknown or a password / passphrase is missing or wrong, asks for
 * it and retries; other errors, and declined prompts, rethrow.
 */
export async function openSshTerminal(
  config: SshConfigValid,
  cols: number,
  rows: number,
  output: Channel<string>,
  deps: ConnectDeps = defaultDeps,
): Promise<TerminalInfo> {
  let trusted = false;
  for (let attempt = 0; ; attempt++) {
    try {
      return await deps.open(config.id, cols, rows, output);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const remedy = attempt < 4 ? sshRemedy(message, config.auth) : null;
      if (remedy === "trustHost" && !trusted) {
        if (!(await deps.confirmTrust(message))) throw e;
        await deps.trustHost(config.id);
        trusted = true;
      } else if (remedy === "secret") {
        const secret = await deps.askSecret(message);
        if (!secret) throw e;
        await deps.setSecret(config.id, secret, config.saveSecret);
      } else throw e;
    }
  }
}

export async function startSshSession(id: string) {
  const config = workflowSettings().ssh.configs.find((c) => c.id === id);
  if (!config) {
    notifications().notify({
      level: "error",
      title: tx("Cannot start SSH session"),
      body: tx("SSH configuration not found"),
      group: "tools",
    });
    return;
  }
  await executeAction("terminal.runCommand", {
    name: config.name.trim() || sshLabel(config) || config.id,
    spawn: (cols: number, rows: number, output: Channel<string>) => openSshTerminal(config, cols, rows, output),
  });
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
