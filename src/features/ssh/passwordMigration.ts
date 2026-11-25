import type { LegacyPasswordAction } from "@/bindings";
import { tx } from "@/platform/i18n";
import { call, commands, isTauri } from "@/platform/ipc";
import { notifications } from "@/workbench/contributions";
import { confirm } from "@/workbench/messages";

export function startPasswordMigrationNotice(): () => void {
  let disposed = false;
  const key = "ssh.legacyPasswords";
  async function resolve(action: LegacyPasswordAction) {
    if (
      action === "removePlaintext" &&
      !(await confirm({
        title: tx("Remove plaintext copy"),
        message: tx("Passwords and passphrases not yet in the credential store will need to be entered again."),
        ok: tx("Remove plaintext copy"),
        icon: "warning",
      }))
    )
      return;
    if (disposed) return;
    const retry = { label: tx("Retry migration"), run: () => void resolve("retry") };
    try {
      const pending = await call(commands.sshLegacyPasswords(action));
      if (disposed) return;
      if (pending !== null) {
        notifications().notify({
          key,
          level: "warning",
          sticky: true,
          title: tx("Saved credentials are still in plaintext"),
          body: `${tx("Unlock the OS credential store and retry, or remove the plaintext copy in ssh-passwords.json.")} ${tx(pending)}`,
          actions: [retry, { label: tx("Remove plaintext copy"), run: () => void resolve("removePlaintext") }],
        });
      } else if (action !== "check") {
        notifications().notify({
          key,
          level: "info",
          title: tx("No legacy plaintext credentials remain in ssh-passwords.json"),
        });
      }
    } catch (e) {
      if (!disposed)
        notifications().notify({
          key,
          level: "error",
          title: tx("Could not check or update ssh-passwords.json"),
          body: e instanceof Error ? e.message : String(e),
          actions: [retry],
        });
    }
  }
  if (isTauri()) void resolve("check");
  return () => {
    disposed = true;
  };
}
