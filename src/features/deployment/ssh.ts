/** Runs remote work, offering to trust an unknown host key or asking for a password when that is what failed. */
import { call, commands, IpcError } from "@/platform/ipc";
import { workflowSettings } from "@/platform/workflowSettings";
import { confirm } from "@/workbench/messages";
import { sshRemedy } from "./model";
import { promptSecret } from "./store";

export async function withSsh<T>(ssh: string, run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- the failed attempt must finish before its error can be classified and remedied.
      return await run();
    } catch (e) {
      if (attempt >= 3 || !(e instanceof IpcError) || !ssh) throw e;
      const auth = workflowSettings().ssh.configs.find((c) => c.id === ssh)?.auth ?? "openSsh";
      const remedy = sshRemedy(e.kind, e.message, auth);
      if (remedy === "trustHostKey") {
        // oxlint-disable-next-line no-await-in-loop -- trusting a host key is an interactive prompt; the retry waits for the user's answer.
        const ok = await confirm({
          title: "Unknown Host Key",
          message: e.message,
          ok: "Trust and Connect",
          icon: "warning",
        });
        if (!ok) throw e;
        // oxlint-disable-next-line no-await-in-loop -- the key must be trusted before the operation is retried.
        await call(commands.sshTrustHost(ssh));
      } else if (remedy === "secret") {
        // oxlint-disable-next-line no-await-in-loop -- asking for a secret is interactive; the retry waits for the user's answer.
        const answer = await promptSecret(ssh, e.message);
        if (!answer) throw e;
        // oxlint-disable-next-line no-await-in-loop -- the credential must be stored before the operation is retried.
        await commands.sshSetSecret(ssh, answer.secret, answer.save);
      } else throw e;
    }
  }
}
