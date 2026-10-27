/** Runs remote work, offering to trust an unknown host key or asking for a password when that is what failed. */
import { call, commands, IpcError } from "@/platform/ipc";
import { workflowSettings } from "@/platform/workflowSettings";
import { confirm } from "@/workbench/messages";
import { sshRemedy } from "./model";
import { promptSecret } from "./store";

export async function withSsh<T>(ssh: string, run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (e) {
      if (attempt >= 3 || !(e instanceof IpcError) || !ssh) throw e;
      const auth = workflowSettings().ssh.configs.find((c) => c.id === ssh)?.auth ?? "openSsh";
      const remedy = sshRemedy(e.kind, e.message, auth);
      if (remedy === "trustHostKey") {
        const ok = await confirm({
          title: "Unknown Host Key",
          message: e.message,
          ok: "Trust and Connect",
          icon: "warning",
        });
        if (!ok) throw e;
        await call(commands.sshTrustHost(ssh));
      } else if (remedy === "secret") {
        const answer = await promptSecret(ssh, e.message);
        if (!answer) throw e;
        await commands.sshSetSecret(ssh, answer.secret, answer.save);
      } else throw e;
    }
  }
}
